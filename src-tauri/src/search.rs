#[cfg(all(target_os = "windows", not(test)))]
use std::collections::HashMap;
#[cfg(all(target_os = "windows", not(test)))]
use std::sync::OnceLock;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, LazyLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(all(target_os = "windows", not(test)))]
use windows_sys::Win32::System::Threading::{
    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL, THREAD_PRIORITY_NORMAL,
};

use parking_lot::Mutex;
use pinyin::ToPinyin;
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
#[cfg(all(target_os = "windows", not(test)))]
use walkdir::{DirEntry, WalkDir};

use crate::storage::StorageManager;

struct IndexState {
    status: u8,
    running: bool,
    pending: Option<(Vec<String>, u64)>,
    phase: u8,
    indexed_items: usize,
    completed_roots: usize,
    total_roots: usize,
    current_root: Option<String>,
    fallback_reason: Option<String>,
}

static INDEX_STATE: Mutex<IndexState> = Mutex::new(IndexState {
    status: 0,
    running: false,
    pending: None,
    phase: 0,
    indexed_items: 0,
    completed_roots: 0,
    total_roots: 0,
    current_root: None,
    fallback_reason: None,
});
static INDEX_REVISION: AtomicU64 = AtomicU64::new(0);
static QUERY_REVISION: AtomicU64 = AtomicU64::new(0);
#[cfg(all(target_os = "windows", not(test)))]
static WATCH_REVISION: AtomicU64 = AtomicU64::new(0);
#[cfg(all(target_os = "windows", not(test)))]
static WATCH_OVERFLOW_REBUILD_QUEUED: LazyLock<Mutex<HashMap<u64, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_QUERY_AT_MS: AtomicU64 = AtomicU64::new(0);
static QUERY_GATE: Mutex<()> = Mutex::new(());
static INDEX_DIRTY_PATHS: LazyLock<Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static LIVE_RESULT_CACHE: Mutex<LiveResultCache> = Mutex::new(LiveResultCache {
    scope: String::new(),
    refreshed_at: None,
    results: Vec::new(),
});
#[cfg(all(target_os = "windows", not(test)))]
static REGISTERED_APPS: OnceLock<Vec<RegisteredApp>> = OnceLock::new();

const INDEXED_NAME_SEPARATOR: char = '\u{1f}';
const RESULT_LIMIT: usize = 120;
const CANDIDATE_LIMIT: usize = 320;
const LIVE_RESULT_CACHE_TTL: Duration = Duration::from_secs(2);
const LIVE_RESULT_CACHE_LIMIT: usize = 8_192;
const MAX_PINYIN_ALIAS_CHARS: usize = 160;
const MAX_FUZZY_ALIAS_TOKENS: usize = 48;
const MAX_FILE_FUZZY_ALIAS_TOKENS: usize = 24;
const MAX_CJK_BIGRAM_TOKENS: usize = 256;
const INDEX_ENTRY_CHUNK: usize = 8_192;
#[cfg(all(target_os = "windows", not(test)))]
const WATCH_REFRESH_BATCH_SIZE: usize = 512;
#[cfg(not(test))]
const INTERACTIVE_QUERY_GRACE_MS: u64 = 2_500;

pub(crate) fn index_pause_millis(work_millis: u64, interactive_query: bool) -> u64 {
    if interactive_query {
        (work_millis / 4).clamp(2, 12)
    } else {
        0
    }
}

struct LiveResultCache {
    scope: String,
    refreshed_at: Option<Instant>,
    results: Vec<SearchResult>,
}

#[cfg(all(target_os = "windows", not(test)))]
struct BackgroundIndexPriority(bool);

#[cfg(all(target_os = "windows", not(test)))]
impl BackgroundIndexPriority {
    fn begin() -> Self {
        let changed =
            unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) } != 0;
        Self(changed)
    }
}

#[cfg(all(target_os = "windows", not(test)))]
impl Drop for BackgroundIndexPriority {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
            }
        }
    }
}

#[cfg(any(not(target_os = "windows"), test))]
struct BackgroundIndexPriority;

#[cfg(any(not(target_os = "windows"), test))]
impl BackgroundIndexPriority {
    fn begin() -> Self {
        Self
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(not(test))]
struct IndexThrottle {
    enabled: bool,
    work_started: Instant,
}

#[cfg(not(test))]
impl IndexThrottle {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            work_started: Instant::now(),
        }
    }

    fn pause(&mut self) {
        std::thread::yield_now();
        if !self.enabled {
            self.work_started = Instant::now();
            return;
        }
        let work_time = self.work_started.elapsed();
        let since_query = epoch_millis().saturating_sub(LAST_QUERY_AT_MS.load(Ordering::Acquire));
        let pause_ms = index_pause_millis(
            work_time.as_millis() as u64,
            since_query < INTERACTIVE_QUERY_GRACE_MS,
        );
        if pause_ms > 0 {
            std::thread::sleep(Duration::from_millis(pause_ms));
        }
        self.work_started = Instant::now();
    }
}

#[cfg(test)]
struct IndexThrottle;

#[cfg(test)]
impl IndexThrottle {
    fn new(_enabled: bool) -> Self {
        Self
    }

    fn pause(&mut self) {}
}

fn yield_indexer_to_interactive_work(throttle: &mut IndexThrottle) {
    throttle.pause();
}

fn update_index_progress(
    phase: u8,
    indexed_items: usize,
    completed_roots: usize,
    total_roots: usize,
    current_root: Option<String>,
) {
    let mut state = INDEX_STATE.lock();
    state.phase = phase;
    state.indexed_items = indexed_items;
    state.completed_roots = completed_roots;
    state.total_roots = total_roots;
    state.current_root = current_root;
}

fn set_fast_index_fallback_reason(reason: Option<String>) {
    INDEX_STATE.lock().fallback_reason = reason;
}

const SYNONYM_GROUPS: &[&[&str]] = &[
    &["browser", "浏览器", "网页", "web"],
    &["music", "音乐", "歌曲", "song"],
    &["video", "视频", "影片", "movie"],
    &["image", "图片", "照片", "photo", "picture"],
    &["document", "文档", "文件", "doc"],
    &["download", "下载"],
    &["settings", "setting", "设置", "配置"],
    &["terminal", "终端", "命令行", "cmd", "powershell"],
    &["mail", "email", "邮件", "邮箱"],
    &["chat", "聊天", "消息", "message"],
    &["folder", "文件夹", "目录", "directory"],
    &["editor", "编辑器", "代码", "code"],
    &["calendar", "日历", "日程"],
    &["cloud", "云盘", "网盘"],
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub status: String,
    pub phase: String,
    pub indexed_items: usize,
    pub completed_roots: usize,
    pub total_roots: usize,
    pub current_root: Option<String>,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredApp {
    pub name: String,
    pub path: String,
}

#[derive(Deserialize)]
struct WindowsStartApp {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "AppID")]
    app_id: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WindowsStartApps {
    Many(Vec<WindowsStartApp>),
    One(WindowsStartApp),
}

pub fn registered_apps_from_json(json: &str) -> Vec<RegisteredApp> {
    let apps = match serde_json::from_str::<WindowsStartApps>(json) {
        Ok(WindowsStartApps::Many(apps)) => apps,
        Ok(WindowsStartApps::One(app)) => vec![app],
        Err(_) => Vec::new(),
    };
    apps.into_iter()
        .filter_map(|app| {
            let name = app.name.trim().to_string();
            let app_id = app.app_id.trim().to_string();
            if name.is_empty() || app_id.is_empty() {
                return None;
            }
            let path = if app_id.starts_with("http://")
                || app_id.starts_with("https://")
                || Path::new(&app_id).is_absolute()
            {
                app_id
            } else {
                format!(r"shell:AppsFolder\{app_id}")
            };
            Some(RegisteredApp { name, path })
        })
        .collect()
}

#[cfg(all(target_os = "windows", not(test)))]
fn registered_apps() -> &'static [RegisteredApp] {
    REGISTERED_APPS
        .get_or_init(|| {
            let script = concat!(
                "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();",
                "@(Get-StartApps | Select-Object Name,AppID) | ConvertTo-Json -Compress"
            );
            crate::background_command("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .map(|json| registered_apps_from_json(&json))
                .unwrap_or_default()
        })
        .as_slice()
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn registered_apps() -> &'static [RegisteredApp] {
    &[]
}

#[cfg(test)]
fn registered_apps() -> &'static [RegisteredApp] {
    &[]
}

