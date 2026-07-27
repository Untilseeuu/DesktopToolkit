#[cfg(all(target_os = "windows", not(test)))]
use std::sync::OnceLock;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(all(target_os = "windows", not(test)))]
use windows_sys::Win32::System::Threading::{
    GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END,
};

use parking_lot::Mutex;
use pinyin::ToPinyin;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use walkdir::{DirEntry, WalkDir};

use crate::storage::StorageManager;

struct IndexState {
    status: u8,
    running: bool,
    pending: Option<Vec<String>>,
}

static INDEX_STATE: Mutex<IndexState> = Mutex::new(IndexState {
    status: 0,
    running: false,
    pending: None,
});
static INDEX_REVISION: AtomicU64 = AtomicU64::new(0);
static QUERY_REVISION: AtomicU64 = AtomicU64::new(0);
static LAST_QUERY_AT_MS: AtomicU64 = AtomicU64::new(0);
static QUERY_GATE: Mutex<()> = Mutex::new(());
static ROOT_FOLDER_CACHE: Mutex<RootFolderCache> = Mutex::new(RootFolderCache {
    scope: String::new(),
    refreshed_at: None,
    folders: Vec::new(),
});
#[cfg(all(target_os = "windows", not(test)))]
static REGISTERED_APPS: OnceLock<Vec<RegisteredApp>> = OnceLock::new();

const INDEXED_NAME_SEPARATOR: char = '\u{1f}';
const RESULT_LIMIT: usize = 120;
const CANDIDATE_LIMIT: usize = 320;
const ROOT_FOLDER_CACHE_TTL: Duration = Duration::from_secs(5);
#[cfg(not(test))]
const INTERACTIVE_QUERY_GRACE_MS: u64 = 1_500;

struct RootFolderCache {
    scope: String,
    refreshed_at: Option<Instant>,
    folders: Vec<SearchResult>,
}

#[cfg(all(target_os = "windows", not(test)))]
struct BackgroundIndexPriority(bool);

#[cfg(all(target_os = "windows", not(test)))]
impl BackgroundIndexPriority {
    fn begin() -> Self {
        let changed =
            unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) } != 0;
        Self(changed)
    }
}

#[cfg(all(target_os = "windows", not(test)))]
impl Drop for BackgroundIndexPriority {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END);
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
        let multiplier = if since_query < INTERACTIVE_QUERY_GRACE_MS {
            5
        } else {
            1
        };
        let pause_ms = (work_time.as_millis() as u64)
            .saturating_mul(multiplier)
            .clamp(2, 250);
        std::thread::sleep(Duration::from_millis(pause_ms));
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
    let mut aliases = pinyin_aliases(name);
    let mut fuzzy_sources = vec![name.to_string()];
    if matches!(kind, "app" | "folder") || name.chars().any(|character| !character.is_ascii()) {
        fuzzy_sources.extend(aliases.iter().cloned());
    }
    for source in fuzzy_sources {
        aliases.extend(fuzzy_bigram_tokens(&source));
    }
    if aliases.is_empty() {
        name.to_string()
    } else {
        format!("{name}{INDEXED_NAME_SEPARATOR}{}", aliases.join("\u{1f}"))
    }
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

