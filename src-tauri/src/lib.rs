mod automation;
mod domain;
mod launcher;
mod ntfs;
mod runtime_log;
mod search;
mod storage;

#[cfg(test)]
mod domain_tests;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    hash::{DefaultHasher, Hash, Hasher},
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::Value;
use storage::StorageManager;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{Color, PageLoadEvent},
    AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        DataExchange::GetClipboardSequenceNumber,
        Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{
        Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_CONTROL},
        WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, MessageBoxW, SetForegroundWindow,
            MB_ICONERROR, MB_OK,
        },
    },
};

type SharedStorage = Arc<StorageManager>;
static REGISTERED_SHORTCUTS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
static RUNTIME_SHORTCUT_SNAPSHOT: RwLock<Value> = RwLock::new(Value::Null);
static RUNTIME_SEARCH_SNAPSHOT: RwLock<Value> = RwLock::new(Value::Null);
static SEARCH_CONFIG_GENERATION: AtomicU64 = AtomicU64::new(0);
static USER_REQUESTED_MAIN_WINDOW: AtomicBool = AtomicBool::new(false);
static SEARCH_CONFIG_GATE: Mutex<()> = Mutex::new(());
static CURRENT_QUICK_OVERLAY_MODE: Mutex<Option<String>> = Mutex::new(None);
#[cfg(target_os = "windows")]
static LAST_CLIPBOARD_TARGET: Mutex<Option<usize>> = Mutex::new(None);

#[derive(Default)]
struct ClipboardSequenceTracker {
    last_seen: Option<u32>,
    failing_sequence: Option<u32>,
    failed_attempts: u8,
}

impl ClipboardSequenceTracker {
    fn should_attempt(&self, sequence: Option<u32>) -> bool {
        sequence.is_none() || self.last_seen != sequence
    }

    fn commit(&mut self, sequence: Option<u32>) {
        if sequence.is_some() {
            self.last_seen = sequence;
        }
        self.failing_sequence = None;
        self.failed_attempts = 0;
    }

    fn record_failure(&mut self, sequence: Option<u32>) -> bool {
        let Some(sequence) = sequence else {
            return false;
        };
        if self.failing_sequence == Some(sequence) {
            self.failed_attempts = self.failed_attempts.saturating_add(1);
        } else {
            self.failing_sequence = Some(sequence);
            self.failed_attempts = 1;
        }
        if self.failed_attempts < 5 {
            return false;
        }
        self.commit(Some(sequence));
        true
    }
}

#[cfg(target_os = "windows")]
fn clipboard_sequence_number() -> Option<u32> {
    let sequence = unsafe { GetClipboardSequenceNumber() };
    (sequence != 0).then_some(sequence)
}

#[cfg(not(target_os = "windows"))]
fn clipboard_sequence_number() -> Option<u32> {
    None
}

pub(crate) fn startup_log_path_for_executable(executable: &Path) -> PathBuf {
    domain::default_data_directory(executable).join("atlas-startup.log")
}

fn append_startup_log(path: &Path, message: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    writeln!(file, "[{timestamp}] {message}").map_err(|error| error.to_string())
}