fn normalized_search_value(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn pinyin_aliases(value: &str) -> Vec<String> {
    if value.is_ascii() {
        return Vec::new();
    }
    let mut full = String::new();
    let mut initials = String::new();
    let mut has_pinyin = false;
    for character in value.chars() {
        if let Some(pinyin) = character.to_pinyin() {
            full.push_str(pinyin.plain());
            initials.push_str(pinyin.first_letter());
            has_pinyin = true;
        } else if character.is_alphanumeric() {
            full.extend(character.to_lowercase());
            initials.extend(character.to_lowercase());
        }
    }
    if !has_pinyin {
        return Vec::new();
    }
    let mut aliases = vec![full.clone(), initials];
    // The pinyin crate resolves characters independently. Keep a small set of
    // high-value phrase pronunciations so common product names remain natural
    // to type (for example, 音乐 is yin-yue rather than yin-le).
    if value.contains("音乐") && full.contains("yinle") {
        aliases.push(full.replace("yinle", "yinyue"));
    }
    aliases.retain(|alias| !alias.is_empty());
    aliases
}

fn expanded_search_terms(query: &str) -> Vec<String> {
    let normalized = query.trim().to_lowercase();
    let compact = normalized_search_value(&normalized);
    let mut terms = vec![normalized];
    if !compact.is_empty() && compact != terms[0] {
        terms.push(compact.clone());
    }
    for group in SYNONYM_GROUPS {
        if group
            .iter()
            .any(|term| normalized_search_value(term) == compact)
        {
            terms.extend(group.iter().map(|term| (*term).to_string()));
        }
    }
    let mut seen = HashSet::new();
    terms.retain(|term| !term.is_empty() && seen.insert(term.clone()));
    terms
}

fn encode_indexed_name(name: &str, kind: &str) -> String {
    let mut aliases = pinyin_aliases(name)
        .into_iter()
        .map(|alias| {
            alias
                .chars()
                .take(MAX_PINYIN_ALIAS_CHARS)
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    // SQLite's trigram tokenizer cannot retrieve a two-character CJK query
    // directly. Keep those exact CJK bigrams ahead of the bounded fuzzy
    // aliases so a phrase near the end of a long filename is never discarded.
    aliases.extend(
        cjk_bigram_tokens(name)
            .into_iter()
            .take(MAX_CJK_BIGRAM_TOKENS),
    );
    let mut fuzzy_sources = vec![name.to_string()];
    if matches!(kind, "app" | "folder") {
        fuzzy_sources.extend(aliases.iter().cloned());
    }
    aliases.extend(
        fuzzy_sources
            .into_iter()
            .flat_map(|source| fuzzy_bigram_tokens(&source))
            .take(if kind == "file" {
                file_fuzzy_alias_limit(name)
            } else {
                MAX_FUZZY_ALIAS_TOKENS
            }),
    );
    let mut seen_aliases = HashSet::new();
    aliases.retain(|alias| seen_aliases.insert(alias.clone()));
    if aliases.is_empty() {
        name.to_string()
    } else {
        format!("{name}{INDEXED_NAME_SEPARATOR}{}", aliases.join("\u{1f}"))
    }
}

fn file_fuzzy_alias_limit(name: &str) -> usize {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if [
        "txt", "md", "rtf", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "epub",
    ]
    .iter()
    .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    {
        MAX_FILE_FUZZY_ALIAS_TOKENS
    } else {
        0
    }
}

fn is_cjk(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4dbf}'
            | '\u{4e00}'..='\u{9fff}'
            | '\u{f900}'..='\u{faff}'
    )
}

fn cjk_bigram_tokens(value: &str) -> Vec<String> {
    normalized_search_value(value)
        .chars()
        .collect::<Vec<_>>()
        .windows(2)
        .filter(|window| is_cjk(window[0]) && is_cjk(window[1]))
        .map(|window| format!("~{}{}", window[0], window[1]))
        .collect()
}

fn fuzzy_bigram_tokens(value: &str) -> Vec<String> {
    normalized_search_value(value)
        .chars()
        .collect::<Vec<_>>()
        .windows(2)
        .map(|window| format!("~{}", window.iter().collect::<String>()))
        .collect()
}

fn split_indexed_name(indexed_name: &str) -> (&str, Vec<&str>) {
    let mut parts = indexed_name.split(INDEXED_NAME_SEPARATOR);
    let display_name = parts.next().unwrap_or(indexed_name);
    (display_name, parts.collect())
}

fn indexed_display_name(indexed_name: &str) -> &str {
    indexed_name
        .split_once(INDEXED_NAME_SEPARATOR)
        .map_or(indexed_name, |(display_name, _)| display_name)
}

fn damerau_levenshtein(left: &str, right: &str) -> usize {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }
    let mut previous_previous = vec![0usize; right.len() + 1];
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0usize; right.len() + 1];
    for left_index in 1..=left.len() {
        current[0] = left_index;
        for right_index in 1..=right.len() {
            let substitution = usize::from(left[left_index - 1] != right[right_index - 1]);
            current[right_index] = (previous[right_index] + 1)
                .min(current[right_index - 1] + 1)
                .min(previous[right_index - 1] + substitution);
            if left_index > 1
                && right_index > 1
                && left[left_index - 1] == right[right_index - 2]
                && left[left_index - 2] == right[right_index - 1]
            {
                current[right_index] =
                    current[right_index].min(previous_previous[right_index - 2] + 1);
            }
        }
        std::mem::swap(&mut previous_previous, &mut previous);
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

fn fuzzy_distance_allowed(query: &str) -> usize {
    match query.chars().count() {
        0..=3 => 0,
        4..=7 => 1,
        8..=13 => 2,
        length => (length / 6).max(2),
    }
}

fn searchable_values<'a>(name: &'a str, path: &'a str) -> Vec<String> {
    let (display_name, aliases) = split_indexed_name(name);
    let display_stem = Path::new(display_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(display_name);
    let mut values = vec![
        normalized_search_value(display_name),
        normalized_search_value(display_stem),
        normalized_search_value(path),
    ];
    values.extend(aliases.into_iter().map(normalized_search_value));
    values.extend(
        pinyin_aliases(display_name)
            .into_iter()
            .map(|alias| normalized_search_value(&alias)),
    );
    values
}

fn match_quality(name: &str, path: &str, terms: &[String]) -> Option<(usize, usize)> {
    let values = searchable_values(name, path);
    let mut best: Option<(usize, usize)> = None;
    for term in terms {
        let needle = normalized_search_value(term);
        if needle.is_empty() {
            continue;
        }
        for (value_index, value) in values.iter().enumerate() {
            let quality = if value == &needle {
                (0, 0)
            } else if value.starts_with(&needle) {
                (1, value.len().saturating_sub(needle.len()))
            } else if value.contains(&needle) {
                (2, value.len().saturating_sub(needle.len()))
            } else {
                // The normalized path is useful for substring matching, but
                // comparing an entire long path with edit distance is both
                // noisy and needlessly expensive.
                if value_index == 2 {
                    continue;
                }
                let allowed = fuzzy_distance_allowed(&needle);
                if allowed == 0 {
                    continue;
                }
                let leaf = value
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or(value)
                    .split('.')
                    .next()
                    .unwrap_or(value);
                if needle.chars().count().abs_diff(leaf.chars().count()) > allowed {
                    continue;
                }
                let distance = damerau_levenshtein(&needle, leaf);
                if distance > allowed {
                    continue;
                }
                (3, distance)
            };
            best = Some(best.map_or(quality, |current| current.min(quality)));
        }
    }
    best
}

fn quote_fts_term(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

fn fts_candidate_expression(terms: &[String]) -> Option<String> {
    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    for term in terms {
        let raw = term.trim().to_lowercase();
        let compact = normalized_search_value(term);
        for candidate in [raw, compact] {
            let characters = candidate.chars().collect::<Vec<_>>();
            if characters.len() < 2 {
                continue;
            }
            for window in characters.windows(2) {
                let bigram = format!("~{}", window.iter().collect::<String>());
                if seen.insert(bigram.clone()) {
                    tokens.push(quote_fts_term(&bigram));
                }
            }
            if characters.len() < 3 {
                continue;
            }
            if seen.insert(candidate.clone()) {
                tokens.push(quote_fts_term(&candidate));
            }
            for window in characters.windows(3) {
                let trigram = window.iter().collect::<String>();
                if seen.insert(trigram.clone()) {
                    tokens.push(quote_fts_term(&trigram));
                }
            }
        }
    }
    (!tokens.is_empty()).then(|| tokens.join(" OR "))
}

fn fts_exact_expression(terms: &[String]) -> Option<String> {
    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    for term in terms {
        for candidate in [term.trim().to_lowercase(), normalized_search_value(term)] {
            let character_count = candidate.chars().count();
            if character_count < 2 || !seen.insert(candidate.clone()) {
                continue;
            }
            tokens.push(if character_count == 2 {
                quote_fts_term(&format!("~{candidate}"))
            } else {
                quote_fts_term(&candidate)
            });
        }
    }
    (!tokens.is_empty()).then(|| tokens.join(" OR "))
}

pub fn registered_app_results(
    apps: &[RegisteredApp],
    query: &str,
    kind: &str,
    extension: &str,
    drive: &str,
    roots: &[String],
) -> Vec<SearchResult> {
    if (!kind.trim().is_empty() && kind != "app") || !extension.trim().is_empty() {
        return Vec::new();
    }
    let normalized = query.trim().to_lowercase();
    let terms = expanded_search_terms(&normalized);
    let normalized_drive = drive.trim().to_lowercase();
    let mut results = apps
        .iter()
        .enumerate()
        .filter(|(_, app)| {
            !normalized.is_empty()
                && match_quality(&app.name, &app.path, &terms).is_some()
                && (normalized_drive.is_empty()
                    || app.path.to_lowercase().starts_with(&normalized_drive))
                && path_matches_roots(Path::new(&app.path), roots)
                && !is_noisy_app_name(&app.name)
                && !is_noisy_application(Path::new(&app.path))
        })
        .map(|(index, app)| SearchResult {
            id: format!("registered-app-{index}"),
            name: app.name.clone(),
            path: app.path.clone(),
            kind: "app".into(),
            modified_at: None,
        })
        .collect::<Vec<_>>();
    results.sort_by_key(|result| {
        let name = result.name.to_lowercase();
        let quality =
            match_quality(&result.name, &result.path, &terms).unwrap_or((usize::MAX, usize::MAX));
        (
            quality,
            usize::from(name != normalized),
            usize::from(!name.starts_with(&normalized)),
            name.len(),
            name,
        )
    });
    results
}

pub fn include_application_roots(requested_roots: &[String]) -> bool {
    requested_roots.is_empty() || requested_roots.iter().any(|root| root == "*")
}

#[cfg(not(test))]
fn live_user_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default();
    ["Desktop", "Documents", "Downloads"]
        .into_iter()
        .map(|folder| home.join(folder))
        .filter(|root| root.is_dir())
        .collect()
}

fn immediate_live_results(
    query: &str,
    kind: &str,
    extension: &str,
    drive: &str,
    requested_roots: &[String],
) -> Vec<SearchResult> {
    let scope = if include_application_roots(requested_roots) {
        "*".to_string()
    } else {
        requested_roots.join("\u{1f}")
    };
    let now = Instant::now();
    let cached = {
        let cache = LIVE_RESULT_CACHE.lock();
        (cache.scope == scope
            && cache
                .refreshed_at
                .is_some_and(|refreshed| now.duration_since(refreshed) < LIVE_RESULT_CACHE_TTL))
        .then(|| cache.results.clone())
    };
    let live_results = cached.unwrap_or_else(|| {
        let roots = if include_application_roots(requested_roots) {
            #[cfg(test)]
            {
                Vec::new()
            }
            #[cfg(not(test))]
            {
                live_user_roots()
            }
        } else {
            requested_roots.iter().map(PathBuf::from).collect()
        };
        let mut seen = HashSet::new();
        let mut results = Vec::new();
        for root in roots {
            let candidates = std::iter::once((root.clone(), true)).chain(
                fs::read_dir(&root)
                    .into_iter()
                    .flatten()
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        entry
                            .file_type()
                            .ok()
                            .map(|file_type| (entry.path(), file_type.is_dir()))
                    }),
            );
            for (path, is_dir) in
                candidates.take(LIVE_RESULT_CACHE_LIMIT.saturating_sub(results.len()))
            {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                if name.is_empty()
                    || matches!(
                        name.to_lowercase().as_str(),
                        "$recycle.bin" | "system volume information"
                    )
                {
                    continue;
                }
                let display = display_path(&path);
                let path_key = if cfg!(target_os = "windows") {
                    display.to_lowercase()
                } else {
                    display.clone()
                };
                if !seen.insert(path_key) || !path_matches_roots(&path, requested_roots) {
                    continue;
                }
                let result_kind = kind_for_path(&path, is_dir);
                if result_kind == "app" && is_noisy_application(&path) {
                    continue;
                }
                results.push(SearchResult {
                    id: format!("live-{result_kind}-{}", results.len()),
                    name,
                    path: display,
                    kind: result_kind.into(),
                    modified_at: None,
                });
            }
            if results.len() >= LIVE_RESULT_CACHE_LIMIT {
                break;
            }
        }
        let mut cache = LIVE_RESULT_CACHE.lock();
        cache.scope = scope;
        cache.refreshed_at = Some(now);
        cache.results = results.clone();
        results
    });
    let terms = expanded_search_terms(query);
    let normalized_drive = drive.trim().to_lowercase();
    let normalized_extension = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let mut matches = live_results
        .into_iter()
        .filter(|result| {
            (kind.trim().is_empty() || result.kind == kind)
                && (normalized_drive.is_empty()
                    || result.path.to_lowercase().starts_with(&normalized_drive))
                && (normalized_extension.is_empty()
                    || (result.kind == "file"
                        && Path::new(&result.path)
                            .extension()
                            .and_then(|value| value.to_str())
                            .is_some_and(|value| {
                                value.eq_ignore_ascii_case(&normalized_extension)
                            })))
        })
        .filter_map(|result| {
            let quality = match_quality(&result.name, &result.path, &terms)?;
            Some((quality, result))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|(left_quality, left), (right_quality, right)| {
        (
            left_quality,
            left.name.chars().count(),
            left.name.to_lowercase(),
        )
            .cmp(&(
                right_quality,
                right.name.chars().count(),
                right.name.to_lowercase(),
            ))
    });
    matches
        .into_iter()
        .take(RESULT_LIMIT)
        .map(|(_, result)| result)
        .collect()
}

