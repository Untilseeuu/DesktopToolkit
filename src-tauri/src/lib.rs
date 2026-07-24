mod domain;
mod launcher;
mod search;
mod storage;

#[cfg(test)]
mod domain_tests;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::BTreeMap,
    hash::{DefaultHasher, Hash, Hasher},
    io::Cursor,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use storage::StorageManager;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::{
        Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_CONTROL},
        WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow},
    },
};

type SharedStorage = Arc<StorageManager>;
static REGISTERED_SHORTCUTS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
#[cfg(target_os = "windows")]
static LAST_CLIPBOARD_TARGET: Mutex<Option<usize>> = Mutex::new(None);

pub(crate) fn supports_image_auto_paste(process_name: &str) -> bool {
    let lowered = process_name.trim().to_ascii_lowercase();
    let normalized = lowered.trim_end_matches(".exe");
    matches!(
        normalized,
        "winword"
            | "powerpnt"
            | "excel"
            | "outlook"
            | "onenote"
            | "chrome"
            | "msedge"
            | "firefox"
            | "wechat"
            | "weixin"
            | "qq"
            | "teams"
            | "slack"
            | "notion"
            | "obsidian"
            | "mspaint"
            | "photoshop"
    )
}

#[cfg(target_os = "windows")]
pub(crate) const fn background_process_creation_flags() -> u32 {
    0x0800_0000
}

#[cfg(not(target_os = "windows"))]
pub(crate) const fn background_process_creation_flags() -> u32 {
    0
}

pub(crate) fn background_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    command.creation_flags(background_process_creation_flags());
    command
}

fn clipboard_file_path(storage: &StorageManager, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("剪贴板图片路径无效".into());
    }
    Ok(storage.data_dir().join(relative_path))
}

fn image_fingerprint(image: &tauri::image::Image<'_>) -> String {
    let mut hasher = DefaultHasher::new();
    image.width().hash(&mut hasher);
    image.height().hash(&mut hasher);
    image.rgba().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn save_clipboard_image(
    storage: &StorageManager,
    image: &tauri::image::Image<'_>,
    id: &str,
    copied_at: u64,
    fingerprint: &str,
) -> Result<Value, String> {
    let relative = format!("clipboard-images/{id}.png");
    let path = clipboard_file_path(storage, &relative)?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法创建剪贴板图片目录".to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    image::save_buffer_with_format(
        &path,
        image.rgba(),
        image.width(),
        image.height(),
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|error| error.to_string())?;

    let rgba = image::RgbaImage::from_raw(image.width(), image.height(), image.rgba().to_vec())
        .ok_or_else(|| "剪贴板图片像素数据无效".to_string())?;
    let preview = image::DynamicImage::ImageRgba8(rgba).thumbnail(320, 180);
    let mut encoded = Cursor::new(Vec::new());
    preview
        .write_to(&mut encoded, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "id": id,
        "kind": "image",
        "imageFile": relative,
        "previewDataUrl": search::png_data_url(encoded.get_ref()),
        "width": image.width(),
        "height": image.height(),
        "fingerprint": fingerprint,
        "copiedAt": copied_at
    }))
}