fn immediate_folder_results(
    query: &str,
    kind: &str,
    extension: &str,
    drive: &str,
    requested_roots: &[String],
) -> Vec<SearchResult> {
    if (!kind.trim().is_empty() && kind != "folder") || !extension.trim().is_empty() {
        return Vec::new();
    }
    let scope = if include_application_roots(requested_roots) {
        "*".to_string()
    } else {
        requested_roots.join("\u{1f}")
    };
    let now = Instant::now();
    let cached = {
        let cache = ROOT_FOLDER_CACHE.lock();
        (cache.scope == scope
            && cache
                .refreshed_at
                .is_some_and(|refreshed| now.duration_since(refreshed) < ROOT_FOLDER_CACHE_TTL))
        .then(|| cache.folders.clone())
    };
    let folders = cached.unwrap_or_else(|| {
        let roots = if include_application_roots(requested_roots) {
            #[cfg(test)]
            {
                Vec::new()
            }
            #[cfg(not(test))]
            {
                default_roots()
            }
        } else {
            requested_roots.iter().map(PathBuf::from).collect()
        };
        let mut seen = HashSet::new();
        let mut folders = Vec::new();
        for root in roots {
            let candidates = std::iter::once(root.clone()).chain(
                fs::read_dir(&root)
                    .into_iter()
                    .flatten()
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        entry
                            .file_type()
                            .ok()
                            .filter(|file_type| file_type.is_dir())
                            .map(|_| entry.path())
                    }),
            );
            for path in candidates {
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
                folders.push(SearchResult {
                    id: format!("live-folder-{}", folders.len()),
                    name,
                    path: display,
                    kind: "folder".into(),
                    modified_at: None,
                });
            }
        }
        let mut cache = ROOT_FOLDER_CACHE.lock();
        cache.scope = scope;
        cache.refreshed_at = Some(now);
        cache.folders = folders.clone();
        folders
    });
    let terms = expanded_search_terms(query);
    let normalized_drive = drive.trim().to_lowercase();
    let mut matches = folders
        .into_iter()
        .filter(|result| {
            normalized_drive.is_empty() || result.path.to_lowercase().starts_with(&normalized_drive)
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
        .take(64)
        .map(|(_, result)| result)
        .collect()
}

fn normalized_scope_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
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

fn should_descend(entry: &DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    ![
        "node_modules",
        ".git",
        "$recycle.bin",
        "system volume information",
        "winsxs",
    ]
    .iter()
    .any(|excluded| name.eq_ignore_ascii_case(excluded))
}

fn kind_for_entry(entry: &DirEntry) -> &'static str {
    if entry.file_type().is_dir() {
        "folder"
    } else if matches!(
        entry
            .path()
            .extension()
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

pub fn png_data_url(bytes: &[u8]) -> String {
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
    format!("data:image/png;base64,{encoded}")
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

pub fn bootstrap_roots_from(home: &Path, roaming: &Path, program_data: &Path) -> Vec<PathBuf> {
    vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
        roaming.join("Microsoft").join("Windows").join("Start Menu"),
        program_data
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu"),
    ]
}

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

pub fn bootstrap_roots() -> Vec<String> {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default();
    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let program_data = std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut roots = bootstrap_roots_from(&home, &roaming, &program_data);
    roots.extend(application_roots());
    distinct_roots(roots)
        .into_iter()
        .filter(|root| root.is_dir())
        .map(|root| root.to_string_lossy().to_string())
        .collect()
}

fn distinct_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut normalized = roots
        .into_iter()
        .filter(|root| root.exists())
        .map(|root| root.canonicalize().unwrap_or(root))
        .collect::<Vec<_>>();
    normalized.sort_by_key(|root| root.components().count());
    let mut distinct = Vec::<PathBuf>::new();
    for root in normalized {
        if !distinct.iter().any(|parent| root.starts_with(parent)) {
            distinct.push(root);
        }
    }
    distinct
}

fn scope_key(requested_roots: &[String]) -> String {
    if requested_roots.is_empty() || requested_roots.iter().any(|root| root == "*") {
        return "[\"v8\",\"*\"]".to_string();
    }
    let mut roots = distinct_roots(requested_roots.iter().map(PathBuf::from).collect())
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
    roots.insert(0, "v8".to_string());
    serde_json::to_string(&roots).unwrap_or_else(|_| "[]".to_string())
}

pub fn revision() -> u64 {
    INDEX_REVISION.load(Ordering::Acquire)
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
        if state.running {
            state.pending = Some(requested_roots);
            return Ok(0);
        }
        state.running = true;
        state.status = 1;
    }

    let mut roots = requested_roots;
    let mut active_revision = revision;
    loop {
        let result = rebuild_inner(storage, roots, active_revision);
        let mut state = INDEX_STATE.lock();
        if let Some(pending) = state.pending.take() {
            roots = pending;
            active_revision = INDEX_REVISION.load(Ordering::Acquire);
            drop(state);
            continue;
        }
        state.running = false;
        state.status = if result.is_ok() { 2 } else { 3 };
        return result;
    }
}