fn normalized_scope_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

pub(crate) fn is_index_internal_path(data_dir: &Path, path: &Path) -> bool {
    path_starts_with(path, data_dir)
}

fn path_starts_with(path: &Path, root: &Path) -> bool {
    let root = normalized_scope_path(root);
    let candidate = normalized_scope_path(path);
    !root.is_empty() && (candidate == root || candidate.starts_with(&format!("{root}\\")))
}

pub fn path_matches_roots(path: &Path, roots: &[String]) -> bool {
    if include_application_roots(roots) {
        return true;
    }
    let candidate = normalized_scope_path(path);
    roots.iter().any(|root| {
        let normalized_root = normalized_scope_path(Path::new(root));
        !normalized_root.is_empty()
            && (candidate == normalized_root
                || candidate.starts_with(&format!("{normalized_root}\\")))
    })
}

#[cfg(all(target_os = "windows", not(test)))]
fn should_descend(entry: &DirEntry) -> bool {
    should_descend_path(entry.path(), entry.file_type().is_dir())
}

fn kind_for_path(path: &Path, is_dir: bool) -> &'static str {
    if is_dir {
        "folder"
    } else if matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "exe" | "lnk" | "appref-ms"
    ) {
        "app"
    } else {
        "file"
    }
}

fn reconcile_path_in_table(
    transaction: &Transaction<'_>,
    table: &str,
    path: &Path,
) -> Result<(), String> {
    let display = display_path(path);
    let metadata = path.metadata().ok();
    let is_dir = metadata.as_ref().is_some_and(|value| value.is_dir());
    let exists = metadata.is_some();
    let child_prefix = format!(
        "{}{}",
        display.trim_end_matches(['\\', '/']),
        std::path::MAIN_SEPARATOR
    );
    if exists {
        transaction
            .execute(&format!("DELETE FROM {table} WHERE path = ?1"), [&display])
            .map_err(|error| error.to_string())?;
    } else {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2"),
                params![display, child_prefix],
            )
            .map_err(|error| error.to_string())?;
    }
    if exists {
        let kind = kind_for_path(path, is_dir);
        if !(kind == "app" && is_noisy_application(path)) {
            let name = if kind == "app" {
                application_display_name(path)
            } else {
                path.file_name()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_else(|| display.clone())
            };
            if !name.is_empty() {
                let indexed = encode_indexed_name(&name, kind);
                transaction
                    .execute(
                        &format!(
                            "INSERT INTO {table}(name, path, kind, modified_at) VALUES (?1, ?2, ?3, NULL)"
                        ),
                        params![indexed, display, kind],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn reconcile_dirty_paths(
    transaction: &Transaction<'_>,
    paths: impl IntoIterator<Item = PathBuf>,
) -> Result<(), String> {
    for path in paths {
        reconcile_path_in_table(transaction, "search_fts_next", &path)?;
    }
    Ok(())
}

fn refresh_paths(storage: &StorageManager, paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    // Dirty registration and the staging write must stay on the same side of
    // the rebuild initialization barrier. Then any watcher/scanner overlap is
    // guaranteed to be reconciled before the staging table is published.
    let _writer = storage.index_write_guard();
    if INDEX_STATE.lock().running {
        INDEX_DIRTY_PATHS.lock().extend(paths.iter().cloned());
    }
    let mut connection =
        Connection::open(storage.search_database_path()).map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let next_exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_fts_next')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    for path in paths {
        reconcile_path_in_table(&transaction, "search_fts", path)?;
        if next_exists {
            reconcile_path_in_table(&transaction, "search_fts_next", path)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO search_build_dirty_paths(path) VALUES (?1)",
                    [display_path(path)],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(test)]
pub fn refresh_path(storage: &StorageManager, path: &Path) -> Result<(), String> {
    refresh_paths(storage, &[path.to_path_buf()])
}

#[cfg(all(target_os = "windows", not(test)))]
fn queue_overflow_validation(
    storage: Arc<StorageManager>,
    watcher_scope: Vec<String>,
    watcher_revision: u64,
) {
    {
        let mut queued = WATCH_OVERFLOW_REBUILD_QUEUED.lock();
        let requests = queued.entry(watcher_revision).or_default();
        *requests = requests.saturating_add(1);
        if *requests > 1 {
            return;
        }
    }
    std::thread::spawn(move || {
        // Keep coalescing overflows until a complete validation finishes
        // without another overflow. Stopping after a fixed number of passes
        // can publish a stale index when an overflow occurs behind the final
        // scan cursor.
        loop {
            while WATCH_REVISION.load(Ordering::Acquire) == watcher_revision
                && status() == "indexing"
            {
                std::thread::sleep(Duration::from_millis(250));
            }
            if WATCH_REVISION.load(Ordering::Acquire) != watcher_revision {
                break;
            }
            let observed_requests = WATCH_OVERFLOW_REBUILD_QUEUED
                .lock()
                .get(&watcher_revision)
                .copied()
                .unwrap_or_default();
            let _ = rebuild(&storage, watcher_scope.clone());
            let mut queued = WATCH_OVERFLOW_REBUILD_QUEUED.lock();
            let latest_requests = queued.get(&watcher_revision).copied().unwrap_or_default();
            if latest_requests == observed_requests {
                queued.remove(&watcher_revision);
                return;
            }
        }
    });
}

#[cfg(all(target_os = "windows", not(test)))]
pub fn start_watchers(storage: Arc<StorageManager>, requested_roots: Vec<String>) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_IO_PENDING, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
            WAIT_TIMEOUT,
        },
        Storage::FileSystem::{
            CreateFileW, ReadDirectoryChangesW, FILE_ACTION_ADDED, FILE_ACTION_RENAMED_NEW_NAME,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY,
            FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
            FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_NOTIFY_INFORMATION,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::{
            Threading::{CreateEventW, ResetEvent, WaitForSingleObject},
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        },
    };

    let revision = WATCH_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    let watcher_scope = if requested_roots.is_empty() {
        vec!["*".to_string()]
    } else {
        requested_roots.clone()
    };
    let roots = if requested_roots.is_empty() || requested_roots.iter().any(|root| root == "*") {
        default_roots()
    } else {
        requested_roots.into_iter().map(PathBuf::from).collect()
    };
    for root in distinct_roots(roots) {
        let storage = storage.clone();
        let watcher_scope = watcher_scope.clone();
        std::thread::spawn(move || {
            let data_dir = storage.data_dir();
            let mut wide = root.as_os_str().encode_wide().collect::<Vec<_>>();
            wide.push(0);
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    FILE_LIST_DIRECTORY,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return;
            }
            let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if event.is_null() {
                unsafe {
                    CloseHandle(handle);
                }
                return;
            }
            let mut buffer = vec![0u8; 256 * 1024];
            'watch: while WATCH_REVISION.load(Ordering::Acquire) == revision {
                let mut returned = 0u32;
                let mut overlapped = unsafe { std::mem::zeroed::<OVERLAPPED>() };
                overlapped.hEvent = event;
                unsafe {
                    ResetEvent(event);
                }
                let ok = unsafe {
                    ReadDirectoryChangesW(
                        handle,
                        buffer.as_mut_ptr().cast(),
                        buffer.len() as u32,
                        1,
                        FILE_NOTIFY_CHANGE_FILE_NAME
                            | FILE_NOTIFY_CHANGE_DIR_NAME
                            | FILE_NOTIFY_CHANGE_SIZE
                            | FILE_NOTIFY_CHANGE_LAST_WRITE
                            | FILE_NOTIFY_CHANGE_CREATION,
                        std::ptr::null_mut(),
                        &mut overlapped,
                        None,
                    )
                };
                if ok == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
                    break;
                }
                loop {
                    match unsafe { WaitForSingleObject(event, 500) } {
                        WAIT_OBJECT_0 => {
                            if unsafe { GetOverlappedResult(handle, &overlapped, &mut returned, 0) }
                                == 0
                            {
                                break 'watch;
                            }
                            break;
                        }
                        WAIT_TIMEOUT => {
                            if WATCH_REVISION.load(Ordering::Acquire) != revision {
                                unsafe {
                                    CancelIoEx(handle, &overlapped);
                                    GetOverlappedResult(handle, &overlapped, &mut returned, 1);
                                }
                                break 'watch;
                            }
                        }
                        _ => break 'watch,
                    }
                }
                if returned == 0 {
                    // A zero-byte completion means notifications overflowed.
                    // Coalesce every overflow observed during the active scan
                    // into one validation pass. The watcher keeps consuming
                    // notifications instead of synchronously blocking on a
                    // second full scan or starting an endless rebuild loop.
                    queue_overflow_validation(storage.clone(), watcher_scope.clone(), revision);
                    continue;
                }
                let mut offset = 0usize;
                let mut changed_paths = HashMap::new();
                while offset < returned as usize {
                    let info = unsafe {
                        &*(buffer
                            .as_ptr()
                            .add(offset)
                            .cast::<FILE_NOTIFY_INFORMATION>())
                    };
                    let name = unsafe {
                        std::slice::from_raw_parts(
                            info.FileName.as_ptr(),
                            info.FileNameLength as usize / 2,
                        )
                    };
                    let relative = String::from_utf16_lossy(name);
                    changed_paths.insert(root.join(relative), info.Action);
                    if info.NextEntryOffset == 0 {
                        break;
                    }
                    offset += info.NextEntryOffset as usize;
                }
                let mut refresh_batch = Vec::with_capacity(changed_paths.len());
                for (path, action) in changed_paths {
                    if is_index_internal_path(&data_dir, &path) {
                        continue;
                    }
                    refresh_batch.push(path.clone());
                    if path.is_dir()
                        && matches!(action, FILE_ACTION_ADDED | FILE_ACTION_RENAMED_NEW_NAME)
                    {
                        for entry in WalkDir::new(&path)
                            .follow_links(false)
                            .into_iter()
                            .filter_entry(|entry| {
                                should_descend(entry)
                                    && !is_index_internal_path(&data_dir, entry.path())
                            })
                            .filter_map(Result::ok)
                            .skip(1)
                        {
                            refresh_batch.push(entry.into_path());
                        }
                    }
                }
                for paths in refresh_batch.chunks(WATCH_REFRESH_BATCH_SIZE) {
                    let _ = refresh_paths(&storage, paths);
                }
            }
            unsafe {
                CloseHandle(event);
                CloseHandle(handle);
            }
        });
    }
}