fn cleanup_clipboard_images(storage: &StorageManager, entries: &[Value]) {
    let retained = entries
        .iter()
        .filter_map(|entry| entry.get("imageFile").and_then(Value::as_str))
        .filter_map(|relative| clipboard_file_path(storage, relative).ok())
        .collect::<std::collections::HashSet<_>>();
    let directory = storage.data_dir().join("clipboard-images");
    let Ok(files) = std::fs::read_dir(directory) else {
        return;
    };
    for file in files.flatten() {
        let path = file.path();
        if path.is_file() && !retained.contains(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardActivationResult {
    pasted: bool,
    kind: String,
    reason: Option<String>,
}

#[cfg(target_os = "windows")]
fn remember_clipboard_target() {
    let handle = unsafe { GetForegroundWindow() };
    *LAST_CLIPBOARD_TARGET.lock() = if handle.is_null() {
        None
    } else {
        Some(handle as usize)
    };
}

#[cfg(not(target_os = "windows"))]
fn remember_clipboard_target() {}

#[cfg(target_os = "windows")]
fn target_process_name(handle: usize) -> Option<String> {
    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(handle as _, &mut process_id);
    }
    if process_id == 0 || process_id == std::process::id() {
        return None;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 1024];
    let mut length = buffer.len() as u32;
    let succeeded =
        unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } != 0;
    unsafe {
        CloseHandle(process);
    }
    if !succeeded {
        return None;
    }
    Path::new(&String::from_utf16_lossy(&buffer[..length as usize]))
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

#[cfg(target_os = "windows")]
fn paste_to_remembered_target(kind: &str) -> ClipboardActivationResult {
    let Some(handle) = *LAST_CLIPBOARD_TARGET.lock() else {
        return ClipboardActivationResult {
            pasted: false,
            kind: kind.into(),
            reason: Some("未找到原输入窗口，内容已恢复到剪贴板".into()),
        };
    };
    let Some(process_name) = target_process_name(handle) else {
        return ClipboardActivationResult {
            pasted: false,
            kind: kind.into(),
            reason: Some("原窗口不可用，内容已恢复到剪贴板".into()),
        };
    };
    if kind == "image" && !supports_image_auto_paste(&process_name) {
        return ClipboardActivationResult {
            pasted: false,
            kind: kind.into(),
            reason: Some(format!(
                "{process_name} 未确认支持图片粘贴，图片已保留在剪贴板"
            )),
        };
    }
    if unsafe { SetForegroundWindow(handle as _) } == 0 {
        return ClipboardActivationResult {
            pasted: false,
            kind: kind.into(),
            reason: Some("无法恢复原输入窗口，内容已保留在剪贴板".into()),
        };
    }
    std::thread::sleep(std::time::Duration::from_millis(90));
    unsafe {
        keybd_event(VK_CONTROL as u8, 0, 0, 0);
        keybd_event(b'V', 0, 0, 0);
        keybd_event(b'V', 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
    }
    ClipboardActivationResult {
        pasted: true,
        kind: kind.into(),
        reason: None,
    }
}

#[cfg(not(target_os = "windows"))]
fn paste_to_remembered_target(kind: &str) -> ClipboardActivationResult {
    ClipboardActivationResult {
        pasted: false,
        kind: kind.into(),
        reason: Some("当前系统暂不支持自动粘贴，内容已恢复到剪贴板".into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ShortcutRegistrationDelta {
    unregister: Vec<String>,
    register: Vec<String>,
}

fn desired_shortcuts(snapshot: &Value) -> Result<BTreeMap<String, String>, String> {
    let mut desired: BTreeMap<String, String> = BTreeMap::new();
    for (tool, fallback) in [
        ("search", "Alt+Space"),
        ("prompts", "Alt+Shift+P"),
        ("clipboard", "Alt+Shift+V"),
    ] {
        let enabled = snapshot
            .pointer(&format!("/tools/{tool}/enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !enabled {
            continue;
        }
        let shortcut = snapshot
            .pointer(&format!("/settings/shortcuts/{tool}"))
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string();
        shortcut
            .parse::<Shortcut>()
            .map_err(|error| format!("快捷键 {shortcut} 无效：{error}"))?;
        if desired
            .values()
            .any(|value| value.eq_ignore_ascii_case(&shortcut))
        {
            return Err(format!("快捷键 {shortcut} 被多个工具重复使用"));
        }
        desired.insert(tool.to_string(), shortcut);
    }
    Ok(desired)
}

fn shortcut_registration_delta(
    actual: &BTreeMap<String, String>,
    snapshot: &Value,
) -> Result<ShortcutRegistrationDelta, String> {
    let desired = desired_shortcuts(snapshot)?;
    let unregister = actual
        .iter()
        .filter(|(tool, shortcut)| desired.get(*tool) != Some(*shortcut))
        .map(|(_, shortcut)| shortcut.clone())
        .collect();
    let register = desired
        .iter()
        .filter(|(tool, shortcut)| actual.get(*tool) != Some(*shortcut))
        .map(|(_, shortcut)| shortcut.clone())
        .collect();
    Ok(ShortcutRegistrationDelta {
        unregister,
        register,
    })
}

#[tauri::command]
fn load_snapshot(storage: State<'_, SharedStorage>) -> Result<Value, String> {
    storage.load_snapshot()
}

#[tauri::command]
fn get_data_directory(storage: State<'_, SharedStorage>) -> String {
    storage.data_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn save_snapshot(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    snapshot: Value,
) -> Result<bool, String> {
    let mut rebuild_roots: Option<(Vec<String>, bool)> = None;
    let mut changed_filters: Option<Value> = None;
    let mut rejected_runtime: Option<(Value, Value, String)> = None;
    let mut runtime_transition: Option<(Value, Value)> = None;
    let saved = storage.update_snapshot(|previous| {
        let previous_snapshot = previous.clone();
        let mut sanitized = snapshot;
        sanitized["startupItems"] = previous
            .get("startupItems")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        sanitized["startupFailures"] = previous
            .get("startupFailures")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        sanitized["clipboardHistory"] = previous
            .get("clipboardHistory")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let clipboard_limit = sanitized
            .pointer("/settings/clipboardLimit")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .clamp(1, 500) as usize;
        if let Some(entries) = sanitized["clipboardHistory"].as_array_mut() {
            entries.truncate(clipboard_limit);
        }
        sanitized["activity"] = previous
            .get("activity")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "searches": [], "copies": [] }));
        let search_turned_on = !previous
            .pointer("/tools/search/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
            && sanitized
                .pointer("/tools/search/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
        if previous.pointer("/settings/indexRoots") != sanitized.pointer("/settings/indexRoots")
            || search_turned_on
        {
            rebuild_roots = sanitized
                .pointer("/settings/indexRoots")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .map(|roots| (roots, !search_turned_on));
        }
        if previous.pointer("/settings/searchFilters")
            != sanitized.pointer("/settings/searchFilters")
        {
            changed_filters = sanitized.pointer("/settings/searchFilters").cloned();
        }
        if !previous.is_null() && domain::runtime_settings_changed(&previous_snapshot, &sanitized) {
            runtime_transition = Some((previous_snapshot, sanitized.clone()));
        }
        *previous = sanitized;
        Ok(true)
    })?;
    if let Some((previous, proposed)) = runtime_transition {
        if let Err(error) = apply_runtime_settings(&app, &previous, &proposed, false) {
            let proposed_tools = proposed
                .get("tools")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let proposed_shortcuts = proposed
                .pointer("/settings/shortcuts")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let mut message = format!("应用系统设置失败：{error}");
            message.push_str("；工具开关已保存，可在设置中重新配置冲突的系统功能");
            rejected_runtime = Some((proposed_tools, proposed_shortcuts, message));
        }
    }
    if let Some((roots, force)) = rebuild_roots {
        let storage_for_index = storage.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            if force || !search::has_index(&storage_for_index, &roots) {
                if roots.iter().any(|root| root == "*") {
                    let revision = search::revision();
                    let bootstrap_roots = search::bootstrap_roots();
                    if !bootstrap_roots.is_empty() {
                        let _ = search::rebuild(&storage_for_index, bootstrap_roots);
                        let _ =
                            search::rebuild_if_revision(&storage_for_index, roots, revision + 1);
                        return;
                    }
                }
                let _ = search::rebuild(&storage_for_index, roots);
            }
        });
    }
    if let Some(filters) = changed_filters {
        let _ = app.emit("atlas-search-filters", filters);
    }
    if let Some((tools, shortcuts, error)) = rejected_runtime {
        let _ = app.emit(
            "atlas-runtime-settings-rejected",
            serde_json::json!({ "tools": tools, "shortcuts": shortcuts, "error": error }),
        );
    }
    Ok(saved)
}

#[tauri::command]
async fn choose_startup_item(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
) -> Result<Option<launcher::StartupItem>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("应用程序", &["exe", "lnk", "appref-ms", "bat", "cmd"])
        .blocking_pick_file();
    let Some(path) = file.and_then(|value| value.into_path().ok()) else {
        return Ok(None);
    };
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名应用")
        .to_string();
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .to_string();
    let item = launcher::StartupItem {
        id: format!("startup-{id}"),
        name,
        path: path.to_string_lossy().to_string(),
        args: Vec::new(),
        working_directory: None,
        delay_seconds: 2,
        enabled: true,
        order: 0,
    };
    launcher::validate_startup_item(&item)?;
    storage.update_snapshot(|snapshot| {
        let mut items = launcher::items_from_snapshot(snapshot);
        let mut authorized = item.clone();
        authorized.order = items.len();
        items.push(authorized);
        snapshot["startupItems"] =
            serde_json::to_value(items).map_err(|error| error.to_string())?;
        Ok(())
    })?;
    Ok(Some(item))
}

#[tauri::command]
fn sync_startup_items(
    storage: State<'_, SharedStorage>,
    items: Vec<launcher::StartupItem>,
) -> Result<bool, String> {
    storage.update_snapshot(|snapshot| {
        let authorized = launcher::items_from_snapshot(snapshot)
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect::<std::collections::HashMap<_, _>>();
        for item in &items {
            let Some(original) = authorized.get(&item.id) else {
                return Err("检测到未经原生文件选择器授权的启动项".into());
            };
            if item.path != original.path
                || item.args != original.args
                || item.working_directory != original.working_directory
            {
                return Err("启动程序路径或参数不能由界面直接改写".into());
            }
        }
        snapshot["startupItems"] =
            serde_json::to_value(&items).map_err(|error| error.to_string())?;
        Ok(true)
    })
}

#[tauri::command]
fn clear_startup_failures(storage: State<'_, SharedStorage>) -> Result<bool, String> {
    storage.update_snapshot(|snapshot| {
        snapshot["startupFailures"] = serde_json::json!([]);
        Ok(true)
    })
}

#[tauri::command]
fn set_search_filters(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    filters: Value,
) -> Result<bool, String> {
    let event_filters = filters.clone();
    let saved = storage.update_snapshot(|snapshot| {
        snapshot["settings"]["searchFilters"] = filters;
        Ok(true)
    })?;
    let _ = app.emit("atlas-search-filters", event_filters);
    Ok(saved)
}

#[tauri::command]
fn record_activity(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    kind: String,
    detail: String,
) -> Result<bool, String> {
    let activity = storage.update_snapshot(|snapshot| {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64;
        match kind.as_str() {
            "search" => {
                if !snapshot["activity"]["searches"].is_array() {
                    snapshot["activity"]["searches"] = serde_json::json!([]);
                }
                let searches = snapshot["activity"]["searches"]
                    .as_array_mut()
                    .ok_or_else(|| "活动统计结构无效".to_string())?;
                searches.push(serde_json::json!({ "at": at, "query": detail }));
                if searches.len() > 200 {
                    searches.remove(0);
                }
            }
            "copy" => {
                if !snapshot["activity"]["copies"].is_array() {
                    snapshot["activity"]["copies"] = serde_json::json!([]);
                }
                let copies = snapshot["activity"]["copies"]
                    .as_array_mut()
                    .ok_or_else(|| "活动统计结构无效".to_string())?;
                copies.push(serde_json::json!({ "at": at, "source": detail }));
                if copies.len() > 200 {
                    copies.remove(0);
                }
            }
            _ => return Err("未知活动类型".into()),
        }
        Ok(snapshot["activity"].clone())
    })?;
    let _ = app.emit("atlas-activity-updated", activity);
    Ok(true)
}

#[tauri::command]
fn migrate_data_directory(
    storage: State<'_, SharedStorage>,
    target: String,
) -> Result<String, String> {
    storage
        .migrate(&PathBuf::from(target))
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn search_index(
    storage: State<'_, SharedStorage>,
    query: String,
    kind: String,
    extension: String,
    drive: String,
) -> Result<Vec<search::SearchResult>, String> {
    let snapshot = storage.load_snapshot()?;
    let enabled = snapshot
        .pointer("/tools/search/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return Err("全局搜索当前已暂停".into());
    }
    let roots = snapshot
        .pointer("/settings/indexRoots")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["*".into()]);
    search::query(&storage, &query, &kind, &extension, &drive, &roots)
}

#[tauri::command]
fn get_index_status() -> String {
    search::status().to_string()
}

#[tauri::command]
fn get_index_count(storage: State<'_, SharedStorage>) -> Result<usize, String> {
    search::count(&storage)
}

#[tauri::command]
async fn rebuild_search_index(
    storage: State<'_, SharedStorage>,
    roots: Vec<String>,
) -> Result<usize, String> {
    let storage = storage.inner().clone();
    if roots.iter().any(|root| root == "*") {
        let revision = search::revision();
        let bootstrap_roots = search::bootstrap_roots();
        if !bootstrap_roots.is_empty() {
            let storage_for_quick = storage.clone();
            let count = tauri::async_runtime::spawn_blocking(move || {
                search::rebuild(&storage_for_quick, bootstrap_roots)
            })
            .await
            .map_err(|error| error.to_string())??;
            tauri::async_runtime::spawn_blocking(move || {
                let _ = search::rebuild_if_revision(&storage, roots, revision + 1);
            });
            return Ok(count);
        }
    }
    tauri::async_runtime::spawn_blocking(move || search::rebuild(&storage, roots))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn launch_startup_items(
    storage: State<'_, SharedStorage>,
    item_ids: Vec<String>,
) -> Result<Vec<launcher::LaunchResult>, String> {
    let snapshot = storage.load_snapshot()?;
    let startup_enabled = snapshot
        .pointer("/tools/startup/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !startup_enabled {
        return Err("启动编排当前已暂停".into());
    }
    let allowed_ids = item_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let items = launcher::items_from_snapshot(&snapshot)
        .into_iter()
        .filter(|item| allowed_ids.contains(&item.id))
        .collect();
    let results = tauri::async_runtime::spawn_blocking(move || launcher::launch_queue(items))
        .await
        .map_err(|error| error.to_string())??;
    storage.update_snapshot(|snapshot| {
        snapshot["activity"]["startupLastRunAt"] = serde_json::json!(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis()
            as u64);
        Ok(())
    })?;
    Ok(results)
}

#[tauri::command]
fn open_target(path: String, reveal: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if path.starts_with(r"shell:AppsFolder\") {
        if reveal {
            return Err("系统应用没有可显示的文件位置".into());
        }
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if path.starts_with("https://")
        || path.starts_with("http://")
        || path.starts_with("microsoft-edge:https://")
        || path.starts_with("microsoft-edge:http://")
    {
        if reveal {
            return Err("网页链接没有文件位置".into());
        }
        return open::that_detached(path).map_err(|error| error.to_string());
    }
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("目标已不存在".into());
    }
    if reveal {
        #[cfg(target_os = "windows")]
        {
            let argument = format!("/select,{}", target.to_string_lossy());
            std::process::Command::new("explorer.exe")
                .arg(argument)
                .spawn()
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        #[cfg(not(target_os = "windows"))]
        {
            let parent = target.parent().unwrap_or(&target);
            open::that_detached(parent).map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    open::that_detached(target).map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_overlay(app: AppHandle, mode: String) -> Result<bool, String> {
    let label = match mode.as_str() {
        "search" => "search-overlay",
        "prompts" => "prompts-overlay",
        "clipboard" => "clipboard-overlay",
        _ => return Err("未知的快捷窗口".into()),
    };
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| "快捷窗口不存在".to_string())?;
    window.hide().map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn load_app_icons(
    storage: State<'_, SharedStorage>,
    paths: Vec<String>,
) -> Result<BTreeMap<String, String>, String> {
    let unique_paths = paths
        .into_iter()
        .filter(|path| {
            path.starts_with(r"shell:AppsFolder\")
                || PathBuf::from(path).extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("exe")
                        || extension.eq_ignore_ascii_case("lnk")
                        || extension.eq_ignore_ascii_case("appref-ms")
                })
        })
        .take(24)
        .collect::<std::collections::BTreeSet<_>>();
    if unique_paths.is_empty() {
        return Ok(BTreeMap::new());
    }
    let cache_dir = storage.data_dir().join("icon-cache");
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let destinations = unique_paths
        .iter()
        .map(|path| {
            let mut hasher = DefaultHasher::new();
            path.to_lowercase().hash(&mut hasher);
            (
                path.clone(),
                cache_dir.join(format!("{:016x}.png", hasher.finish())),
            )
        })
        .collect::<Vec<_>>();

    #[cfg(target_os = "windows")]
    {
        let missing = destinations
            .iter()
            .filter(|(_, destination)| !destination.is_file())
            .map(|(source, destination)| {
                serde_json::json!({
                    "source": source,
                    "destination": destination.to_string_lossy()
                })
            })
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$requests = ConvertFrom-Json $env:ATLAS_ICON_REQUESTS
foreach ($request in @($requests)) {
  $source = [string]$request.source
  $destination = [string]$request.destination
  if (Test-Path -LiteralPath $destination) { continue }
  try {
    if ($source.StartsWith('shell:AppsFolder\')) {
      $aumid = $source.Substring('shell:AppsFolder\'.Length)
      $separator = $aumid.IndexOf('!')
      if ($separator -lt 1) { continue }
      $family = $aumid.Substring(0, $separator)
      $appId = $aumid.Substring($separator + 1)
      $package = Get-AppxPackage | Where-Object PackageFamilyName -eq $family | Select-Object -First 1
      if (-not $package) { continue }
      $manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
      [xml]$manifest = Get-Content -LiteralPath $manifestPath
      $application = $manifest.SelectSingleNode("//*[local-name()='Application' and @Id='$appId']")
      $visual = $application.SelectSingleNode("./*[local-name()='VisualElements']")
      $logo = [string]$visual.Square44x44Logo
      if (-not $logo) { $logo = [string]$visual.Square150x150Logo }
      if (-not $logo) { continue }
      $logoPath = Join-Path $package.InstallLocation $logo
      if (Test-Path -LiteralPath $logoPath) {
        Copy-Item -LiteralPath $logoPath -Destination $destination
        continue
      }
      $logoDirectory = Split-Path $logoPath
      $logoStem = [IO.Path]::GetFileNameWithoutExtension($logoPath)
      $candidate = Get-ChildItem -LiteralPath $logoDirectory -Filter "$logoStem*.png" |
        Sort-Object Length -Descending | Select-Object -First 1
      if ($candidate) { Copy-Item -LiteralPath $candidate.FullName -Destination $destination }
    } elseif (Test-Path -LiteralPath $source) {
      $icon = [Drawing.Icon]::ExtractAssociatedIcon($source)
      if ($icon) {
        $bitmap = $icon.ToBitmap()
        $bitmap.Save($destination, [Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
        $icon.Dispose()
      }
    }
  } catch {}
}
"#;
            let requests = serde_json::to_string(&missing).map_err(|error| error.to_string())?;
            let _ = background_command("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
                .env("ATLAS_ICON_REQUESTS", requests)
                .output();
        }
    }

    Ok(destinations
        .into_iter()
        .filter_map(|(source, destination)| {
            let bytes = std::fs::read(destination).ok()?;
            if bytes.is_empty() {
                return None;
            }
            Some((source, search::png_data_url(&bytes)))
        })
        .collect())
}

fn reconcile_shortcuts(app: &AppHandle, snapshot: &Value) -> Result<(), String> {
    let actual = REGISTERED_SHORTCUTS.lock().clone();
    let desired = desired_shortcuts(snapshot)?;
    let delta = shortcut_registration_delta(&actual, snapshot)?;

    for shortcut in &delta.unregister {
        app.global_shortcut()
            .unregister(shortcut.as_str())
            .map_err(|error| format!("注销快捷键 {shortcut} 失败：{error}"))?;
        REGISTERED_SHORTCUTS
            .lock()
            .retain(|_, registered| registered != shortcut);
    }

    for shortcut in &delta.register {
        app.global_shortcut()
            .register(shortcut.as_str())
            .map_err(|error| format!("注册快捷键 {shortcut} 失败：{error}"))?;
        if let Some((tool, _)) = desired
            .iter()
            .find(|(_, configured)| *configured == shortcut)
        {
            REGISTERED_SHORTCUTS
                .lock()
                .insert(tool.clone(), shortcut.clone());
        }
    }
    Ok(())
}

fn apply_runtime_settings(
    app: &AppHandle,
    previous: &Value,
    snapshot: &Value,
    force: bool,
) -> Result<(), String> {
    let startup_enabled = snapshot
        .pointer("/tools/startup/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let previous_startup = previous
        .pointer("/tools/startup/enabled")
        .and_then(Value::as_bool);
    let autostart_error = if force || previous_startup != Some(startup_enabled) {
        let result = if startup_enabled {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        result.err().map(|error| error.to_string())
    } else {
        None
    };

    let shortcuts_changed = force
        || [
            "/tools/search/enabled",
            "/tools/prompts/enabled",
            "/tools/clipboard/enabled",
            "/settings/shortcuts/search",
            "/settings/shortcuts/prompts",
            "/settings/shortcuts/clipboard",
        ]
        .iter()
        .any(|pointer| previous.pointer(pointer) != snapshot.pointer(pointer));
    if shortcuts_changed {
        reconcile_shortcuts(app, snapshot)?;
    }
    for (tool, label) in [
        ("search", "search-overlay"),
        ("prompts", "prompts-overlay"),
        ("clipboard", "clipboard-overlay"),
    ] {
        let enabled = snapshot
            .pointer(&format!("/tools/{tool}/enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !enabled {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.hide();
            }
        }
    }
    if let Some(error) = autostart_error {
        return Err(error);
    }
    Ok(())
}

fn show_quick_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let visible = window.is_visible().unwrap_or(false);
        if visible && window.is_focused().unwrap_or(false) {
            let _ = window.hide();
        } else {
            if label == "clipboard-overlay" {
                remember_clipboard_target();
            }
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit_to(label, "atlas-overlay-focus", ());
        }
    }
}

#[tauri::command]
fn activate_clipboard_entry(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    id: String,
    paste_to_target: bool,
) -> Result<ClipboardActivationResult, String> {
    let snapshot = storage.load_snapshot()?;
    let entry = snapshot
        .get("clipboardHistory")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id.as_str()))
        })
        .ok_or_else(|| "这条剪贴板记录已不存在".to_string())?;
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if entry.get("imageFile").is_some() {
                "image"
            } else {
                "text"
            }
        });
    if kind == "image" {
        let relative = entry
            .get("imageFile")
            .and_then(Value::as_str)
            .ok_or_else(|| "剪贴板图片记录不完整".to_string())?;
        let path = clipboard_file_path(&storage, relative)?;
        let image = tauri::image::Image::from_path(path).map_err(|error| error.to_string())?;
        app.clipboard()
            .write_image(&image)
            .map_err(|error| error.to_string())?;
    } else {
        let text = entry
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| "剪贴板文字记录不完整".to_string())?;
        app.clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())?;
    }
    if !paste_to_target {
        return Ok(ClipboardActivationResult {
            pasted: false,
            kind: kind.into(),
            reason: None,
        });
    }
    if let Some(window) = app.get_webview_window("clipboard-overlay") {
        let _ = window.hide();
    }
    Ok(paste_to_remembered_target(kind))
}

fn shortcut_target(snapshot: &Value, shortcut: &Shortcut) -> Option<&'static str> {
    for (tool, label, fallback) in [
        ("search", "search-overlay", "Alt+Space"),
        ("prompts", "prompts-overlay", "Alt+Shift+P"),
        ("clipboard", "clipboard-overlay", "Alt+Shift+V"),
    ] {
        let enabled = snapshot
            .pointer(&format!("/tools/{tool}/enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let configured = snapshot
            .pointer(&format!("/settings/shortcuts/{tool}"))
            .and_then(Value::as_str)
            .unwrap_or(fallback);
        if enabled {
            if let Ok(configured_shortcut) = configured.parse::<Shortcut>() {
                if configured_shortcut == *shortcut {
                    return Some(label);
                }
            }
        }
    }
    None
}

fn start_clipboard_monitor(app: AppHandle, storage: SharedStorage) {
    std::thread::spawn(move || {
        let mut last_seen = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            enum ClipboardContent {
                Image(tauri::image::Image<'static>, String),
                Text(String),
            }
            let content = match app.clipboard().read_image() {
                Ok(image) => {
                    let image = image.to_owned();
                    let fingerprint = image_fingerprint(&image);
                    ClipboardContent::Image(image, fingerprint)
                }
                Err(_) => {
                    let Ok(text) = app.clipboard().read_text() else {
                        continue;
                    };
                    let text = text.trim().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    ClipboardContent::Text(text)
                }
            };
            let marker = match &content {
                ClipboardContent::Image(_, fingerprint) => format!("image:{fingerprint}"),
                ClipboardContent::Text(text) => format!("text:{text}"),
            };
            if marker == last_seen {
                continue;
            }
            last_seen = marker;
            let update = storage.update_snapshot(|snapshot| {
                let enabled = snapshot
                    .pointer("/tools/clipboard/enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                if !enabled {
                    return Ok(None);
                }
                let limit = snapshot
                    .pointer("/settings/clipboardLimit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 500) as usize;
                let copied_at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|error| error.to_string())?
                    .as_millis() as u64;
                let mut entries = snapshot
                    .get("clipboardHistory")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let new_entry = match &content {
                    ClipboardContent::Text(text) => {
                        entries.retain(|entry| {
                            entry.get("text").and_then(Value::as_str) != Some(text.as_str())
                                || entry.get("imageFile").is_some()
                        });
                        serde_json::json!({
                            "id": format!("clip-{copied_at}"),
                            "kind": "text",
                            "text": text,
                            "copiedAt": copied_at
                        })
                    }
                    ClipboardContent::Image(image, fingerprint) => {
                        if let Some(position) = entries.iter().position(|entry| {
                            entry.get("fingerprint").and_then(Value::as_str)
                                == Some(fingerprint.as_str())
                        }) {
                            entries.remove(position)
                        } else {
                            save_clipboard_image(
                                &storage,
                                image,
                                &format!("clip-{copied_at}"),
                                copied_at,
                                fingerprint,
                            )?
                        }
                    }
                };
                entries.insert(0, new_entry);
                entries.truncate(limit);
                snapshot["clipboardHistory"] = Value::Array(entries.clone());
                Ok(Some(entries))
            });
            if let Ok(Some(entries)) = update {
                cleanup_clipboard_images(&storage, &entries);
                let _ = app.emit("atlas-clipboard-history", entries);
            }
        }
    });
}

pub fn run() {
    let storage =
        Arc::new(StorageManager::initialize().expect("failed to initialize Atlas storage"));
    let startup_snapshot = storage.load_snapshot().unwrap_or(Value::Null);
    let launched_from_autostart = std::env::args().any(|argument| argument == "--autostart");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let storage = app.state::<SharedStorage>();
                    if let Ok(snapshot) = storage.load_snapshot() {
                        if let Some(label) = shortcut_target(&snapshot, shortcut) {
                            show_quick_window(app, label);
                        }
                    }
                })
                .build(),
        )
        .manage(storage.clone())
        .setup(move |app| {
            let open_item = MenuItem::with_id(app, "open", "打开 Atlas", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Atlas", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Atlas Desktop Toolkit")
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Err(error) =
                apply_runtime_settings(app.handle(), &Value::Null, &startup_snapshot, true)
            {
                eprintln!("failed to apply Atlas runtime settings: {error}");
            }
            start_clipboard_monitor(app.handle().clone(), storage.clone());
            if launched_from_autostart {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                let startup_enabled = startup_snapshot
                    .pointer("/tools/startup/enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                if startup_enabled {
                    let items = launcher::items_from_snapshot(&startup_snapshot);
                    let storage_for_queue = storage.clone();
                    let app_for_queue = app.handle().clone();
                    std::thread::spawn(move || match launcher::launch_queue(items) {
                        Ok(results) => {
                            let failures = results
                                .into_iter()
                                .filter(|result| !result.success)
                                .collect::<Vec<_>>();
                            for failure in &failures {
                                eprintln!(
                                    "failed to launch {}: {}",
                                    failure.name,
                                    failure.error.as_deref().unwrap_or("unknown error")
                                );
                            }
                            let _ = storage_for_queue.update_snapshot(|snapshot| {
                                snapshot["startupFailures"] =
                                    serde_json::to_value(&failures).unwrap_or_default();
                                snapshot["activity"]["startupLastRunAt"] =
                                    serde_json::json!(SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .map_err(|error| error.to_string())?
                                        .as_millis()
                                        as u64);
                                Ok(())
                            });
                            let _ = app_for_queue.emit("atlas-startup-results", failures);
                        }
                        Err(error) => {
                            eprintln!("failed to run Atlas startup queue: {error}");
                        }
                    });
                }
            }
            let search_enabled = startup_snapshot
                .pointer("/tools/search/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let index_roots = startup_snapshot
                .pointer("/settings/indexRoots")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| vec!["*".into()]);
            if search_enabled && !search::has_index(&storage, &index_roots) {
                let storage_for_index = storage.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if index_roots.iter().any(|root| root == "*") {
                        let revision = search::revision();
                        let bootstrap_roots = search::bootstrap_roots();
                        if !bootstrap_roots.is_empty() {
                            let _ = search::rebuild(&storage_for_index, bootstrap_roots);
                            let _ = search::rebuild_if_revision(
                                &storage_for_index,
                                index_roots,
                                revision + 1,
                            );
                            return;
                        }
                    }
                    let _ = search::rebuild(&storage_for_index, index_roots);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(false) if window.label() != "main" => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            get_data_directory,
            save_snapshot,
            choose_startup_item,
            sync_startup_items,
            clear_startup_failures,
            set_search_filters,
            record_activity,
            migrate_data_directory,
            search_index,
            get_index_status,
            get_index_count,
            rebuild_search_index,
            launch_startup_items,
            open_target,
            hide_overlay,
            activate_clipboard_entry,
            load_app_icons
        ])
        .run(tauri::generate_context!())
        .expect("error while running Atlas desktop toolkit");
}