pub fn report_startup_failure(error: &str) {
    let preferred_log_path = std::env::current_exe()
        .map(|executable| startup_log_path_for_executable(&executable))
        .unwrap_or_else(|_| std::env::temp_dir().join("atlas-startup.log"));
    let log_path = match append_startup_log(&preferred_log_path, error) {
        Ok(()) => preferred_log_path,
        Err(write_error) => {
            let fallback = std::env::temp_dir().join("atlas-startup.log");
            let _ = append_startup_log(
                &fallback,
                &format!(
                    "{error}\n无法写入首选日志位置 {}：{write_error}",
                    preferred_log_path.display()
                ),
            );
            fallback
        }
    };
    let message = format!(
        "Atlas 启动失败。\n\n{error}\n\n诊断日志：{}",
        log_path.display()
    );
    eprintln!("{message}");
    #[cfg(target_os = "windows")]
    {
        let title = "Atlas Desktop Toolkit\0".encode_utf16().collect::<Vec<_>>();
        let body = format!("{message}\0").encode_utf16().collect::<Vec<_>>();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

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

fn normalized_process_name(process_name: &str) -> String {
    let lowered = process_name
        .trim()
        .trim_end_matches(|character: char| character.is_ascii_whitespace())
        .to_ascii_lowercase();
    lowered.trim_end_matches(".exe").to_string()
}

pub(crate) fn clipboard_capture_allowed(
    snapshot: &Value,
    foreground_process: Option<&str>,
) -> bool {
    if !snapshot
        .pointer("/tools/clipboard/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        || snapshot
            .pointer("/settings/clipboardCapturePaused")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return false;
    }
    let Some(foreground_process) = foreground_process else {
        // Privacy exclusions must fail closed when Windows cannot resolve the
        // active process. The next polling cycle can retry safely.
        return false;
    };
    let foreground = normalized_process_name(foreground_process);
    !snapshot
        .pointer("/settings/clipboardExcludedApps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|excluded| normalized_process_name(excluded) == foreground)
}

pub(crate) fn retain_recent_clipboard_entries(
    entries: Vec<Value>,
    now_ms: u64,
    retention_days: u64,
    limit: usize,
) -> Vec<Value> {
    let retention_ms = retention_days
        .clamp(1, 3650)
        .saturating_mul(24 * 60 * 60 * 1000);
    let cutoff = now_ms.saturating_sub(retention_ms);
    entries
        .into_iter()
        .filter(|entry| {
            entry
                .get("copiedAt")
                .and_then(Value::as_u64)
                .map(|copied_at| copied_at >= cutoff)
                .unwrap_or(true)
        })
        .take(limit.clamp(1, 500))
        .collect()
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

fn delete_clipboard_entry(storage: &StorageManager, id: &str) -> Result<Vec<Value>, String> {
    let mut removed_image = None;
    let entries = storage.update_snapshot(|snapshot| {
        let mut entries = snapshot
            .get("clipboardHistory")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        {
            removed_image = entry
                .get("imageFile")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        entries.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
        snapshot["clipboardHistory"] = Value::Array(entries.clone());
        Ok(entries)
    })?;
    if let Some(relative) = removed_image {
        if let Ok(path) = clipboard_file_path(storage, &relative) {
            if path.is_file() {
                if let Err(error) = std::fs::remove_file(path) {
                    eprintln!("failed to remove clipboard image after deleting history: {error}");
                }
            }
        }
    }
    cleanup_clipboard_images(storage, &entries);
    Ok(entries)
}

#[tauri::command]
fn delete_clipboard_history_entry(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    id: String,
) -> Result<Vec<Value>, String> {
    let entries = delete_clipboard_entry(&storage, &id)?;
    let _ = app.emit("atlas-clipboard-history", entries.clone());
    Ok(entries)
}

fn appearance_asset_path(storage: &StorageManager, candidate: &str) -> Result<PathBuf, String> {
    let root = storage.data_dir().join("appearance");
    let canonical_root = root.canonicalize().unwrap_or(root);
    let canonical = PathBuf::from(candidate)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("外观资源不在应用数据目录中".into());
    }
    Ok(canonical)
}

fn read_appearance_header(path: &Path) -> Result<[u8; 16], String> {
    let mut header = [0u8; 16];
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    file.read_exact(&mut header)
        .map_err(|error| format!("读取文件头失败：{error}"))?;
    Ok(header)
}

fn detected_image_extension(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if header.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn validate_appearance_file(path: &Path, font: bool) -> Result<(), String> {
    const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
    const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;
    let size = path.metadata().map_err(|error| error.to_string())?.len();
    let limit = if font {
        MAX_FONT_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
    if size == 0 || size > limit {
        return Err(format!(
            "{}文件必须小于 {} MB",
            if font { "字体" } else { "图片" },
            limit / 1024 / 1024
        ));
    }
    let header = read_appearance_header(path)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let valid = if font {
        match extension.as_str() {
            "ttf" => header.starts_with(&[0, 1, 0, 0]),
            "otf" => header.starts_with(b"OTTO"),
            "woff" => header.starts_with(b"wOFF"),
            "woff2" => header.starts_with(b"wOF2"),
            _ => false,
        }
    } else {
        detected_image_extension(&header).is_some()
    };
    if !valid {
        let signature = header[..12]
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ");
        return Err(format!(
            "所选文件不是有效的{}（扩展名 .{}，文件签名 {}）",
            if font { "字体" } else { "图片" },
            extension,
            signature
        ));
    }
    Ok(())
}

fn cleanup_appearance_assets(storage: &StorageManager, retained: &[PathBuf]) {
    let directory = storage.data_dir().join("appearance");
    let retained = retained
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let Ok(files) = std::fs::read_dir(directory) else {
        return;
    };
    for file in files.flatten() {
        let path = file.path();
        if path.is_file() && !retained.contains(&path) {
            if let Err(error) = std::fs::remove_file(&path) {
                eprintln!(
                    "failed to remove unused appearance asset {}: {error}",
                    path.display()
                );
            }
        }
    }
}

#[tauri::command]
fn import_appearance_asset(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    kind: String,
) -> Result<Option<String>, String> {
    let extensions: &[&str] = match kind.as_str() {
        "font" => &["ttf", "otf", "woff", "woff2"],
        "logo" | "avatar" | "background" => &["png", "jpg", "jpeg", "webp"],
        _ => return Err("不支持的外观资源类型".into()),
    };
    let selected = app
        .dialog()
        .file()
        .add_filter("支持的文件", extensions)
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok());
    let Some(source) = selected else {
        return Ok(None);
    };
    let selected_extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !extensions.contains(&selected_extension.as_str()) {
        return Err("所选文件格式不受支持".into());
    }
    validate_appearance_file(&source, kind == "font")?;
    let extension = if kind == "font" {
        selected_extension
    } else {
        let header = read_appearance_header(&source)?;
        detected_image_extension(&header)
            .ok_or_else(|| "所选文件不是有效的图片".to_string())?
            .to_string()
    };
    let directory = storage.data_dir().join("appearance");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let destination = directory.join(format!("{kind}-{nonce}.{extension}"));
    std::fs::copy(&source, &destination).map_err(|error| error.to_string())?;
    Ok(Some(destination.to_string_lossy().to_string()))
}

#[tauri::command]
fn load_appearance_asset(
    storage: State<'_, SharedStorage>,
    path: String,
) -> Result<String, String> {
    let path = appearance_asset_path(&storage, &path)?;
    validate_appearance_file(
        &path,
        matches!(
            path.extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "ttf" | "otf" | "woff" | "woff2"
        ),
    )?;
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    Ok(format!(
        "data:{mime};base64,{}",
        search::base64_encode(&bytes)
    ))
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
    if process_id == 0 {
        return None;
    }
    if process_id == std::process::id() {
        return std::env::current_exe().ok().and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        });
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
fn foreground_process_name() -> Option<String> {
    let handle = unsafe { GetForegroundWindow() };
    if handle.is_null() {
        None
    } else {
        target_process_name(handle as usize)
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_process_name() -> Option<String> {
    None
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

fn validate_global_shortcut(shortcut: &str) -> Result<(), String> {
    shortcut
        .parse::<Shortcut>()
        .map_err(|error| format!("快捷键 {shortcut} 无效：{error}"))?;
    let has_modifier = shortcut.split('+').any(|part| {
        matches!(
            part.trim().to_ascii_lowercase().as_str(),
            "ctrl" | "control" | "alt" | "shift" | "meta" | "super" | "cmd" | "command"
        )
    });
    if !has_modifier {
        return Err(format!("快捷键 {shortcut} 至少包含一个修饰键"));
    }
    Ok(())
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
        validate_global_shortcut(&shortcut)?;
        if desired
            .values()
            .any(|value| value.eq_ignore_ascii_case(&shortcut))
        {
            return Err(format!("快捷键 {shortcut} 被多个工具重复使用"));
        }
        desired.insert(tool.to_string(), shortcut);
    }
    let folders_enabled = snapshot
        .pointer("/tools/folders/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if folders_enabled {
        for favorite in snapshot
            .get("folderFavorites")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let shortcut = favorite
                .get("shortcut")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if shortcut.is_empty() {
                continue;
            }
            let id = favorite
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "文件夹收藏缺少标识".to_string())?;
            validate_global_shortcut(shortcut).map_err(|error| format!("文件夹{error}"))?;
            if desired
                .values()
                .any(|value| value.eq_ignore_ascii_case(shortcut))
            {
                return Err(format!("快捷键 {shortcut} 被多个功能重复使用"));
            }
            desired.insert(format!("folder:{id}"), shortcut.to_string());
        }
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
    let snapshot = storage.load_snapshot()?;
    if snapshot.is_null() {
        return Ok(serde_json::json!({
            "settings": { "indexSetup": "pending" }
        }));
    }
    Ok(snapshot)
}

pub(crate) fn index_setup_allows_background_build(
    snapshot: &Value,
    has_partial: bool,
    has_complete: bool,
) -> bool {
    if has_partial || has_complete {
        return true;
    }
    match snapshot
        .pointer("/settings/indexSetup")
        .and_then(Value::as_str)
    {
        Some("ready" | "pending") => true,
        Some("deferred") => false,
        Some(_) => false,
        None => true,
    }
}

fn mark_index_setup_ready(storage: &StorageManager) -> Result<(), String> {
    storage.update_snapshot(|snapshot| {
        if snapshot
            .pointer("/settings/indexSetup")
            .and_then(Value::as_str)
            != Some("ready")
        {
            snapshot["settings"]["indexSetup"] = Value::String("ready".into());
        }
        Ok(())
    })?;
    let snapshot = storage.load_snapshot()?;
    *RUNTIME_SHORTCUT_SNAPSHOT.write() =
        runtime_shortcut_snapshot_for_registered(&snapshot, &REGISTERED_SHORTCUTS.lock());
    Ok(())
}

#[tauri::command]
fn get_data_directory(storage: State<'_, SharedStorage>) -> String {
    storage.data_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn append_runtime_logs(
    storage: State<'_, SharedStorage>,
    lines: Vec<String>,
) -> Result<bool, String> {
    runtime_log::append_lines(&storage.data_dir(), &lines)?;
    Ok(true)
}

#[tauri::command]
fn open_runtime_log(storage: State<'_, SharedStorage>) -> Result<bool, String> {
    let path = runtime_log::append_lines(
        &storage.data_dir(),
        &["----- Atlas runtime log opened -----".into()],
    )?;
    open::that(&path).map_err(|error| format!("无法打开运行日志：{error}"))?;
    Ok(true)
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
    let mut retained_clipboard_entries = Vec::new();
    let mut retained_appearance_assets = Vec::new();
    let mut search_runtime_snapshot = None;
    let mut search_config_generation = SEARCH_CONFIG_GENERATION.load(Ordering::Acquire);
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
        let retention_days = sanitized
            .pointer("/settings/clipboardRetentionDays")
            .and_then(Value::as_u64)
            .unwrap_or(30);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64;
        let entries = sanitized["clipboardHistory"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        sanitized["clipboardHistory"] = Value::Array(retain_recent_clipboard_entries(
            entries,
            now_ms,
            retention_days,
            clipboard_limit,
        ));
        retained_clipboard_entries = sanitized["clipboardHistory"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        retained_appearance_assets = [
            "/settings/branding/logoPath",
            "/settings/branding/avatarPath",
            "/settings/branding/backgroundPath",
        ]
        .into_iter()
        .filter_map(|pointer| sanitized.pointer(pointer).and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect();
        retained_appearance_assets.extend(
            sanitized
                .pointer("/settings/customFonts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|font| font.get("path").and_then(Value::as_str))
                .map(PathBuf::from),
        );
        search_runtime_snapshot = Some(runtime_search_snapshot(&sanitized));
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
        if index_setup_allows_background_build(&sanitized, false, false)
            && (previous.pointer("/settings/indexRoots")
                != sanitized.pointer("/settings/indexRoots")
                || search_turned_on)
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
    let mut search_enabled_now = true;
    if let Some(snapshot) = search_runtime_snapshot {
        search_enabled_now = snapshot
            .pointer("/tools/search/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let _coordinator = SEARCH_CONFIG_GATE.lock();
        let mut current = RUNTIME_SEARCH_SNAPSHOT.write();
        if *current != snapshot {
            *current = snapshot;
            search_config_generation = SEARCH_CONFIG_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
        } else {
            search_config_generation = SEARCH_CONFIG_GENERATION.load(Ordering::Acquire);
        }
    }
    cleanup_clipboard_images(&storage, &retained_clipboard_entries);
    cleanup_appearance_assets(&storage, &retained_appearance_assets);
    if !search_enabled_now {
        search::stop_watchers();
        rebuild_roots = None;
    }
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
            let expected_revision = {
                let _coordinator = SEARCH_CONFIG_GATE.lock();
                if SEARCH_CONFIG_GENERATION.load(Ordering::Acquire) != search_config_generation {
                    return;
                }
                search::start_watchers(storage_for_index.clone(), roots.clone());
                search::revision()
            };
            if !force && search::has_index(&storage_for_index, &roots) {
                return;
            }
            let _ = search::rebuild_if_revision(&storage_for_index, roots, expected_revision);
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
    let _ = app.emit("atlas-snapshot-updated", ());
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
async fn search_index(
    storage: State<'_, SharedStorage>,
    query: String,
    kind: String,
    extension: String,
    drive: String,
) -> Result<Vec<search::SearchResult>, String> {
    let storage = storage.inner().clone();
    let (enabled, roots) = {
        let snapshot = RUNTIME_SEARCH_SNAPSHOT.read();
        let enabled = snapshot
            .pointer("/tools/search/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
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
        (enabled, roots)
    };
    if !enabled {
        return Err("全局搜索当前已暂停".into());
    }
    let query_revision = search::begin_query();
    tauri::async_runtime::spawn_blocking(move || {
        search::query_latest(
            &storage,
            &query,
            &kind,
            &extension,
            &drive,
            &roots,
            query_revision,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn get_index_status() -> String {
    search::status().to_string()
}

#[tauri::command]
fn get_index_progress() -> search::IndexProgress {
    search::progress()
}

#[tauri::command]
fn list_search_drives() -> Vec<String> {
    search::available_drives()
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
    if search::status() != "indexing" && search::has_index(&storage, &roots) {
        let watcher_roots = if search::has_full_disk_index(&storage) {
            vec!["*".to_string()]
        } else {
            roots
        };
        search::start_watchers(storage.clone(), watcher_roots);
        return search::count(&storage);
    }
    let watcher_storage = storage.clone();
    let watcher_roots = roots.clone();
    search::start_watchers(watcher_storage, watcher_roots);
    let count = tauri::async_runtime::spawn_blocking(move || search::rebuild(&storage, roots))
        .await
        .map_err(|error| error.to_string())??;
    Ok(count)
}

#[tauri::command]
async fn launch_startup_items(
    storage: State<'_, SharedStorage>,
    items: Vec<launcher::StartupItem>,
) -> Result<Vec<launcher::LaunchResult>, String> {
    let snapshot = storage.load_snapshot()?;
    let startup_enabled = snapshot
        .pointer("/tools/startup/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !startup_enabled {
        return Err("启动编排当前已暂停".into());
    }
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
async fn close_previous_startup_scene(
    previous_items: Vec<launcher::StartupItem>,
    next_items: Vec<launcher::StartupItem>,
) -> Result<Vec<launcher::CloseResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launcher::close_previous_scene(&previous_items, &next_items)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn capture_startup_scene_layout(
    items: Vec<launcher::StartupItem>,
) -> Result<launcher::SceneLayoutCapture, String> {
    tauri::async_runtime::spawn_blocking(move || launcher::capture_scene_layout(&items))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn restore_startup_scene_layout(
    layouts: Vec<launcher::SceneWindowLayout>,
) -> Result<Vec<launcher::RestoreResult>, String> {
    tauri::async_runtime::spawn_blocking(move || launcher::restore_scene_layout(&layouts))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_startup_scene_monitors() -> Result<Vec<launcher::MonitorDescriptor>, String> {
    tauri::async_runtime::spawn_blocking(launcher::list_scene_monitors)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_command_task(
    storage: State<'_, SharedStorage>,
    task: automation::CommandTask,
) -> Result<Vec<automation::CommandExecution>, String> {
    let snapshot = storage.load_snapshot()?;
    let enabled = snapshot
        .pointer("/tools/automation/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return Err("自动化命令工具已暂停".into());
    }
    tauri::async_runtime::spawn_blocking(move || automation::execute_task(&task))
        .await
        .map_err(|error| error.to_string())?
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
    quick_overlay_spec(&format!("{mode}-overlay")).ok_or_else(|| "未知的快捷窗口".to_string())?;
    let window = app
        .get_webview_window("quick-overlay")
        .ok_or_else(|| "快捷窗口不存在".to_string())?;
    window.hide().map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn quit_application(app: AppHandle) {
    search::cancel_indexing();
    search::stop_watchers();
    app.exit(0);
}

#[tauri::command]
fn get_quick_overlay_mode() -> Option<String> {
    CURRENT_QUICK_OVERLAY_MODE.lock().clone()
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
    let desired = match desired_shortcuts(snapshot) {
        Ok(desired) => desired,
        Err(error) => {
            *RUNTIME_SHORTCUT_SNAPSHOT.write() =
                runtime_shortcut_snapshot_for_registered(snapshot, &actual);
            return Err(error);
        }
    };
    let delta = shortcut_registration_delta(&actual, snapshot)?;
    let mut unregistered: Vec<String> = Vec::new();
    let mut newly_registered: Vec<String> = Vec::new();

    for shortcut in &delta.unregister {
        if let Err(error) = app.global_shortcut().unregister(shortcut.as_str()) {
            for previous in &unregistered {
                let _ = app.global_shortcut().register(previous.as_str());
            }
            *RUNTIME_SHORTCUT_SNAPSHOT.write() =
                runtime_shortcut_snapshot_for_registered(snapshot, &actual);
            return Err(format!("注销快捷键 {shortcut} 失败：{error}"));
        }
        unregistered.push(shortcut.clone());
    }

    for shortcut in &delta.register {
        if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
            for registered in newly_registered.iter().rev() {
                let _ = app.global_shortcut().unregister(registered.as_str());
            }
            let rollback_errors = unregistered
                .iter()
                .filter_map(|previous| {
                    app.global_shortcut()
                        .register(previous.as_str())
                        .err()
                        .map(|rollback| format!("{previous}: {rollback}"))
                })
                .collect::<Vec<_>>();
            *RUNTIME_SHORTCUT_SNAPSHOT.write() =
                runtime_shortcut_snapshot_for_registered(snapshot, &actual);
            return Err(if rollback_errors.is_empty() {
                format!("注册快捷键 {shortcut} 失败：{error}；原快捷键已恢复")
            } else {
                format!(
                    "注册快捷键 {shortcut} 失败：{error}；恢复原快捷键失败：{}",
                    rollback_errors.join("，")
                )
            });
        }
        newly_registered.push(shortcut.clone());
    }
    *REGISTERED_SHORTCUTS.lock() = desired;
    *RUNTIME_SHORTCUT_SNAPSHOT.write() =
        runtime_shortcut_snapshot_for_registered(snapshot, &REGISTERED_SHORTCUTS.lock());
    Ok(())
}

#[cfg(test)]
fn runtime_shortcut_snapshot(snapshot: &Value) -> Value {
    let registered = desired_shortcuts(snapshot).unwrap_or_default();
    runtime_shortcut_snapshot_for_registered(snapshot, &registered)
}

fn runtime_shortcut_snapshot_for_registered(
    snapshot: &Value,
    registered: &BTreeMap<String, String>,
) -> Value {
    let mut tools = serde_json::Map::new();
    for tool in ["search", "prompts", "clipboard", "folders"] {
        tools.insert(
            tool.to_string(),
            serde_json::json!({
                "enabled": snapshot
                    .pointer(&format!("/tools/{tool}/enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            }),
        );
    }
    let mut shortcuts = serde_json::Map::new();
    for tool in ["search", "prompts", "clipboard"] {
        if let Some(shortcut) = registered.get(tool) {
            shortcuts.insert(tool.to_string(), Value::String(shortcut.clone()));
        }
    }
    let folder_favorites = snapshot
        .get("folderFavorites")
        .and_then(Value::as_array)
        .map(|favorites| {
            favorites
                .iter()
                .filter_map(|favorite| {
                    let id = favorite.get("id")?.as_str()?;
                    let shortcut = registered.get(&format!("folder:{id}"))?;
                    Some(serde_json::json!({
                        "path": favorite.get("path")?.as_str()?,
                        "shortcut": shortcut
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let index_setup = snapshot
        .pointer("/settings/indexSetup")
        .cloned()
        .unwrap_or_else(|| {
            if snapshot.is_null() {
                Value::String("pending".into())
            } else {
                Value::String("ready".into())
            }
        });
    serde_json::json!({
        "tools": tools,
        "settings": {
            "shortcuts": shortcuts,
            "indexSetup": index_setup
        },
        "folderFavorites": folder_favorites
    })
}

fn runtime_search_snapshot(snapshot: &Value) -> Value {
    serde_json::json!({
        "tools": {
            "search": {
                "enabled": snapshot
                    .pointer("/tools/search/enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            }
        },
        "settings": {
            "indexRoots": snapshot
                .pointer("/settings/indexRoots")
                .cloned()
                .unwrap_or_else(|| serde_json::json!(["*"]))
        }
    })
}

fn apply_runtime_settings(
    app: &AppHandle,
    previous: &Value,
    snapshot: &Value,
    force: bool,
) -> Result<(), String> {
    let launch_at_login = snapshot
        .pointer("/settings/launchAtLogin")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let previous_launch_at_login = previous
        .pointer("/settings/launchAtLogin")
        .and_then(Value::as_bool);
    let autostart_error = if force || previous_launch_at_login != Some(launch_at_login) {
        let result = if launch_at_login {
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
            "/tools/folders/enabled",
            "/settings/shortcuts/search",
            "/settings/shortcuts/prompts",
            "/settings/shortcuts/clipboard",
        ]
        .iter()
        .any(|pointer| previous.pointer(pointer) != snapshot.pointer(pointer))
        || previous.get("folderFavorites") != snapshot.get("folderFavorites");
    if shortcuts_changed {
        reconcile_shortcuts(app, snapshot)?;
    }
    for tool in ["search", "prompts", "clipboard"] {
        let enabled = snapshot
            .pointer(&format!("/tools/{tool}/enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !enabled {
            if CURRENT_QUICK_OVERLAY_MODE.lock().as_deref() == Some(tool) {
                if let Some(window) = app.get_webview_window("quick-overlay") {
                    let _ = window.hide();
                }
            }
        }
    }
    if let Some(error) = autostart_error {
        return Err(error);
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct QuickOverlaySpec {
    window_label: &'static str,
    mode: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
}

fn quick_overlay_spec(requested_label: &str) -> Option<QuickOverlaySpec> {
    let (mode, title, width, height) = match requested_label {
        "search-overlay" => ("search", "Atlas Search", 760.0, 560.0),
        "prompts-overlay" => ("prompts", "Atlas Prompts", 700.0, 520.0),
        "clipboard-overlay" => ("clipboard", "Atlas Clipboard", 700.0, 520.0),
        _ => return None,
    };
    Some(QuickOverlaySpec {
        window_label: "quick-overlay",
        mode,
        title,
        width,
        height,
    })
}

fn show_quick_window(app: &AppHandle, label: &str) {
    let Some(spec) = quick_overlay_spec(label) else {
        return;
    };
    if let Some(window) = app.get_webview_window(spec.window_label) {
        let visible = window.is_visible().unwrap_or(false);
        let same_mode = CURRENT_QUICK_OVERLAY_MODE.lock().as_deref() == Some(spec.mode);
        if visible && same_mode && window.is_focused().unwrap_or(false) {
            let _ = window.hide();
        } else {
            if spec.mode == "clipboard" {
                remember_clipboard_target();
            }
            *CURRENT_QUICK_OVERLAY_MODE.lock() = Some(spec.mode.to_string());
            let _ = window.set_title(spec.title);
            let _ = window.set_size(LogicalSize::new(spec.width, spec.height));
            let _ = window.center();
            let _ = app.emit_to(spec.window_label, "atlas-overlay-mode", spec.mode);
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit_to(spec.window_label, "atlas-overlay-focus", ());
        }
        return;
    }
    if spec.mode == "clipboard" {
        remember_clipboard_target();
    }
    *CURRENT_QUICK_OVERLAY_MODE.lock() = Some(spec.mode.to_string());
    let url = WebviewUrl::App(format!("index.html?overlay={}", spec.mode).into());
    let initial_mode = spec.mode.to_string();
    match WebviewWindowBuilder::new(app, spec.window_label, url)
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .center()
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .background_color(Color(235, 232, 223, 255))
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("atlas-overlay-mode", initial_mode.as_str());
            let _ = window.emit("atlas-overlay-focus", ());
        })
        .build()
    {
        Ok(_) => {}
        Err(error) => eprintln!("failed to create {}: {error}", spec.window_label),
    }
}

fn schedule_quick_overlay_blur_hide(window: tauri::Window) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(120));
        if !window.is_focused().unwrap_or(false) {
            let _ = window.hide();
        }
    });
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
    if let Some(window) = app.get_webview_window("quick-overlay") {
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

fn folder_shortcut_target(snapshot: &Value, shortcut: &Shortcut) -> Option<String> {
    let enabled = snapshot
        .pointer("/tools/folders/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return None;
    }
    snapshot
        .get("folderFavorites")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|favorite| {
            let configured = favorite.get("shortcut").and_then(Value::as_str)?;
            let configured_shortcut = configured.parse::<Shortcut>().ok()?;
            if configured_shortcut != *shortcut {
                return None;
            }
            favorite
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn start_clipboard_monitor(app: AppHandle, storage: SharedStorage) {
    std::thread::spawn(move || {
        let mut last_seen = String::new();
        let mut sequence_tracker = ClipboardSequenceTracker::default();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let sequence = clipboard_sequence_number();
            if !sequence_tracker.should_attempt(sequence) {
                continue;
            }
            let policy_snapshot = match storage.load_snapshot() {
                Ok(snapshot) => snapshot,
                Err(_) => {
                    sequence_tracker.record_failure(sequence);
                    continue;
                }
            };
            let foreground_process = foreground_process_name();
            if !clipboard_capture_allowed(&policy_snapshot, foreground_process.as_deref()) {
                sequence_tracker.commit(sequence);
                continue;
            }
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
                        sequence_tracker.record_failure(sequence);
                        continue;
                    };
                    let text = text.trim().to_string();
                    if text.is_empty() {
                        sequence_tracker.commit(sequence);
                        continue;
                    }
                    ClipboardContent::Text(text)
                }
            };
            let marker = match &content {
                ClipboardContent::Image(_, fingerprint) => format!("image:{fingerprint}"),
                ClipboardContent::Text(text) => format!("text:{text}"),
            };
            let commit_foreground_process = foreground_process_name();
            if !clipboard_capture_allowed(&policy_snapshot, commit_foreground_process.as_deref()) {
                sequence_tracker.commit(sequence);
                continue;
            }
            if marker == last_seen {
                sequence_tracker.commit(sequence);
                continue;
            }
            let update = storage.update_snapshot(|snapshot| {
                if !clipboard_capture_allowed(snapshot, commit_foreground_process.as_deref()) {
                    return Ok(None);
                }
                let limit = snapshot
                    .pointer("/settings/clipboardLimit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 500) as usize;
                let retention_days = snapshot
                    .pointer("/settings/clipboardRetentionDays")
                    .and_then(Value::as_u64)
                    .unwrap_or(30);
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
                entries =
                    retain_recent_clipboard_entries(entries, copied_at, retention_days, limit);
                snapshot["clipboardHistory"] = Value::Array(entries.clone());
                Ok(Some(entries))
            });
            match update {
                Ok(Some(entries)) => {
                    last_seen = marker;
                    sequence_tracker.commit(sequence);
                    cleanup_clipboard_images(&storage, &entries);
                    let _ = app.emit("atlas-clipboard-history", entries);
                }
                Ok(None) => sequence_tracker.commit(sequence),
                Err(_) => {
                    sequence_tracker.record_failure(sequence);
                }
            }
        }
    });
}

fn show_main_window(app: &AppHandle) {
    USER_REQUESTED_MAIN_WINDOW.store(true, Ordering::Release);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn should_hide_autostart_window(launched_from_autostart: bool, user_requested: bool) -> bool {
    launched_from_autostart && !user_requested
}

pub fn run() -> Result<(), String> {
    if let Some(result) = ntfs::run_helper_if_requested() {
        return result;
    }
    let launched_from_autostart = std::env::args().any(|argument| argument == "--autostart");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                show_main_window(app);
            },
        ))
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
                    let (label, folder) = {
                        let snapshot = RUNTIME_SHORTCUT_SNAPSHOT.read();
                        (
                            shortcut_target(&snapshot, shortcut),
                            folder_shortcut_target(&snapshot, shortcut),
                        )
                    };
                    if let Some(label) = label {
                        show_quick_window(app, label);
                    } else if let Some(path) = folder {
                        if let Err(error) = open_target(path, false) {
                            eprintln!("failed to open folder shortcut target: {error}");
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Single-instance handling is installed before this setup callback,
            // so a foreground click can reach an autostart instance even while
            // its databases and background services are still warming up.
            let storage = Arc::new(StorageManager::initialize().map_err(|error| {
                std::io::Error::other(format!("初始化软件安装目录内的 data 文件夹失败：{error}"))
            })?);
            runtime_log::append_event(
                &storage.data_dir(),
                "INFO",
                "application.start",
                "success",
                if launched_from_autostart {
                    "mode=autostart"
                } else {
                    "mode=interactive"
                },
            );
            app.manage(storage.clone());
            let startup_snapshot = storage.load_snapshot().unwrap_or(Value::Null);
            *RUNTIME_SEARCH_SNAPSHOT.write() = runtime_search_snapshot(&startup_snapshot);
            let startup_search_generation = SEARCH_CONFIG_GENERATION.load(Ordering::Acquire);
            let open_item = MenuItem::with_id(app, "open", "打开 Atlas", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Atlas", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Atlas Desktop Toolkit")
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
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
            if should_hide_autostart_window(
                launched_from_autostart,
                USER_REQUESTED_MAIN_WINDOW.load(Ordering::Acquire),
            ) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            if launched_from_autostart {
                let startup_enabled = startup_snapshot
                    .pointer("/tools/startup/enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                if startup_enabled {
                    let items = launcher::items_for_login_scene(&startup_snapshot);
                    let layouts = launcher::layouts_for_login_scene(&startup_snapshot);
                    let storage_for_queue = storage.clone();
                    let app_for_queue = app.handle().clone();
                    std::thread::spawn(move || match launcher::launch_queue(items) {
                        Ok(results) => {
                            if !layouts.is_empty() {
                                for restored in launcher::restore_scene_layout(&layouts)
                                    .into_iter()
                                    .filter(|result| {
                                        !matches!(result.status, launcher::RestoreStatus::Restored)
                                    })
                                {
                                    eprintln!(
                                        "failed to restore startup layout for {}: {}",
                                        restored.item_id,
                                        restored.error.as_deref().unwrap_or("window unavailable")
                                    );
                                }
                            }
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
            let partial_index = search::has_partial_index(&storage, &index_roots);
            let complete_index = search::has_index(&storage, &index_roots);
            if search_enabled
                && index_setup_allows_background_build(
                    &startup_snapshot,
                    partial_index,
                    complete_index,
                )
            {
                let storage_for_index = storage.clone();
                let roots_for_index = index_roots.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    {
                        let _coordinator = SEARCH_CONFIG_GATE.lock();
                        if SEARCH_CONFIG_GENERATION.load(Ordering::Acquire)
                            != startup_search_generation
                        {
                            return;
                        }
                    }
                    if search::has_index(&storage_for_index, &roots_for_index) {
                        let _ = mark_index_setup_ready(&storage_for_index);
                        search::start_watchers(storage_for_index.clone(), roots_for_index.clone());
                        return;
                    }
                    // refresh_path mirrors notifications into search_fts_next
                    // while it exists, preserving changes in roots that have
                    // already been scanned during this build.
                    search::start_watchers(storage_for_index.clone(), roots_for_index.clone());
                    let expected_revision = {
                        let _coordinator = SEARCH_CONFIG_GATE.lock();
                        if SEARCH_CONFIG_GENERATION.load(Ordering::Acquire)
                            != startup_search_generation
                        {
                            return;
                        }
                        search::revision()
                    };
                    runtime_log::append_event(
                        &storage_for_index.data_dir(),
                        "INFO",
                        "search.index.background",
                        "started",
                        &format!("roots={}", roots_for_index.len()),
                    );
                    let rebuild_result = search::rebuild_if_revision(
                        &storage_for_index,
                        roots_for_index.clone(),
                        expected_revision,
                    );
                    match &rebuild_result {
                        Ok(Some(count)) => runtime_log::append_event(
                            &storage_for_index.data_dir(),
                            "INFO",
                            "search.index.background",
                            "success",
                            &format!("indexed_items={count}"),
                        ),
                        Ok(None) => runtime_log::append_event(
                            &storage_for_index.data_dir(),
                            "INFO",
                            "search.index.background",
                            "cancelled",
                            "reason=scope_changed",
                        ),
                        Err(error) => runtime_log::append_event(
                            &storage_for_index.data_dir(),
                            "ERROR",
                            "search.index.background",
                            "failed",
                            error,
                        ),
                    }
                    if search::has_index(&storage_for_index, &roots_for_index) {
                        let _ = mark_index_setup_ready(&storage_for_index);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "main" {
                    let _ = window.emit("atlas-close-requested", ());
                } else {
                    let _ = window.hide();
                }
            }
            WindowEvent::Focused(false) if window.label() != "main" => {
                schedule_quick_overlay_blur_hide(window.clone());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            get_data_directory,
            append_runtime_logs,
            open_runtime_log,
            save_snapshot,
            choose_startup_item,
            sync_startup_items,
            clear_startup_failures,
            set_search_filters,
            record_activity,
            search_index,
            get_index_status,
            get_index_progress,
            get_index_count,
            list_search_drives,
            rebuild_search_index,
            launch_startup_items,
            close_previous_startup_scene,
            capture_startup_scene_layout,
            restore_startup_scene_layout,
            list_startup_scene_monitors,
            run_command_task,
            open_target,
            hide_overlay,
            quit_application,
            get_quick_overlay_mode,
            activate_clipboard_entry,
            delete_clipboard_history_entry,
            import_appearance_asset,
            load_appearance_asset,
            load_app_icons
        ])
        .run(tauri::generate_context!())
        .map_err(|error| format!("运行 Atlas 桌面窗口失败：{error}"))
}