#[cfg(all(target_os = "windows", not(test)))]
pub fn stop_watchers() {
    WATCH_REVISION.fetch_add(1, Ordering::AcqRel);
}

#[cfg(any(not(target_os = "windows"), test))]
pub fn start_watchers(_storage: Arc<StorageManager>, _requested_roots: Vec<String>) {}

#[cfg(any(not(target_os = "windows"), test))]
pub fn stop_watchers() {}

fn normalized_app_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_noisy_app_name(value: &str) -> bool {
    let normalized = normalized_app_name(value);
    [
        "uninstall",
        "unins",
        "reporter",
        "crash",
        "minidump",
        "stackwalk",
        "helper",
        "updater",
        "installer",
        "bootstrap",
        "cefsharpbrowsersubprocess",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
        || matches!(
            normalized.as_str(),
            "update" | "setup" | "repair" | "remove" | "service" | "daemon"
        )
        || normalized.ends_with("util")
        || normalized.ends_with("sdk")
}

pub fn is_noisy_application(path: &Path) -> bool {
    path.file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(is_noisy_app_name)
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(TABLE[(first >> 2) as usize] as char);
        encoded.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

pub fn png_data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64_encode(bytes))
}

pub fn application_display_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return stem.to_string();
    }
    let parent_name = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if normalized_app_name(parent_name) == normalized_app_name(stem) {
        if let Some(product_name) = path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .filter(|value| value.chars().any(|character| !character.is_ascii()))
        {
            return product_name.to_string();
        }
    }
    stem.to_string()
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

pub fn default_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            if root.exists() {
                roots.push(root);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        roots.push(PathBuf::from("/"));
    }
    roots
}

pub fn drive_labels_from_roots<'a>(roots: impl IntoIterator<Item = &'a Path>) -> Vec<String> {
    roots
        .into_iter()
        .filter_map(|root| {
            let value = root.to_string_lossy();
            let bytes = value.as_bytes();
            (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
                .then(|| format!("{}:", (bytes[0] as char).to_ascii_uppercase()))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub fn available_drives() -> Vec<String> {
    let roots = default_roots();
    drive_labels_from_roots(roots.iter().map(PathBuf::as_path))
}

#[cfg(not(test))]
fn application_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for variable in ["LOCALAPPDATA", "APPDATA", "PROGRAMDATA"] {
        if let Some(value) = std::env::var_os(variable) {
            let base = PathBuf::from(value);
            match variable {
                "LOCALAPPDATA" => {
                    roots.push(base.join("Programs"));
                    roots.push(base.join("Microsoft").join("WindowsApps"));
                }
                "APPDATA" | "PROGRAMDATA" => roots.push(
                    base.join("Microsoft")
                        .join("Windows")
                        .join("Start Menu")
                        .join("Programs"),
                ),
                _ => {}
            }
        }
    }
    roots.into_iter().filter(|root| root.is_dir()).collect()
}

fn distinct_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut normalized = roots
        .into_iter()
        .filter(|root| root.exists())
        .map(|root| root.canonicalize().unwrap_or(root))
        .collect::<Vec<_>>();
    normalized.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| normalized_scope_path(left).cmp(&normalized_scope_path(right)))
    });
    let mut distinct = Vec::<PathBuf>::new();
    for root in normalized {
        if !distinct.iter().any(|parent| root.starts_with(parent)) {
            distinct.push(root);
        }
    }
    distinct
}

pub(crate) fn fast_ntfs_volumes(roots: &[PathBuf]) -> Option<Vec<char>> {
    let volumes = roots
        .iter()
        .map(|root| crate::ntfs::volume_letter(root))
        .collect::<Option<Vec<_>>>()?;
    (!volumes.is_empty()).then_some(volumes)
}

pub(crate) fn fast_ntfs_volumes_for_build(
    roots: &[PathBuf],
    completed_roots: usize,
    total_roots: usize,
) -> Option<Vec<char>> {
    (completed_roots < total_roots)
        .then(|| fast_ntfs_volumes(roots))
        .flatten()
}

pub(crate) fn scope_key(requested_roots: &[String]) -> String {
    let resolved_roots =
        if requested_roots.is_empty() || requested_roots.iter().any(|root| root == "*") {
            default_roots()
        } else {
            requested_roots.iter().map(PathBuf::from).collect()
        };
    let mut roots = distinct_roots(resolved_roots)
        .iter()
        .map(|root| {
            let value = display_path(root);
            if cfg!(target_os = "windows") {
                value.to_lowercase()
            } else {
                value
            }
        })
        .collect::<Vec<_>>();
    roots.sort();
    roots.insert(0, "v14-ntfs-root-index".to_string());
    serde_json::to_string(&roots).unwrap_or_else(|_| "[]".to_string())
}

pub fn revision() -> u64 {
    INDEX_REVISION.load(Ordering::Acquire)
}

fn index_build_cancelled(revision: u64) -> bool {
    INDEX_REVISION.load(Ordering::Acquire) != revision
}

pub fn cancel_indexing() {
    // Serialize cancellation with the hand-off from an active build to a
    // queued build. Otherwise the worker can consume `pending`, observe the
    // cancellation revision as its own, and start another full scan on exit.
    let mut state = INDEX_STATE.lock();
    state.pending = None;
    INDEX_REVISION.fetch_add(1, Ordering::AcqRel);
}

pub fn rebuild(storage: &StorageManager, requested_roots: Vec<String>) -> Result<usize, String> {
    let revision = INDEX_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    rebuild_at_revision(storage, requested_roots, revision)
}

pub fn rebuild_if_revision(
    storage: &StorageManager,
    requested_roots: Vec<String>,
    expected_revision: u64,
) -> Result<Option<usize>, String> {
    let revision = expected_revision + 1;
    if INDEX_REVISION
        .compare_exchange(
            expected_revision,
            revision,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return Ok(None);
    }
    rebuild_at_revision(storage, requested_roots, revision).map(Some)
}

fn rebuild_at_revision(
    storage: &StorageManager,
    requested_roots: Vec<String>,
    revision: u64,
) -> Result<usize, String> {
    {
        let mut state = INDEX_STATE.lock();
        let current_revision = INDEX_REVISION.load(Ordering::Acquire);
        if revision != current_revision {
            return Ok(0);
        }
        if state.running {
            let replaces_older_request =
                state.pending.as_ref().map_or(true, |(_, queued_revision)| {
                    let queued_revision = *queued_revision;
                    queued_revision < revision
                });
            if revision == current_revision && replaces_older_request {
                state.pending = Some((requested_roots, revision));
            }
            return Ok(0);
        }
        state.running = true;
        state.status = 1;
        state.phase = 1;
        state.indexed_items = 0;
        state.completed_roots = 0;
        state.total_roots = 0;
        state.current_root = None;
    }

    let mut roots = requested_roots;
    let mut active_revision = revision;
    loop {
        let result = rebuild_inner(storage, roots, active_revision);
        let mut state = INDEX_STATE.lock();
        if let Some((pending, pending_revision)) = state.pending.take() {
            let current_revision = INDEX_REVISION.load(Ordering::Acquire);
            // A request can reserve a revision just before shutdown and only
            // reach this queue after cancellation. Never let that stale request
            // adopt the cancellation revision and revive a full-disk scan.
            if pending_revision == current_revision {
                roots = pending;
                active_revision = pending_revision;
                drop(state);
                continue;
            }
        }
        state.running = false;
        state.status = if result.is_ok() { 2 } else { 3 };
        state.phase = if result.is_ok() { 2 } else { 3 };
        state.current_root = None;
        if let Ok(count) = result.as_ref() {
            state.indexed_items = *count;
            state.completed_roots = state.total_roots;
        }
        drop(state);
        return result;
    }
}

