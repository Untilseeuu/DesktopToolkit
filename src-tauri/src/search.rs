#[cfg(all(target_os = "windows", not(test)))]
use std::sync::OnceLock;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

use parking_lot::Mutex;
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
#[cfg(all(target_os = "windows", not(test)))]
static REGISTERED_APPS: OnceLock<Vec<RegisteredApp>> = OnceLock::new();

#[derive(Debug, Serialize)]
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
fn registered_apps() -> Vec<RegisteredApp> {
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
        .clone()
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn registered_apps() -> Vec<RegisteredApp> {
    Vec::new()
}

#[cfg(test)]
fn registered_apps() -> Vec<RegisteredApp> {
    Vec::new()
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
    let normalized_drive = drive.trim().to_lowercase();
    let mut results = apps
        .iter()
        .enumerate()
        .filter(|(_, app)| {
            !normalized.is_empty()
                && (app.name.to_lowercase().contains(&normalized)
                    || app.path.to_lowercase().contains(&normalized))
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
        (
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
    let name = entry.file_name().to_string_lossy().to_lowercase();
    !matches!(
        name.as_str(),
        "node_modules" | ".git" | "$recycle.bin" | "system volume information" | "winsxs"
    )
}

fn kind_for(path: &Path) -> &'static str {
    if path.is_dir() {
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
        return "[\"v5\",\"*\"]".to_string();
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
    roots.insert(0, "v5".to_string());
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

fn rebuild_inner(
    storage: &StorageManager,
    requested_roots: Vec<String>,
    revision: u64,
) -> Result<usize, String> {
    let scope = scope_key(&requested_roots);
    #[cfg(not(test))]
    let include_apps = include_application_roots(&requested_roots);
    storage.with_connection(|connection| {
        connection
            .execute(
                "
                INSERT INTO search_meta(id, scope, complete, updated_at)
                VALUES (1, ?1, 0, unixepoch())
                ON CONFLICT(id) DO UPDATE SET
                    scope = excluded.scope,
                    complete = 0,
                    updated_at = excluded.updated_at
                ",
                [&scope],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    })?;
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
    let mut staging = Connection::open(&staging_path).map_err(|error| error.to_string())?;
    staging
        .execute_batch(
            "
            PRAGMA journal_mode = OFF;
            PRAGMA synchronous = OFF;
            CREATE VIRTUAL TABLE search_fts USING fts5(
                name,
                path,
                kind UNINDEXED,
                modified_at UNINDEXED,
                tokenize = 'trigram'
            );
            ",
        )
        .map_err(|error| error.to_string())?;
    let transaction = staging.transaction().map_err(|error| error.to_string())?;
    let mut fts_statement = transaction
        .prepare(
            "INSERT INTO search_fts(name, path, kind, modified_at)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(|error| error.to_string())?;
    let mut count = 0usize;
    let mut indexed_paths = HashMap::new();

    for app in &system_apps {
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
        indexed_paths.insert(path_key, app.name.clone());
        fts_statement
            .execute(params![app.name, app.path, "app", Option::<u64>::None])
            .map_err(|error| error.to_string())?;
        count += 1;
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
            if kind_for(path) == "app" && is_noisy_application(path) {
                continue;
            }
            let display_path = display_path(path);
            let path_key = if cfg!(target_os = "windows") {
                display_path.to_lowercase()
            } else {
                display_path.clone()
            };
            if kind_for(path) == "app" && indexed_paths.contains_key(&path_key) {
                continue;
            }
            let name = if kind_for(path) == "app" {
                application_display_name(path)
            } else {
                entry.file_name().to_string_lossy().to_string()
            };
            if name.is_empty() {
                continue;
            }
            let modified_at = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs());
            let kind = kind_for(path);
            indexed_paths.insert(path_key, name.clone());
            fts_statement
                .execute(params![name, display_path, kind, modified_at])
                .map_err(|error| error.to_string())?;
            count += 1;
        }
    }
    drop(fts_statement);
    transaction.commit().map_err(|error| error.to_string())?;
    drop(staging);

    let staging_display = staging_path.to_string_lossy().to_string();
    let swap_result = storage.with_connection(|connection| {
        connection
            .execute("ATTACH DATABASE ?1 AS staging", [&staging_display])
            .map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM search_fts", [])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "
                INSERT INTO search_fts(rowid, name, path, kind, modified_at)
                SELECT rowid, name, path, kind, modified_at FROM staging.search_fts
                ",
                [],
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
        connection
            .execute_batch("DETACH DATABASE staging")
            .map_err(|error| error.to_string())?;
        Ok(count)
    });
    let _ = fs::remove_file(&staging_path);
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

pub fn query(
    storage: &StorageManager,
    query: &str,
    kind: &str,
    extension: &str,
    drive: &str,
    roots: &[String],
) -> Result<Vec<SearchResult>, String> {
    let normalized = query.trim();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let mut application_results = registered_app_results(
        &registered_apps(),
        normalized,
        kind,
        extension,
        drive,
        roots,
    );
    let pattern = format!("%{}%", normalized.replace('%', "\\%").replace('_', "\\_"));
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
    let indexed_results = storage.with_read_connection(|connection| {
        let order_clause = "
            ORDER BY
                CASE kind
                    WHEN 'app' THEN 0
                    WHEN 'folder' THEN 1
                    ELSE 2
                END,
                CASE
                    WHEN lower(name) = lower(?2) THEN 0
                    WHEN lower(name) LIKE lower(?2 || '%') THEN 1
                    ELSE 2
                END,
                length(name),
                name
            ";
        let sql = format!(
            "
            SELECT rowid, name, path, kind, modified_at
            FROM search_fts
            WHERE (name LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                OR path LIKE ?1 ESCAPE '\\' COLLATE NOCASE)
              AND (?3 = '' OR kind = ?3)
              AND (?4 = '' OR lower(name) LIKE ?4)
              AND (?5 = '' OR lower(path) LIKE ?5)
              AND (
                ?6 = ''
                OR EXISTS (
                  SELECT 1 FROM json_each(?6)
                  WHERE lower(replace(search_fts.path, '/', char(92))) = value
                     OR substr(
                          lower(replace(search_fts.path, '/', char(92))),
                          1,
                          length(value) + 1
                        )
                        = value || char(92)
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
            {order_clause}
            LIMIT 80
            "
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    pattern,
                    normalized,
                    kind,
                    extension_pattern,
                    drive_pattern,
                    root_filter
                ],
                |row| {
                    Ok(SearchResult {
                        id: format!("index-{}", row.get::<_, i64>(0)?),
                        name: row.get(1)?,
                        path: row.get(2)?,
                        kind: row.get(3)?,
                        modified_at: row.get(4)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })?;
    let mut seen_paths = application_results
        .iter()
        .map(|result| result.path.to_lowercase())
        .collect::<HashSet<_>>();
    application_results.extend(
        indexed_results
            .into_iter()
            .filter(|result| seen_paths.insert(result.path.to_lowercase())),
    );
    application_results.truncate(120);
    Ok(application_results)
}