const INDEX_BATCH_SIZE: usize = 2_048;
const INDEX_COPY_BATCH_SIZE: usize = 16_384;

struct StagingFileGuard(PathBuf);

impl Drop for StagingFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn flush_index_batch(
    connection: &mut Connection,
    records: &mut Vec<(String, String, &'static str)>,
) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO search_entries(name, path, kind, modified_at)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|error| error.to_string())?;
        for (name, path, kind) in records.drain(..) {
            statement
                .execute(params![name, path, kind, Option::<u64>::None])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
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
    let staging_path = storage.data_dir().join("search-index-staging.db");
    if staging_path.exists() {
        fs::remove_file(&staging_path).map_err(|error| error.to_string())?;
    }
    let _staging_guard = StagingFileGuard(staging_path.clone());
    let mut staging = Connection::open(&staging_path).map_err(|error| error.to_string())?;
    staging
        .execute_batch(
            "
            PRAGMA journal_mode = OFF;
            PRAGMA synchronous = OFF;
            PRAGMA temp_store = FILE;
            PRAGMA cache_size = -8192;
            PRAGMA mmap_size = 0;
            CREATE TABLE search_entries(
                rowid INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                kind TEXT NOT NULL,
                modified_at INTEGER
            );
            ",
        )
        .map_err(|error| error.to_string())?;
    let mut batch = Vec::with_capacity(INDEX_BATCH_SIZE);
    let mut count = 0usize;
    let mut indexed_app_paths = HashSet::new();

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
            flush_index_batch(&mut staging, &mut batch)?;
            yield_indexer_to_interactive_work(&mut throttle);
            if INDEX_REVISION.load(Ordering::Acquire) != revision {
                return Err("索引范围已更新，正在切换到最新目录".into());
            }
        }
    }

    for root in roots {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(should_descend)
            .filter_map(Result::ok)
        {
            if INDEX_REVISION.load(Ordering::Acquire) != revision {
                return Err("索引范围已更新，正在切换到最新目录".into());
            }
            let path = entry.path();
            let kind = kind_for_entry(&entry);
            if kind == "app" && is_noisy_application(path) {
                continue;
            }
            let display_path = display_path(path);
            let path_key = if cfg!(target_os = "windows") {
                display_path.to_lowercase()
            } else {
                display_path.clone()
            };
            if kind == "app" && !indexed_app_paths.insert(path_key) {
                continue;
            }
            let name = if kind == "app" {
                application_display_name(path)
            } else {
                entry.file_name().to_string_lossy().to_string()
            };
            if name.is_empty() {
                continue;
            }
            // WalkDir already resolved the file type. Avoid another metadata
            // syscall for every item: modification time is optional in the UI,
            // while stat-ing millions of paths dominates a full-disk rebuild.
            batch.push((encode_indexed_name(&name, kind), display_path, kind));
            count += 1;
            if batch.len() >= INDEX_BATCH_SIZE {
                flush_index_batch(&mut staging, &mut batch)?;
                yield_indexer_to_interactive_work(&mut throttle);
                if INDEX_REVISION.load(Ordering::Acquire) != revision {
                    return Err("索引范围已更新，正在切换到最新目录".into());
                }
            }
        }
    }
    flush_index_batch(&mut staging, &mut batch)?;
    drop(staging);
    if INDEX_REVISION.load(Ordering::Acquire) != revision {
        return Err("索引范围已更新，正在切换到最新目录".into());
    }

    let staging_display = staging_path.to_string_lossy().to_string();
    let swap_result = storage.with_background_connection(|connection| {
        connection
            .execute("ATTACH DATABASE ?1 AS staging", [&staging_display])
            .map_err(|error| error.to_string())?;
        let operation = (|| -> Result<usize, String> {
            connection
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
                    ",
                )
                .map_err(|error| error.to_string())?;
            let mut copied = 0usize;
            while copied < count {
                if INDEX_REVISION.load(Ordering::Acquire) != revision {
                    return Err("索引范围已更新，正在切换到最新目录".into());
                }
                let transaction = connection
                    .transaction()
                    .map_err(|error| error.to_string())?;
                transaction
                    .execute(
                        "
                INSERT INTO search_fts_next(rowid, name, path, kind, modified_at)
                SELECT rowid, name, path, kind, modified_at
                        FROM staging.search_entries
                        WHERE rowid > ?1 AND rowid <= ?2
                        ",
                        params![copied, copied + INDEX_COPY_BATCH_SIZE],
                    )
                    .map_err(|error| error.to_string())?;
                transaction.commit().map_err(|error| error.to_string())?;
                copied += INDEX_COPY_BATCH_SIZE;
                yield_indexer_to_interactive_work(&mut throttle);
            }
            if INDEX_REVISION.load(Ordering::Acquire) != revision {
                return Err("索引范围已更新，正在切换到最新目录".into());
            }
            let transaction = connection
                .transaction()
                .map_err(|error| error.to_string())?;
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
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(count)
        })();
        let detach_result = connection
            .execute_batch("DETACH DATABASE staging")
            .map_err(|error| error.to_string());
        if operation.is_err() {
            let _ = connection.execute_batch("DROP TABLE IF EXISTS search_fts_next;");
        }
        operation.and(detach_result.map(|_| count))
    });
    swap_result
}