// A larger transaction dramatically reduces FTS5 journal and tree-rebalance
// overhead on multi-million item volumes while keeping transient memory bounded.
const INDEX_BATCH_SIZE: usize = 32768;
const INDEX_DIRECTORY_CHUNK: usize = 16_384;

pub(crate) fn fast_index_coverage_is_credible(discovered: usize, indexed: usize) -> bool {
    // Small test volumes and nearly empty drives do not provide a useful ratio.
    // On a real full disk, however, reconstructing only a tiny fraction of MFT
    // records means the file-reference graph was incomplete. Never publish that
    // partial tree as a completed index.
    discovered < 10_000 || indexed.saturating_mul(20) >= discovered
}

fn flush_index_batch(
    storage: &StorageManager,
    connection: &mut Connection,
    records: &mut Vec<(String, String, &'static str)>,
    revision: u64,
) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    if index_build_cancelled(revision) {
        return Err("索引任务已取消".into());
    }
    let _writer = storage.index_write_guard();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO search_fts_next(name, path, kind, modified_at)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|error| error.to_string())?;
        for (index, (name, path, kind)) in records.drain(..).enumerate() {
            if index % 1024 == 0 && index_build_cancelled(revision) {
                return Err("索引任务已取消".into());
            }
            statement
                .execute(params![name, path, kind, Option::<u64>::None])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn try_fast_ntfs_index(
    storage: &StorageManager,
    connection: &mut Connection,
    volumes: &[char],
    data_dir: &Path,
    indexed_app_paths: &mut HashSet<String>,
    system_apps: &[RegisteredApp],
    total_roots: usize,
    revision: u64,
) -> Result<usize, String> {
    let root_paths = volumes
        .iter()
        .map(|volume| format!("{volume}:\\").to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let _writer = storage.index_write_guard();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM search_fts_next", [])
        .map_err(|error| error.to_string())?;
    let mut statement = transaction
        .prepare(
            "INSERT INTO search_fts_next(name, path, kind, modified_at)
             VALUES (?1, ?2, ?3, NULL)",
        )
        .map_err(|error| error.to_string())?;
    let mut fast_indexed_app_paths = HashSet::new();
    let mut count = 0usize;
    for app in system_apps {
        let normalized = app.path.replace('/', "\\").to_ascii_lowercase();
        if !root_paths.iter().any(|root| normalized.starts_with(root))
            || is_noisy_application(Path::new(&app.path))
            || is_noisy_app_name(&app.name)
            || !fast_indexed_app_paths.insert(normalized)
        {
            continue;
        }
        statement
            .execute(params![
                encode_indexed_name(&app.name, "app"),
                app.path,
                "app"
            ])
            .map_err(|error| error.to_string())?;
        count = count.saturating_add(1);
    }
    let registered_app_count = count;
    let mut preview_count = count;
    let mut largest_discovered = 0usize;
    update_index_progress(4, preview_count, 0, total_roots, None);
    let result = crate::ntfs::scan_volumes_elevated(volumes, |event| {
        if index_build_cancelled(revision) {
            return Err("索引任务已取消".into());
        }
        match event {
            crate::ntfs::FastIndexEvent::Progress { discovered } => {
                largest_discovered = largest_discovered.max(discovered);
                preview_count = preview_count.max(count.saturating_add(discovered));
                update_index_progress(5, preview_count, 0, total_roots, None);
            }
            crate::ntfs::FastIndexEvent::Entry { path, is_directory } => {
                if is_index_internal_path(data_dir, &path)
                    || is_regenerable_cache_path(&path)
                    || root_paths.contains(&display_path(&path).to_ascii_lowercase())
                {
                    return Ok(());
                }
                let normalized = display_path(&path).replace('/', "\\").to_ascii_lowercase();
                if [
                    "\\node_modules\\",
                    "\\.git\\",
                    "\\$recycle.bin\\",
                    "\\system volume information\\",
                    "\\winsxs\\",
                    "\\__pycache__\\",
                ]
                .iter()
                .any(|excluded| normalized.contains(excluded))
                {
                    return Ok(());
                }
                let kind = kind_for_path(&path, is_directory);
                if kind == "app" {
                    if is_noisy_application(&path) || !fast_indexed_app_paths.insert(normalized) {
                        return Ok(());
                    }
                }
                let name = path
                    .file_name()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_default();
                if name.is_empty() {
                    return Ok(());
                }
                statement
                    .execute(params![
                        encode_indexed_name(&name, kind),
                        display_path(&path),
                        kind
                    ])
                    .map_err(|error| error.to_string())?;
                count = count.saturating_add(1);
                if count % 8192 == 0 {
                    update_index_progress(5, preview_count.max(count), 0, total_roots, None);
                }
            }
        }
        Ok(())
    });
    drop(statement);
    result?;
    let indexed_file_tree_items = count.saturating_sub(registered_app_count);
    if !fast_index_coverage_is_credible(largest_discovered, indexed_file_tree_items) {
        return Err(format!(
            "NTFS 文件路径还原不完整（发现 {largest_discovered} 项，仅还原 {indexed_file_tree_items} 项）"
        ));
    }
    transaction
        .execute("DELETE FROM search_build_directories", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE search_build_meta
             SET completed_roots = ?1, indexed_items = ?2, updated_at = unixepoch()
             WHERE id = 1",
            params![total_roots, count],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    *indexed_app_paths = fast_indexed_app_paths;
    Ok(count)
}

pub(crate) fn should_descend_path(path: &Path, is_dir: bool) -> bool {
    if !is_dir {
        return true;
    }
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    if [
        "node_modules",
        ".git",
        "$recycle.bin",
        "system volume information",
        "winsxs",
        "__pycache__",
    ]
    .iter()
    .any(|excluded| name.eq_ignore_ascii_case(excluded))
    {
        return false;
    }
    true
}

pub(crate) fn should_descend_full_disk_path(path: &Path, is_dir: bool) -> bool {
    let should_descend = should_descend_path(path, is_dir);
    if !should_descend || !is_dir {
        return should_descend;
    }
    !is_regenerable_cache_path(path)
}

fn is_regenerable_cache_path(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    [
        "\\windows\\softwaredistribution\\download",
        "\\program files\\microsoft office\\updates\\download\\packagefiles",
        "\\appdata\\local\\temp",
        "\\appdata\\local\\cache",
        "\\appdata\\local\\yarn\\cache",
        "\\node_cache\\_cacache",
        "\\npm-cache\\_cacache",
        "\\appdata\\local\\pub\\cache",
        "\\appdata\\local\\.dartserver",
        "\\appdata\\roaming\\.minecraft\\cache",
        "\\.m2\\repository",
        "\\.gradle\\caches",
        "\\.cargo\\registry",
        "\\anaconda\\pkgs",
        "\\miniconda\\pkgs",
        "\\.codex\\.tmp",
    ]
    .iter()
    .any(|excluded| {
        normalized == excluded.trim_start_matches('\\')
            || normalized.ends_with(excluded)
            || normalized.contains(&format!("{excluded}\\"))
    })
}

fn pending_directory_chunk(connection: &Connection) -> Result<Vec<(String, usize, bool)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT path, root_index, started
             FROM search_build_directories
             ORDER BY rowid
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([INDEX_DIRECTORY_CHUNK as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, usize>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn commit_directory_batch(
    storage: &StorageManager,
    connection: &mut Connection,
    records: &mut Vec<(String, String, &'static str)>,
    children: &mut Vec<(String, usize)>,
    started_directories: &mut Vec<String>,
    completed_directories: &mut Vec<String>,
    indexed_items: usize,
    total_roots: usize,
    revision: u64,
) -> Result<(usize, usize), String> {
    if records.is_empty()
        && children.is_empty()
        && started_directories.is_empty()
        && completed_directories.is_empty()
    {
        return Ok((indexed_items, 0));
    }
    if index_build_cancelled(revision) {
        return Err("索引任务已取消".into());
    }
    let _writer = storage.index_write_guard();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut next_count = indexed_items;
    {
        let mut insert_entry = transaction
            .prepare(
                "INSERT INTO search_fts_next(name, path, kind, modified_at)
                 VALUES (?1, ?2, ?3, NULL)",
            )
            .map_err(|error| error.to_string())?;
        let mut insert_directory = transaction
            .prepare(
                "INSERT OR IGNORE INTO search_build_directories(path, root_index)
                 VALUES (?1, ?2)",
            )
            .map_err(|error| error.to_string())?;
        let mut finish_directory = transaction
            .prepare(
                "DELETE FROM search_build_directories
                 WHERE path = ?1 COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        let mut start_directory = transaction
            .prepare(
                "UPDATE search_build_directories
                 SET started = 1
                 WHERE path = ?1 COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        for (name, path, kind) in records.drain(..) {
            insert_entry
                .execute(params![name, path, kind])
                .map_err(|error| error.to_string())?;
            next_count = next_count.saturating_add(1);
        }
        for (child, root_index) in children.drain(..) {
            insert_directory
                .execute(params![child, root_index])
                .map_err(|error| error.to_string())?;
        }
        for directory in started_directories.drain(..) {
            start_directory
                .execute([directory])
                .map_err(|error| error.to_string())?;
        }
        for directory in completed_directories.drain(..) {
            finish_directory
                .execute([directory])
                .map_err(|error| error.to_string())?;
        }
    }
    let completed_roots = transaction
        .query_row(
            "SELECT MIN(root_index) FROM search_build_directories",
            [],
            |row| row.get::<_, Option<usize>>(0),
        )
        .map_err(|error| error.to_string())?
        .unwrap_or(total_roots)
        .min(total_roots);
    transaction
        .execute(
            "UPDATE search_build_meta
             SET indexed_items = ?1, completed_roots = ?2,
                 updated_at = unixepoch()
             WHERE id = 1",
            params![next_count, completed_roots],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok((next_count, completed_roots))
}

struct ScannedDirectoryChunk {
    path: String,
    records: Vec<(String, String, &'static str)>,
    children: Vec<(String, usize)>,
    finished: bool,
}

fn scan_directory(
    directory_path: &str,
    root_index: usize,
    full_disk_root: bool,
    data_dir: &Path,
    revision: u64,
    sender: &mpsc::SyncSender<Result<ScannedDirectoryChunk, String>>,
) -> Result<(), String> {
    let mut records = Vec::with_capacity(INDEX_ENTRY_CHUNK);
    let mut children = Vec::with_capacity(INDEX_ENTRY_CHUNK / 4);
    if let Ok(entries) = fs::read_dir(directory_path) {
        for (entry_index, entry) in entries.filter_map(Result::ok).enumerate() {
            if entry_index % 512 == 0 && index_build_cancelled(revision) {
                return Err("索引任务已取消".into());
            }
            let entry_path = entry.path();
            if is_index_internal_path(data_dir, &entry_path) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_dir = file_type.is_dir();
            if !(if full_disk_root {
                should_descend_full_disk_path(&entry_path, is_dir)
            } else {
                should_descend_path(&entry_path, is_dir)
            }) {
                continue;
            }
            let kind = kind_for_path(&entry_path, is_dir);
            if kind == "app" && is_noisy_application(&entry_path) {
                continue;
            }
            let displayed_path = display_path(&entry_path);
            let name = if kind == "app" {
                application_display_name(&entry_path)
            } else {
                entry.file_name().to_string_lossy().to_string()
            };
            if !name.is_empty() {
                records.push((
                    encode_indexed_name(&name, kind),
                    displayed_path.clone(),
                    kind,
                ));
            }
            if is_dir {
                children.push((displayed_path, root_index));
            }
            if records.len().saturating_add(children.len()) >= INDEX_ENTRY_CHUNK {
                sender
                    .send(Ok(ScannedDirectoryChunk {
                        path: directory_path.to_string(),
                        records: std::mem::take(&mut records),
                        children: std::mem::take(&mut children),
                        finished: false,
                    }))
                    .map_err(|_| "索引接收线程已停止".to_string())?;
            }
        }
    }
    sender
        .send(Ok(ScannedDirectoryChunk {
            path: directory_path.to_string(),
            records,
            children,
            finished: true,
        }))
        .map_err(|_| "索引接收线程已停止".to_string())
}

fn process_queued_directories(
    storage: &StorageManager,
    connection: &mut Connection,
    queued: &[(String, usize, bool)],
    full_disk_roots: &[bool],
    data_dir: &Path,
    indexed_app_paths: &mut HashSet<String>,
    indexed_items: usize,
    initial_completed_roots: usize,
    total_roots: usize,
    revision: u64,
) -> Result<(usize, usize), String> {
    let mut next_count = indexed_items;
    // Compatibility with v11 partial-directory checkpoints. Current builds
    // only persist whole directory groups, so this branch disappears after
    // the first successful resume.
    for (directory_path, _, started) in queued {
        if *started {
            let prefix = if directory_path.ends_with('\\') || directory_path.ends_with('/') {
                directory_path.to_string()
            } else {
                format!("{directory_path}{}", std::path::MAIN_SEPARATOR)
            };
            let _writer = storage.index_write_guard();
            let transaction = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            let removed = transaction
                .execute(
                    "DELETE FROM search_fts_next
                     WHERE substr(path, 1, ?2) = ?1 COLLATE NOCASE",
                    params![prefix, prefix.chars().count()],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "DELETE FROM search_build_directories
                     WHERE path != ?2 COLLATE NOCASE
                       AND substr(path, 1, ?3) = ?1 COLLATE NOCASE",
                    params![prefix, directory_path, prefix.chars().count()],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE search_build_directories
                     SET started = 0 WHERE path = ?1 COLLATE NOCASE",
                    [directory_path],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            next_count = next_count.saturating_sub(removed);
        }
    }

    // The recovery transaction above can remove descendants of an incomplete
    // directory. Do not dispatch the stale, pre-recovery snapshot: a child
    // from that snapshot could finish before its parent re-enqueues it, which
    // would make the child run twice and duplicate its FTS rows.
    let queued = pending_directory_chunk(connection)?;
    if queued.is_empty() {
        return Ok((next_count, initial_completed_roots));
    }
    let queued = queued.as_slice();

    let mut records = Vec::with_capacity(INDEX_BATCH_SIZE);
    let mut children = Vec::with_capacity(INDEX_ENTRY_CHUNK);
    let mut started_directories = Vec::with_capacity(4);
    let mut completed_directories = Vec::with_capacity(32);
    let mut completed_roots = initial_completed_roots;
    let mut live_items = next_count;
    let task_cursor = AtomicUsize::new(0);
    let worker_count = std::thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(2)
        .clamp(4, 8)
        .min(queued.len().max(1));

    std::thread::scope(|scope| -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(worker_count * 2);
        for _ in 0..worker_count {
            let sender = sender.clone();
            let task_cursor = &task_cursor;
            scope.spawn(move || {
                let _priority = BackgroundIndexPriority::begin();
                loop {
                    let index = task_cursor.fetch_add(1, Ordering::AcqRel);
                    let Some((path, root_index, _)) = queued.get(index) else {
                        break;
                    };
                    let full_disk_root = full_disk_roots.get(*root_index).copied().unwrap_or(false);
                    if let Err(error) = scan_directory(
                        path,
                        *root_index,
                        full_disk_root,
                        data_dir,
                        revision,
                        &sender,
                    ) {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            });
        }
        drop(sender);

        for result in receiver {
            let mut scanned = result?;
            scanned.records.retain(|(_, path, kind)| {
                if *kind != "app" {
                    return true;
                }
                let key = if cfg!(target_os = "windows") {
                    path.to_lowercase()
                } else {
                    path.clone()
                };
                indexed_app_paths.insert(key)
            });
            let incoming_size = scanned.records.len().saturating_add(scanned.children.len());
            let buffered_size = records.len().saturating_add(children.len());
            if buffered_size > 0 && buffered_size.saturating_add(incoming_size) > INDEX_BATCH_SIZE {
                (next_count, completed_roots) = commit_directory_batch(
                    storage,
                    connection,
                    &mut records,
                    &mut children,
                    &mut started_directories,
                    &mut completed_directories,
                    next_count,
                    total_roots,
                    revision,
                )?;
            }
            live_items = live_items.saturating_add(scanned.records.len());
            let current_path = scanned.path.clone();
            records.append(&mut scanned.records);
            children.append(&mut scanned.children);
            if scanned.finished {
                completed_directories.push(scanned.path);
            } else {
                started_directories.push(scanned.path);
            }
            update_index_progress(
                1,
                live_items.max(next_count),
                completed_roots,
                total_roots,
                Some(current_path.clone()),
            );
            if started_directories
                .len()
                .saturating_add(completed_directories.len())
                >= 32
                || records.len().saturating_add(children.len()) >= INDEX_BATCH_SIZE
            {
                (next_count, completed_roots) = commit_directory_batch(
                    storage,
                    connection,
                    &mut records,
                    &mut children,
                    &mut started_directories,
                    &mut completed_directories,
                    next_count,
                    total_roots,
                    revision,
                )?;
                update_index_progress(
                    1,
                    live_items.max(next_count),
                    completed_roots,
                    total_roots,
                    Some(current_path),
                );
            }
        }
        Ok(())
    })?;

    if !records.is_empty()
        || !children.is_empty()
        || !started_directories.is_empty()
        || !completed_directories.is_empty()
    {
        (next_count, completed_roots) = commit_directory_batch(
            storage,
            connection,
            &mut records,
            &mut children,
            &mut started_directories,
            &mut completed_directories,
            next_count,
            total_roots,
            revision,
        )?;
    }
    Ok((next_count, completed_roots))
}

fn rebuild_inner(
    storage: &StorageManager,
    requested_roots: Vec<String>,
    revision: u64,
) -> Result<usize, String> {
    let _background_priority = BackgroundIndexPriority::begin();
    let mut throttle = IndexThrottle::new(include_application_roots(&requested_roots));
    let scope = scope_key(&requested_roots);
    #[cfg(not(test))]
    let include_apps = include_application_roots(&requested_roots);
    // Populate and cache Start menu applications before walking every disk. The
    // query path can use this cache immediately while the slower file index runs.
    let system_apps = registered_apps();
    let roots = if requested_roots.is_empty() || requested_roots.iter().any(|root| root == "*") {
        default_roots()
    } else {
        requested_roots.iter().map(PathBuf::from).collect()
    };
    #[cfg(not(test))]
    let roots = {
        let mut roots = roots;
        if include_apps {
            roots.extend(application_roots());
        }
        roots
    };
    let roots = distinct_roots(roots);
    let full_disk_roots = roots
        .iter()
        .map(|root| root.parent().is_none())
        .collect::<Vec<_>>();
    let total_roots = roots.len();
    let legacy_staging = storage.data_dir().join("search-index-staging.db");
    if legacy_staging.exists() {
        // This file belonged to the retired pre-v11 indexer. A locked legacy
        // artifact must never prevent the current index from starting.
        let _ = fs::remove_file(legacy_staging);
    }
    let mut index_connection =
        Connection::open(storage.search_database_path()).map_err(|error| error.to_string())?;
    index_connection
        .busy_timeout(Duration::from_secs(8))
        .map_err(|error| error.to_string())?;
    let writer = storage.index_write_guard();
    INDEX_DIRTY_PATHS.lock().clear();
    index_connection
        .execute_batch(
            "
            PRAGMA synchronous = NORMAL;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -16384;
            PRAGMA wal_autocheckpoint = 16384;
            ",
        )
        .map_err(|error| error.to_string())?;
    let resumable = index_connection
        .query_row(
            "
            SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'search_fts_next'
            ) AND EXISTS(
                SELECT 1 FROM search_build_meta
                WHERE id = 1 AND scope = ?1
            ) AND EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'search_build_directories'
            ) AND (
                EXISTS(
                    SELECT 1 FROM search_build_meta
                    WHERE id = 1 AND completed_roots >= ?2
                )
                OR EXISTS(SELECT 1 FROM search_build_directories)
            )
            ",
            params![scope, total_roots],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !resumable {
        index_connection
            .execute_batch(
                "
                DROP TABLE IF EXISTS search_fts_next;
                CREATE VIRTUAL TABLE search_fts_next USING fts5(
                    name,
                    path UNINDEXED,
                    kind UNINDEXED,
                    modified_at UNINDEXED,
                    tokenize = 'trigram'
                );
                DELETE FROM search_build_meta;
                DELETE FROM search_build_dirty_paths;
                DELETE FROM search_build_directories;
                ",
            )
            .map_err(|error| error.to_string())?;
        let transaction = index_connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "
                INSERT INTO search_build_meta(
                    id, scope, completed_roots, indexed_items, updated_at
                ) VALUES (1, ?1, 0, 0, unixepoch())
                ",
                [&scope],
            )
            .map_err(|error| error.to_string())?;
        for (root_index, root) in roots.iter().enumerate() {
            let displayed_path = display_path(root);
            let is_dir = root.is_dir();
            let kind = kind_for_path(root, is_dir);
            let name = root
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| displayed_path.clone());
            transaction
                .execute(
                    "INSERT INTO search_fts_next(name, path, kind, modified_at)
                     VALUES (?1, ?2, ?3, NULL)",
                    params![encode_indexed_name(&name, kind), displayed_path, kind],
                )
                .map_err(|error| error.to_string())?;
            if is_dir {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO search_build_directories(path, root_index)
                         VALUES (?1, ?2)",
                        params![display_path(root), root_index],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let completed_roots = index_connection
        .query_row(
            "SELECT completed_roots FROM search_build_meta WHERE id = 1",
            [],
            |row| row.get::<_, usize>(0),
        )
        .unwrap_or(0)
        .min(total_roots);
    // Application discovery is cheap and may change independently of a disk root.
    // Refresh registered application paths one by one. Deleting every app row here
    // would also remove .exe/.lnk entries from roots already completed before a
    // restart, while those roots are intentionally skipped during resume.
    {
        let transaction = index_connection
            .transaction()
            .map_err(|error| error.to_string())?;
        {
            let mut delete = transaction
                .prepare("DELETE FROM search_fts_next WHERE path = ?1")
                .map_err(|error| error.to_string())?;
            for app in system_apps {
                delete
                    .execute([&app.path])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
    }
    // Keep the committed prefix and continue from its durable cursor. Watcher
    // changes that landed ahead of that cursor were removed above so the
    // scanner can insert them once in traversal order.
    let mut count = index_connection
        .query_row("SELECT COUNT(*) FROM search_fts_next", [], |row| {
            row.get::<_, usize>(0)
        })
        .unwrap_or(0);
    drop(writer);
    set_fast_index_fallback_reason(None);
    update_index_progress(1, count, completed_roots, total_roots, None);
    let mut batch = Vec::with_capacity(INDEX_BATCH_SIZE);
    let mut indexed_app_paths = HashSet::new();
    let data_dir = storage.data_dir();

    for app in system_apps {
        if !path_matches_roots(Path::new(&app.path), &requested_roots)
            || is_noisy_application(Path::new(&app.path))
            || is_noisy_app_name(&app.name)
        {
            continue;
        }
        let path_key = if cfg!(target_os = "windows") {
            app.path.to_lowercase()
        } else {
            app.path.clone()
        };
        indexed_app_paths.insert(path_key);
        batch.push((
            encode_indexed_name(&app.name, "app"),
            app.path.clone(),
            "app",
        ));
        count += 1;
        if batch.len() >= INDEX_BATCH_SIZE {
            flush_index_batch(storage, &mut index_connection, &mut batch, revision)?;
            update_index_progress(1, count, completed_roots, total_roots, None);
            yield_indexer_to_interactive_work(&mut throttle);
            if index_build_cancelled(revision) {
                return Err("索引范围已更新，正在切换到最新目录".into());
            }
        }
    }

    flush_index_batch(storage, &mut index_connection, &mut batch, revision)?;
    count = index_connection
        .query_row("SELECT COUNT(*) FROM search_fts_next", [], |row| row.get(0))
        .unwrap_or(count);

    let mut completed = completed_roots;
    #[cfg(all(target_os = "windows", not(test)))]
    {
        if let Some(volumes) = fast_ntfs_volumes_for_build(&roots, completed_roots, total_roots) {
            set_fast_index_fallback_reason(None);
            match try_fast_ntfs_index(
                storage,
                &mut index_connection,
                &volumes,
                &data_dir,
                &mut indexed_app_paths,
                &system_apps,
                total_roots,
                revision,
            ) {
                Ok(indexed) => {
                    count = indexed;
                    completed = total_roots;
                    update_index_progress(1, count, completed, total_roots, None);
                }
                Err(error) => {
                    eprintln!("NTFS MFT fast index unavailable; using directory fallback: {error}");
                    set_fast_index_fallback_reason(Some(error));
                    update_index_progress(1, count, completed, total_roots, None);
                }
            }
        }
    }
    loop {
        if index_build_cancelled(revision) {
            return Err("索引范围已更新，正在切换到最新目录".into());
        }
        let queued = pending_directory_chunk(&index_connection)?;
        if queued.is_empty() {
            break;
        }
        let active_root_index = queued[0].1.min(total_roots.saturating_sub(1));
        let current_root = roots
            .get(active_root_index)
            .map(|root| display_path(root))
            .unwrap_or_default();
        update_index_progress(1, count, completed, total_roots, Some(current_root.clone()));
        (count, completed) = process_queued_directories(
            storage,
            &mut index_connection,
            &queued,
            &full_disk_roots,
            &data_dir,
            &mut indexed_app_paths,
            count,
            completed,
            total_roots,
            revision,
        )?;
        update_index_progress(1, count, completed, total_roots, Some(current_root));
        yield_indexer_to_interactive_work(&mut throttle);
    }
    if index_build_cancelled(revision) {
        return Err("索引范围已更新，正在切换到最新目录".into());
    }
    update_index_progress(6, count, total_roots, total_roots, None);
    let _writer = storage.index_write_guard();
    let transaction = index_connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut dirty_paths = std::mem::take(&mut *INDEX_DIRTY_PATHS.lock());
    {
        let mut statement = transaction
            .prepare("SELECT path FROM search_build_dirty_paths")
            .map_err(|error| error.to_string())?;
        let persisted = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        dirty_paths.extend(persisted.filter_map(Result::ok).map(PathBuf::from));
    }
    reconcile_dirty_paths(&transaction, dirty_paths)?;
    transaction
        .execute_batch(
            "
            DROP TABLE search_fts;
            ALTER TABLE search_fts_next RENAME TO search_fts;
            ",
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "
        INSERT INTO search_meta(id, scope, complete, updated_at)
        VALUES (1, ?1, 1, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            scope = excluded.scope,
            complete = 1,
            updated_at = excluded.updated_at
        ",
            [&scope],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM search_build_meta", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM search_build_dirty_paths", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM search_build_directories", [])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let indexed_count = index_connection
        .query_row("SELECT COUNT(*) FROM search_fts", [], |row| {
            row.get::<_, usize>(0)
        })
        .unwrap_or(count);
    Ok(indexed_count)
}

pub fn status() -> &'static str {
    match INDEX_STATE.lock().status {
        1 => "indexing",
        2 => "ready",
        3 => "failed",
        _ => "idle",
    }
}

pub fn progress() -> IndexProgress {
    let state = INDEX_STATE.lock();
    let status = match state.status {
        1 => "indexing",
        2 => "ready",
        3 => "failed",
        _ => "idle",
    };
    let phase = match state.phase {
        1 => "scanning",
        2 => "complete",
        3 => "failed",
        4 => "authorizing",
        5 => "mft",
        6 => "finalizing",
        _ => "idle",
    };
    IndexProgress {
        status: status.into(),
        phase: phase.into(),
        indexed_items: state.indexed_items,
        completed_roots: state.completed_roots,
        total_roots: state.total_roots,
        current_root: state.current_root.clone(),
        fallback_reason: state.fallback_reason.clone(),
    }
}

pub fn has_index(storage: &StorageManager, requested_roots: &[String]) -> bool {
    let expected_scope = scope_key(requested_roots);
    let reusable_full_scope = if !include_application_roots(requested_roots) {
        let disk_roots = default_roots()
            .iter()
            .map(|root| display_path(root))
            .collect::<Vec<_>>();
        requested_roots
            .iter()
            .all(|root| path_matches_roots(Path::new(root), &disk_roots))
            .then(|| scope_key(&["*".to_string()]))
    } else {
        None
    };
    let exists = storage
        .with_search_read_connection(|connection| {
            connection
                .query_row(
                    "
                    SELECT EXISTS(SELECT 1 FROM search_fts LIMIT 1)
                       AND NOT EXISTS(
                           SELECT 1 FROM search_fts
                           WHERE substr(path, 1, 4) = ?1
                           LIMIT 1
                       )
                       AND EXISTS(
                           SELECT 1 FROM search_meta
                           WHERE id = 1
                             AND complete = 1
                             AND (scope = ?2 OR (?3 IS NOT NULL AND scope = ?3))
                       )
                    ",
                    params![r"\\?\", expected_scope, reusable_full_scope],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| error.to_string())
        })
        .unwrap_or(false);
    if exists {
        let mut state = INDEX_STATE.lock();
        state.status = 2;
        state.phase = 2;
    }
    exists
}

pub fn has_full_disk_index(storage: &StorageManager) -> bool {
    let full_scope = scope_key(&["*".to_string()]);
    storage
        .with_search_read_connection(|connection| {
            connection
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM search_meta
                        WHERE id = 1 AND scope = ?1 AND complete = 1
                    )",
                    [full_scope],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| error.to_string())
        })
        .unwrap_or(false)
}

pub fn has_partial_index(storage: &StorageManager, requested_roots: &[String]) -> bool {
    let expected_scope = scope_key(requested_roots);
    storage
        .with_search_read_connection(|connection| {
            connection
                .query_row(
                    "
                    SELECT EXISTS(
                        SELECT 1 FROM sqlite_master
                        WHERE type = 'table' AND name = 'search_fts_next'
                    ) AND EXISTS(
                        SELECT 1 FROM search_build_meta
                        WHERE id = 1 AND scope = ?1
                    )
                    ",
                    [&expected_scope],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| error.to_string())
        })
        .unwrap_or(false)
}

pub fn count(storage: &StorageManager) -> Result<usize, String> {
    storage.with_search_read_connection(|connection| {
        connection
            .query_row("SELECT count(*) FROM search_fts", [], |row| row.get(0))
            .map_err(|error| error.to_string())
    })
}

pub fn begin_query() -> u64 {
    LAST_QUERY_AT_MS.store(epoch_millis(), Ordering::Release);
    QUERY_REVISION.fetch_add(1, Ordering::AcqRel) + 1
}

#[cfg(test)]
pub fn query(
    storage: &StorageManager,
    query: &str,
    kind: &str,
    extension: &str,
    drive: &str,
    roots: &[String],
) -> Result<Vec<SearchResult>, String> {
    query_inner(storage, query, kind, extension, drive, roots, None)
}

pub fn query_latest(
    storage: &StorageManager,
    query: &str,
    kind: &str,
    extension: &str,
    drive: &str,
    roots: &[String],
    query_revision: u64,
) -> Result<Vec<SearchResult>, String> {
    query_inner(
        storage,
        query,
        kind,
        extension,
        drive,
        roots,
        Some(query_revision),
    )
}

fn indexed_candidates(
    connection: &Connection,
    table: &str,
    expression: &str,
    kind: &str,
    limit: usize,
    extension_pattern: &str,
    drive_pattern: &str,
    root_filter: &str,
) -> Result<Vec<SearchResult>, String> {
    let sql = if table == "search_fts" {
        indexed_candidate_sql().to_string()
    } else {
        indexed_candidate_sql().replace("search_fts", "search_fts_next")
    };
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                expression,
                kind,
                extension_pattern,
                drive_pattern,
                root_filter,
                limit as i64
            ],
            |row| {
                let indexed_name = row.get::<_, String>(1)?;
                Ok(SearchResult {
                    id: format!("{table}-{}", row.get::<_, i64>(0)?),
                    name: indexed_display_name(&indexed_name).to_string(),
                    path: row.get(2)?,
                    kind: row.get(3)?,
                    modified_at: row.get(4)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn candidate_kind_plan(kind: &str) -> Vec<(&str, usize)> {
    if kind.is_empty() {
        vec![("app", 64), ("folder", 128), ("file", 256)]
    } else {
        vec![(kind, CANDIDATE_LIMIT)]
    }
}

fn indexed_candidates_by_kind(
    connection: &Connection,
    table: &str,
    expression: &str,
    kind: &str,
    extension_pattern: &str,
    drive_pattern: &str,
    root_filter: &str,
) -> Result<Vec<SearchResult>, String> {
    let mut results = Vec::new();
    for (planned_kind, limit) in candidate_kind_plan(kind) {
        results.extend(indexed_candidates(
            connection,
            table,
            expression,
            planned_kind,
            limit,
            extension_pattern,
            drive_pattern,
            root_filter,
        )?);
    }
    Ok(results)
}

pub(crate) fn indexed_candidate_sql() -> &'static str {
    "
            SELECT rowid, name, path, kind, modified_at
            FROM search_fts
            WHERE search_fts MATCH ?1
              AND (?2 = '' OR kind = ?2)
              AND (?3 = '' OR lower(path) LIKE ?3)
              AND (?4 = '' OR lower(path) LIKE ?4)
              AND (
                ?5 = ''
                OR EXISTS (
                  SELECT 1 FROM json_each(?5)
                  WHERE lower(replace(search_fts.path, '/', char(92))) = value
                     OR substr(
                          lower(replace(search_fts.path, '/', char(92))),
                          1,
                          length(value) + 1
                        ) = value || char(92)
                )
              )
              AND NOT (
                kind = 'app' AND (
                    lower(name) LIKE '%uninstall%'
                    OR lower(name) LIKE '%reporter%'
                    OR lower(name) LIKE '%crash%'
                    OR lower(name) LIKE '%minidump%'
                    OR lower(name) LIKE '%helper%'
                    OR lower(name) LIKE '%updater%'
                    OR lower(name) LIKE '%installer%'
                    OR lower(path) LIKE '%uninstall%'
                    OR lower(path) LIKE '%reporter%'
                    OR lower(path) LIKE '%minidump%'
                    OR lower(path) LIKE '%helper%'
                  )
              )
            ORDER BY rank
            LIMIT ?6
            "
}

fn query_inner(
    storage: &StorageManager,
    query: &str,
    kind: &str,
    extension: &str,
    drive: &str,
    roots: &[String],
    query_revision: Option<u64>,
) -> Result<Vec<SearchResult>, String> {
    let _query_guard = QUERY_GATE.lock();
    if query_revision.is_some_and(|revision| QUERY_REVISION.load(Ordering::Acquire) != revision) {
        return Ok(Vec::new());
    }
    let normalized = query.trim();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let terms = expanded_search_terms(normalized);
    let mut application_results =
        registered_app_results(registered_apps(), normalized, kind, extension, drive, roots);
    if query_revision.is_some_and(|revision| QUERY_REVISION.load(Ordering::Acquire) != revision) {
        return Ok(Vec::new());
    }
    let exact_expression = fts_exact_expression(&terms);
    let fuzzy_expression = fts_candidate_expression(&terms);
    let extension_pattern = if extension.trim().is_empty() {
        String::new()
    } else {
        format!(
            "%.{}",
            extension.trim().trim_start_matches('.').to_lowercase()
        )
    };
    let drive_pattern = if drive.trim().is_empty() {
        String::new()
    } else {
        format!("{}%", drive.trim().to_lowercase())
    };
    let root_filter = if include_application_roots(roots) {
        String::new()
    } else {
        serde_json::to_string(
            &roots
                .iter()
                .map(|root| normalized_scope_path(Path::new(root)))
                .filter(|root| !root.is_empty())
                .collect::<Vec<_>>(),
        )
        .map_err(|error| error.to_string())?
    };
    // A one-character term has no useful trigram. Falling back to `%x%` scans
    // the entire FTS table on every keystroke, so keep these queries to the
    // small registered-app and cached root-folder sets.
    let indexed_results = if exact_expression.is_none() {
        Vec::new()
    } else {
        storage.with_search_read_connection(|connection| {
            if let Some(revision) = query_revision {
                connection.progress_handler(
                    1_000,
                    Some(move || QUERY_REVISION.load(Ordering::Acquire) != revision),
                );
            }
            let result = (|| {
                let next_exists = status() == "indexing"
                    && connection
                        .query_row(
                            "SELECT EXISTS(
                                SELECT 1 FROM sqlite_master
                                WHERE type = 'table' AND name = 'search_fts_next'
                            )",
                            [],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(false);
                let tables = if next_exists {
                    vec!["search_fts", "search_fts_next"]
                } else {
                    vec!["search_fts"]
                };
                let mut exact = Vec::new();
                for table in &tables {
                    let candidates = indexed_candidates_by_kind(
                        connection,
                        table,
                        exact_expression.as_deref().unwrap_or_default(),
                        kind,
                        &extension_pattern,
                        &drive_pattern,
                        &root_filter,
                    );
                    match candidates {
                        Ok(candidates) => exact.extend(candidates),
                        Err(_) if *table == "search_fts_next" => {}
                        Err(error) => return Err(error),
                    }
                }
                if !exact.is_empty() || fuzzy_expression == exact_expression {
                    return Ok(exact);
                }
                let mut fuzzy = Vec::new();
                for table in tables {
                    let candidates = indexed_candidates_by_kind(
                        connection,
                        table,
                        fuzzy_expression.as_deref().unwrap_or_default(),
                        kind,
                        &extension_pattern,
                        &drive_pattern,
                        &root_filter,
                    );
                    match candidates {
                        Ok(candidates) => fuzzy.extend(candidates),
                        Err(_) if table == "search_fts_next" => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(fuzzy)
            })();
            connection.progress_handler::<fn() -> bool>(0, None);
            if query_revision
                .is_some_and(|revision| QUERY_REVISION.load(Ordering::Acquire) != revision)
            {
                return Ok(Vec::new());
            }
            result
        })?
    };
    if query_revision.is_some_and(|revision| QUERY_REVISION.load(Ordering::Acquire) != revision) {
        return Ok(Vec::new());
    }
    let mut indexed_results = indexed_results
        .into_iter()
        .filter_map(|result| {
            let quality = match_quality(&result.name, &result.path, &terms)?;
            Some((quality, result))
        })
        .collect::<Vec<_>>();
    indexed_results.extend(
        immediate_live_results(normalized, kind, extension, drive, roots)
            .into_iter()
            .filter_map(|result| {
                let quality = match_quality(&result.name, &result.path, &terms)?;
                Some((quality, result))
            }),
    );
    indexed_results.sort_by(|(left_quality, left), (right_quality, right)| {
        let kind_rank = |kind: &str| match kind {
            "app" => 0,
            "folder" => 1,
            _ => 2,
        };
        (
            kind_rank(&left.kind),
            left_quality,
            left.name.chars().count(),
            left.name.to_lowercase(),
        )
            .cmp(&(
                kind_rank(&right.kind),
                right_quality,
                right.name.chars().count(),
                right.name.to_lowercase(),
            ))
    });
    let mut seen_paths = application_results
        .iter()
        .map(|result| result.path.to_lowercase())
        .collect::<HashSet<_>>();
    application_results.extend(
        indexed_results
            .into_iter()
            .map(|(_, result)| result)
            .filter(|result| seen_paths.insert(result.path.to_lowercase())),
    );
    application_results.truncate(RESULT_LIMIT);
    Ok(application_results)
}