pub fn status() -> &'static str {
    match INDEX_STATE.lock().status {
        1 => "indexing",
        2 => "ready",
        3 => "failed",
        _ => "idle",
    }
}

pub fn has_index(storage: &StorageManager, requested_roots: &[String]) -> bool {
    let expected_scope = scope_key(requested_roots);
    let exists = storage
        .with_read_connection(|connection| {
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
                           WHERE id = 1 AND scope = ?2 AND complete = 1
                       )
                    ",
                    params![r"\\?\", expected_scope],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| error.to_string())
        })
        .unwrap_or(false);
    if exists {
        INDEX_STATE.lock().status = 2;
    }
    exists
}

pub fn count(storage: &StorageManager) -> Result<usize, String> {
    storage.with_read_connection(|connection| {
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
    expression: &str,
    kind: &str,
    extension_pattern: &str,
    drive_pattern: &str,
    root_filter: &str,
) -> Result<Vec<SearchResult>, String> {
    let mut statement = connection
        .prepare(
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
            ORDER BY
                CASE kind
                    WHEN 'app' THEN 0
                    WHEN 'folder' THEN 1
                    ELSE 2
                END,
                bm25(search_fts),
                length(name),
                name
            LIMIT ?6
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                expression,
                kind,
                extension_pattern,
                drive_pattern,
                root_filter,
                CANDIDATE_LIMIT as i64
            ],
            |row| {
                let indexed_name = row.get::<_, String>(1)?;
                Ok(SearchResult {
                    id: format!("index-{}", row.get::<_, i64>(0)?),
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
        storage.with_read_connection(|connection| {
            let exact = indexed_candidates(
                connection,
                exact_expression.as_deref().unwrap_or_default(),
                kind,
                &extension_pattern,
                &drive_pattern,
                &root_filter,
            )?;
            if !exact.is_empty() || fuzzy_expression == exact_expression {
                return Ok(exact);
            }
            indexed_candidates(
                connection,
                fuzzy_expression.as_deref().unwrap_or_default(),
                kind,
                &extension_pattern,
                &drive_pattern,
                &root_filter,
            )
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
        immediate_folder_results(normalized, kind, extension, drive, roots)
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
