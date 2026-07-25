use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    #[serde(default)]
    pub delay_seconds: u64,
    pub enabled: bool,
    pub order: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchStatus {
    Started,
    AlreadyRunning,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub id: String,
    pub name: String,
    pub success: bool,
    pub error: Option<String>,
    pub status: LaunchStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDescriptor {
    pub device_name: String,
    pub work_area: WindowRect,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneWindowLayout {
    pub item_id: String,
    pub executable_path: String,
    pub rect: WindowRect,
    pub maximized: bool,
    pub monitor_device_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneLayoutCapture {
    pub layouts: Vec<SceneWindowLayout>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseStatus {
    CloseRequested,
    NotRunning,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseResult {
    pub executable_path: String,
    pub status: CloseStatus,
    pub windows_notified: usize,
    pub processes_terminated: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreStatus {
    Restored,
    WindowNotFound,
    NoMonitor,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub item_id: String,
    pub status: RestoreStatus,
    pub error: Option<String>,
}

pub trait ScenePlatform {
    fn is_executable_running(&mut self, path: &Path) -> Result<bool, String>;
    fn activate_running(&mut self, path: &Path) -> Result<bool, String>;
    fn launch(&mut self, item: &StartupItem) -> Result<(), String>;
    fn request_close(&mut self, executable_path: &Path) -> Result<usize, String>;
    fn force_stop(&mut self, executable_path: &Path) -> Result<usize, String>;
    fn capture_main_window(
        &mut self,
        item: &StartupItem,
    ) -> Result<Option<SceneWindowLayout>, String>;
    fn available_monitors(&mut self) -> Result<Vec<MonitorDescriptor>, String>;
    fn apply_window_layout(
        &mut self,
        layout: &SceneWindowLayout,
        rect: WindowRect,
    ) -> Result<bool, String>;
}

static QUEUE_RUNNING: AtomicBool = AtomicBool::new(false);

struct QueueGuard;

impl Drop for QueueGuard {
    fn drop(&mut self) {
        QUEUE_RUNNING.store(false, Ordering::Release);
    }
}

pub(crate) fn validate_startup_item(item: &StartupItem) -> Result<(), String> {
    let path = PathBuf::from(&item.path);
    if !path.is_file() {
        return Err(format!("{} 不存在", item.path));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "exe" | "lnk" | "appref-ms" | "bat" | "cmd"
    ) {
        return Err(format!("不允许启动 .{extension} 类型的文件"));
    }
    Ok(())
}

fn launch_one(item: &StartupItem) -> Result<(), String> {
    validate_startup_item(item)?;
    let path = PathBuf::from(&item.path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "lnk" | "appref-ms" | "bat" | "cmd") {
        open::that_detached(&path).map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut command = Command::new(&path);
    command.args(&item.args);
    if let Some(directory) = &item.working_directory {
        let working_directory = Path::new(directory);
        if working_directory.is_dir() {
            command.current_dir(working_directory);
        }
    }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn normalize_executable_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('/', "\\");
    normalized
        .strip_prefix(r"\\?\")
        .unwrap_or(&normalized)
        .trim_end_matches('\\')
        .to_lowercase()
}

fn is_direct_executable(item: &StartupItem) -> bool {
    Path::new(&item.path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

fn is_windows_shortcut(item: &StartupItem) -> bool {
    Path::new(&item.path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut(path: &Path) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const SCRIPT: &str =
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:ATLAS_SHORTCUT_PATH); [Console]::OutputEncoding=[Text.Encoding]::UTF8; $s.TargetPath";
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("ATLAS_SHORTCUT_PATH", path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let target = PathBuf::from(target);
    target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        .then_some(target)
}

#[cfg(not(target_os = "windows"))]
fn resolve_windows_shortcut(_path: &Path) -> Option<PathBuf> {
    None
}

fn process_executable_path(item: &StartupItem) -> Option<PathBuf> {
    if is_direct_executable(item) {
        return Some(PathBuf::from(&item.path));
    }
    let path = Path::new(&item.path);
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
        .then(|| resolve_windows_shortcut(path))
        .flatten()
}

pub fn launch_queue_with<P, S>(
    items: Vec<StartupItem>,
    platform: &mut P,
    sleep: S,
) -> Result<Vec<LaunchResult>, String>
where
    P: ScenePlatform,
    S: FnMut(Duration),
{
    launch_queue_with_process_resolver(items, platform, sleep, process_executable_path)
}

fn launch_queue_with_process_resolver<P, S, R>(
    mut items: Vec<StartupItem>,
    platform: &mut P,
    mut sleep: S,
    resolve_process_path: R,
) -> Result<Vec<LaunchResult>, String>
where
    P: ScenePlatform,
    S: FnMut(Duration),
    R: Fn(&StartupItem) -> Option<PathBuf>,
{
    if QUEUE_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("启动队列正在运行，请稍候".into());
    }
    let _guard = QueueGuard;
    items.sort_by_key(|item| item.order);
    let mut results = Vec::new();
    for item in items.into_iter().filter(|item| item.enabled) {
        if item.delay_seconds > 0 {
            sleep(Duration::from_secs(item.delay_seconds));
        }
        if let Err(error) = validate_startup_item(&item) {
            results.push(LaunchResult {
                id: item.id,
                name: item.name,
                success: false,
                error: Some(error),
                status: LaunchStatus::Failed,
            });
            continue;
        }
        if let Some(process_path) = resolve_process_path(&item) {
            match platform.is_executable_running(&process_path) {
                Ok(true) => {
                    if is_windows_shortcut(&item) {
                        results.push(match platform.activate_running(&process_path) {
                            Ok(true) => LaunchResult {
                                id: item.id,
                                name: item.name,
                                success: true,
                                error: None,
                                status: LaunchStatus::AlreadyRunning,
                            },
                            Ok(false) | Err(_) => match platform.launch(&item) {
                                Ok(()) => LaunchResult {
                                    id: item.id,
                                    name: item.name,
                                    success: true,
                                    error: None,
                                    status: LaunchStatus::AlreadyRunning,
                                },
                                Err(error) => LaunchResult {
                                    id: item.id,
                                    name: item.name,
                                    success: false,
                                    error: Some(error),
                                    status: LaunchStatus::Failed,
                                },
                            },
                        });
                    } else {
                        results.push(LaunchResult {
                            id: item.id,
                            name: item.name,
                            success: true,
                            error: None,
                            status: LaunchStatus::AlreadyRunning,
                        });
                    }
                    continue;
                }
                // Running-state inspection is only a duplicate-launch optimization.
                // A shortcut must still be launched when Windows denies process
                // inspection or its target cannot be inspected reliably.
                Err(_) => {}
                Ok(false) => {}
            }
        }
        match platform.launch(&item) {
            Ok(()) => results.push(LaunchResult {
                id: item.id,
                name: item.name,
                success: true,
                error: None,
                status: LaunchStatus::Started,
            }),
            Err(error) => results.push(LaunchResult {
                id: item.id,
                name: item.name,
                success: false,
                error: Some(error),
                status: LaunchStatus::Failed,
            }),
        }
    }
    Ok(results)
}

pub fn launch_queue(items: Vec<StartupItem>) -> Result<Vec<LaunchResult>, String> {
    let mut platform = NativeScenePlatform;
    launch_queue_with(items, &mut platform, thread::sleep)
}

fn close_previous_scene_with_sleep<P, S>(
    previous: &[StartupItem],
    next: &[StartupItem],
    platform: &mut P,
    mut sleep: S,
) -> Vec<CloseResult>
where
    P: ScenePlatform,
    S: FnMut(Duration),
{
    let next_paths = next
        .iter()
        .filter(|item| item.enabled)
        .filter_map(process_executable_path)
        .map(|path| normalize_executable_path(&path))
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for item in previous.iter().filter(|item| item.enabled) {
        let Some(process_path) = process_executable_path(item) else {
            continue;
        };
        let normalized = normalize_executable_path(&process_path);
        if next_paths.contains(&normalized) || !seen.insert(normalized) {
            continue;
        }
        results.push(match platform.request_close(&process_path) {
            Ok(windows_notified) => {
                let mut running = platform
                    .is_executable_running(&process_path)
                    .unwrap_or(windows_notified > 0);
                if running && windows_notified > 0 {
                    for _ in 0..20 {
                        sleep(Duration::from_millis(100));
                        running = platform
                            .is_executable_running(&process_path)
                            .unwrap_or(true);
                        if !running {
                            break;
                        }
                    }
                }
                if running {
                    match platform.force_stop(&process_path) {
                        Ok(processes_terminated) => {
                            for _ in 0..20 {
                                running = platform
                                    .is_executable_running(&process_path)
                                    .unwrap_or(true);
                                if !running {
                                    break;
                                }
                                sleep(Duration::from_millis(100));
                            }
                            CloseResult {
                                executable_path: item.path.clone(),
                                status: if running {
                                    CloseStatus::Failed
                                } else {
                                    CloseStatus::CloseRequested
                                },
                                windows_notified,
                                processes_terminated,
                                error: running.then(|| "应用进程在结束请求后仍然运行".into()),
                            }
                        }
                        Err(error) => CloseResult {
                            executable_path: item.path.clone(),
                            status: CloseStatus::Failed,
                            windows_notified,
                            processes_terminated: 0,
                            error: Some(error),
                        },
                    }
                } else {
                    CloseResult {
                        executable_path: item.path.clone(),
                        status: if windows_notified > 0 {
                            CloseStatus::CloseRequested
                        } else if cfg!(target_os = "windows") {
                            CloseStatus::NotRunning
                        } else {
                            CloseStatus::Unsupported
                        },
                        windows_notified,
                        processes_terminated: 0,
                        error: None,
                    }
                }
            }
            Err(error) => CloseResult {
                executable_path: item.path.clone(),
                status: CloseStatus::Failed,
                windows_notified: 0,
                processes_terminated: 0,
                error: Some(error),
            },
        });
    }
    results
}

pub fn close_previous_scene_with<P: ScenePlatform>(
    previous: &[StartupItem],
    next: &[StartupItem],
    platform: &mut P,
) -> Vec<CloseResult> {
    close_previous_scene_with_sleep(previous, next, platform, thread::sleep)
}

pub fn close_previous_scene(previous: &[StartupItem], next: &[StartupItem]) -> Vec<CloseResult> {
    let mut platform = NativeScenePlatform;
    close_previous_scene_with(previous, next, &mut platform)
}

pub fn capture_scene_layout_with<P: ScenePlatform>(
    items: &[StartupItem],
    platform: &mut P,
) -> SceneLayoutCapture {
    let mut layouts = Vec::new();
    let mut errors = Vec::new();
    for item in items.iter().filter(|item| item.enabled) {
        let Some(process_path) = process_executable_path(item) else {
            continue;
        };
        let mut process_item = item.clone();
        process_item.path = process_path.to_string_lossy().to_string();
        match platform.capture_main_window(&process_item) {
            Ok(Some(layout)) => layouts.push(layout),
            Ok(None) => {}
            Err(error) => errors.push(format!("{}: {error}", item.name)),
        }
    }
    SceneLayoutCapture { layouts, errors }
}

pub fn capture_scene_layout(items: &[StartupItem]) -> SceneLayoutCapture {
    let mut platform = NativeScenePlatform;
    capture_scene_layout_with(items, &mut platform)
}

fn squared_distance_to_rect(x: i64, y: i64, rect: WindowRect) -> i64 {
    let right = i64::from(rect.x) + i64::from(rect.width);
    let bottom = i64::from(rect.y) + i64::from(rect.height);
    let dx = if x < i64::from(rect.x) {
        i64::from(rect.x) - x
    } else if x > right {
        x - right
    } else {
        0
    };
    let dy = if y < i64::from(rect.y) {
        i64::from(rect.y) - y
    } else if y > bottom {
        y - bottom
    } else {
        0
    };
    dx.saturating_mul(dx) + dy.saturating_mul(dy)
}

fn valid_window_rect(rect: WindowRect) -> bool {
    rect.width >= 100 && rect.height >= 80
}

pub fn resolve_window_rect(
    layout: &SceneWindowLayout,
    monitors: &[MonitorDescriptor],
) -> Option<WindowRect> {
    if !valid_window_rect(layout.rect) {
        return None;
    }
    let monitor = layout
        .monitor_device_name
        .as_deref()
        .and_then(|name| {
            monitors
                .iter()
                .find(|monitor| monitor.device_name.eq_ignore_ascii_case(name))
        })
        .or_else(|| {
            let center_x = i64::from(layout.rect.x) + i64::from(layout.rect.width) / 2;
            let center_y = i64::from(layout.rect.y) + i64::from(layout.rect.height) / 2;
            monitors.iter().min_by_key(|monitor| {
                squared_distance_to_rect(center_x, center_y, monitor.work_area)
            })
        })?;
    let area = monitor.work_area;
    let width = layout.rect.width.max(100).min(area.width.max(100));
    let height = layout.rect.height.max(80).min(area.height.max(80));
    let max_x = area.x.saturating_add(area.width.saturating_sub(width));
    let max_y = area.y.saturating_add(area.height.saturating_sub(height));
    Some(WindowRect {
        x: layout.rect.x.clamp(area.x, max_x),
        y: layout.rect.y.clamp(area.y, max_y),
        width,
        height,
    })
}

pub fn restore_scene_layout_with<P: ScenePlatform>(
    layouts: &[SceneWindowLayout],
    platform: &mut P,
) -> Vec<RestoreResult> {
    let monitors = match platform.available_monitors() {
        Ok(monitors) => monitors,
        Err(error) => {
            return layouts
                .iter()
                .map(|layout| RestoreResult {
                    item_id: layout.item_id.clone(),
                    status: RestoreStatus::Failed,
                    error: Some(error.clone()),
                })
                .collect()
        }
    };
    layouts
        .iter()
        .map(|layout| {
            let Some(rect) = resolve_window_rect(layout, &monitors) else {
                return RestoreResult {
                    item_id: layout.item_id.clone(),
                    status: if cfg!(target_os = "windows") {
                        RestoreStatus::NoMonitor
                    } else {
                        RestoreStatus::Unsupported
                    },
                    error: None,
                };
            };
            match platform.apply_window_layout(layout, rect) {
                Ok(true) => RestoreResult {
                    item_id: layout.item_id.clone(),
                    status: RestoreStatus::Restored,
                    error: None,
                },
                Ok(false) => RestoreResult {
                    item_id: layout.item_id.clone(),
                    status: if cfg!(target_os = "windows") {
                        RestoreStatus::WindowNotFound
                    } else {
                        RestoreStatus::Unsupported
                    },
                    error: None,
                },
                Err(error) => RestoreResult {
                    item_id: layout.item_id.clone(),
                    status: RestoreStatus::Failed,
                    error: Some(error),
                },
            }
        })
        .collect()
}

pub fn restore_scene_layout(layouts: &[SceneWindowLayout]) -> Vec<RestoreResult> {
    let mut platform = NativeScenePlatform;
    restore_scene_layout_with(layouts, &mut platform)
}

pub fn list_scene_monitors() -> Result<Vec<MonitorDescriptor>, String> {
    let mut platform = NativeScenePlatform;
    platform.available_monitors()
}

pub struct NativeScenePlatform;

#[cfg(not(target_os = "windows"))]
impl ScenePlatform for NativeScenePlatform {
    fn is_executable_running(&mut self, _path: &Path) -> Result<bool, String> {
        Ok(false)
    }

    fn activate_running(&mut self, _path: &Path) -> Result<bool, String> {
        Ok(false)
    }

    fn launch(&mut self, item: &StartupItem) -> Result<(), String> {
        launch_one(item)
    }

    fn request_close(&mut self, _executable_path: &Path) -> Result<usize, String> {
        Ok(0)
    }

    fn force_stop(&mut self, _executable_path: &Path) -> Result<usize, String> {
        Ok(0)
    }

    fn capture_main_window(
        &mut self,
        _item: &StartupItem,
    ) -> Result<Option<SceneWindowLayout>, String> {
        Ok(None)
    }

    fn available_monitors(&mut self) -> Result<Vec<MonitorDescriptor>, String> {
        Ok(Vec::new())
    }

    fn apply_window_layout(
        &mut self,
        _layout: &SceneWindowLayout,
        _rect: WindowRect,
    ) -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(target_os = "windows")]
mod windows_scene {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        ptr,
        time::Instant,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT},
        Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFOEXW,
            MONITOR_DEFAULTTONEAREST,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            },
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindow, GetWindowRect, GetWindowTextLengthW, GetWindowThreadProcessId,
            IsWindowVisible, IsZoomed, PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow,
            GW_OWNER, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_MAXIMIZE, SW_RESTORE,
            WM_CLOSE,
        },
    };

    fn os_error(action: &str) -> String {
        format!("{action}: {}", std::io::Error::last_os_error())
    }

    fn wide_string(buffer: &[u16]) -> String {
        let length = buffer
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..length])
    }

    fn process_path(process_id: u32) -> Option<PathBuf> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return None;
            }
            let mut buffer = vec![0u16; 32_768];
            let mut length = buffer.len() as u32;
            let success =
                QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) != 0;
            CloseHandle(process);
            success.then(|| PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])))
        }
    }

    fn running_processes() -> Result<Vec<(u32, PathBuf)>, String> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(os_error("无法枚举进程"));
            }
            let mut entry: PROCESSENTRY32W = zeroed();
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut processes = Vec::new();
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    if let Some(path) = process_path(entry.th32ProcessID) {
                        processes.push((entry.th32ProcessID, path));
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
            Ok(processes)
        }
    }

    fn running_process_paths() -> Result<Vec<PathBuf>, String> {
        Ok(running_processes()?
            .into_iter()
            .map(|(_, path)| path)
            .collect())
    }

    unsafe extern "system" fn collect_window(hwnd: HWND, parameter: LPARAM) -> i32 {
        let windows = &mut *(parameter as *mut Vec<HWND>);
        if IsWindowVisible(hwnd) != 0
            && GetWindow(hwnd, GW_OWNER).is_null()
            && GetWindowTextLengthW(hwnd) > 0
        {
            windows.push(hwnd);
        }
        1
    }

    fn top_level_windows() -> Result<Vec<HWND>, String> {
        let mut windows = Vec::<HWND>::new();
        let succeeded =
            unsafe { EnumWindows(Some(collect_window), &mut windows as *mut _ as LPARAM) } != 0;
        if succeeded {
            Ok(windows)
        } else {
            Err(os_error("无法枚举桌面窗口"))
        }
    }

    fn window_process_path(hwnd: HWND) -> Option<PathBuf> {
        let mut process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut process_id);
        }
        (process_id != 0)
            .then(|| process_path(process_id))
            .flatten()
    }

    fn main_window_for_path(path: &Path) -> Result<Option<HWND>, String> {
        let expected = normalize_executable_path(path);
        Ok(top_level_windows()?
            .into_iter()
            .filter(|hwnd| {
                window_process_path(*hwnd)
                    .is_some_and(|actual| normalize_executable_path(&actual) == expected)
            })
            .filter_map(|hwnd| {
                let mut rect: RECT = unsafe { zeroed() };
                if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
                    return None;
                }
                let rect = rect_from_native(rect);
                valid_window_rect(rect)
                    .then_some((hwnd, i64::from(rect.width) * i64::from(rect.height)))
            })
            .max_by_key(|(_, area)| *area)
            .map(|(hwnd, _)| hwnd))
    }

    fn rect_from_native(rect: RECT) -> WindowRect {
        WindowRect {
            x: rect.left,
            y: rect.top,
            width: rect.right.saturating_sub(rect.left),
            height: rect.bottom.saturating_sub(rect.top),
        }
    }

    fn monitor_info(monitor: HMONITOR) -> Option<MonitorDescriptor> {
        unsafe {
            let mut info: MONITORINFOEXW = zeroed();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(
                monitor,
                &mut info as *mut MONITORINFOEXW
                    as *mut windows_sys::Win32::Graphics::Gdi::MONITORINFO,
            ) == 0
            {
                return None;
            }
            Some(MonitorDescriptor {
                device_name: wide_string(&info.szDevice),
                work_area: rect_from_native(info.monitorInfo.rcWork),
                primary: info.monitorInfo.dwFlags & 1 != 0,
            })
        }
    }

    unsafe extern "system" fn collect_monitor(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        parameter: LPARAM,
    ) -> i32 {
        let monitors = &mut *(parameter as *mut Vec<MonitorDescriptor>);
        if let Some(info) = monitor_info(monitor) {
            monitors.push(info);
        }
        1
    }

    fn available_monitors() -> Result<Vec<MonitorDescriptor>, String> {
        let mut monitors = Vec::new();
        let succeeded = unsafe {
            EnumDisplayMonitors(
                ptr::null_mut(),
                ptr::null(),
                Some(collect_monitor),
                &mut monitors as *mut _ as LPARAM,
            )
        } != 0;
        if succeeded {
            Ok(monitors)
        } else {
            Err(os_error("无法枚举显示器"))
        }
    }

    impl ScenePlatform for NativeScenePlatform {
        fn is_executable_running(&mut self, path: &Path) -> Result<bool, String> {
            let expected = normalize_executable_path(path);
            Ok(running_process_paths()?
                .iter()
                .any(|actual| normalize_executable_path(actual) == expected))
        }

        fn activate_running(&mut self, path: &Path) -> Result<bool, String> {
            let Some(hwnd) = main_window_for_path(path)? else {
                return Ok(false);
            };
            unsafe {
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
            }
            Ok(true)
        }

        fn launch(&mut self, item: &StartupItem) -> Result<(), String> {
            launch_one(item)
        }

        fn request_close(&mut self, executable_path: &Path) -> Result<usize, String> {
            let expected = normalize_executable_path(executable_path);
            let mut requested = 0;
            for hwnd in top_level_windows()? {
                let matches = window_process_path(hwnd)
                    .is_some_and(|actual| normalize_executable_path(&actual) == expected);
                if matches && unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } != 0 {
                    requested += 1;
                }
            }
            Ok(requested)
        }

        fn force_stop(&mut self, executable_path: &Path) -> Result<usize, String> {
            let expected = normalize_executable_path(executable_path);
            let mut terminated = 0;
            let mut errors = Vec::new();
            for (process_id, path) in running_processes()? {
                if normalize_executable_path(&path) != expected {
                    continue;
                }
                unsafe {
                    let process = OpenProcess(PROCESS_TERMINATE, 0, process_id);
                    if process.is_null() {
                        errors.push(os_error(&format!("无法打开进程 {process_id}")));
                        continue;
                    }
                    if TerminateProcess(process, 0) != 0 {
                        terminated += 1;
                    } else {
                        errors.push(os_error(&format!("无法结束进程 {process_id}")));
                    }
                    CloseHandle(process);
                }
            }
            if terminated == 0 && !errors.is_empty() {
                Err(errors.join("；"))
            } else {
                Ok(terminated)
            }
        }

        fn capture_main_window(
            &mut self,
            item: &StartupItem,
        ) -> Result<Option<SceneWindowLayout>, String> {
            let Some(hwnd) = main_window_for_path(Path::new(&item.path))? else {
                return Ok(None);
            };
            unsafe {
                let mut rect: RECT = zeroed();
                if GetWindowRect(hwnd, &mut rect) == 0 {
                    return Err(os_error("无法读取窗口位置"));
                }
                let rect = rect_from_native(rect);
                if !valid_window_rect(rect) {
                    return Ok(None);
                }
                let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                Ok(Some(SceneWindowLayout {
                    item_id: item.id.clone(),
                    executable_path: item.path.clone(),
                    rect,
                    maximized: IsZoomed(hwnd) != 0,
                    monitor_device_name: monitor_info(monitor).map(|info| info.device_name),
                }))
            }
        }

        fn available_monitors(&mut self) -> Result<Vec<MonitorDescriptor>, String> {
            available_monitors()
        }

        fn apply_window_layout(
            &mut self,
            layout: &SceneWindowLayout,
            rect: WindowRect,
        ) -> Result<bool, String> {
            let deadline = Instant::now() + Duration::from_secs(12);
            let hwnd = loop {
                if let Some(hwnd) = main_window_for_path(Path::new(&layout.executable_path))? {
                    break hwnd;
                }
                if Instant::now() >= deadline {
                    return Ok(false);
                }
                thread::sleep(Duration::from_millis(100));
            };
            unsafe {
                ShowWindow(hwnd, SW_RESTORE);
                if SetWindowPos(
                    hwnd,
                    ptr::null_mut::<c_void>(),
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
                ) == 0
                {
                    return Err(os_error("无法恢复窗口位置"));
                }
                if layout.maximized {
                    ShowWindow(hwnd, SW_MAXIMIZE);
                }
            }
            Ok(true)
        }
    }
}

pub fn items_from_snapshot(snapshot: &serde_json::Value) -> Vec<StartupItem> {
    snapshot
        .get("startupItems")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn items_for_login_scene(snapshot: &serde_json::Value) -> Vec<StartupItem> {
    let items = items_from_snapshot(snapshot);
    let scene_id = snapshot
        .pointer("/settings/loginSceneId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("default-scene");
    if scene_id.trim().is_empty() {
        return Vec::new();
    }
    let selected = snapshot
        .get("startupScenes")
        .and_then(serde_json::Value::as_array)
        .and_then(|scenes| {
            scenes
                .iter()
                .find(|scene| scene.get("id").and_then(serde_json::Value::as_str) == Some(scene_id))
        })
        .and_then(|scene| scene.get("itemIds"))
        .and_then(serde_json::Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<std::collections::HashSet<_>>()
        });
    match selected {
        Some(selected) => items
            .into_iter()
            .filter(|item| selected.contains(item.id.as_str()))
            .collect(),
        None => Vec::new(),
    }
}

pub fn layouts_for_login_scene(snapshot: &serde_json::Value) -> Vec<SceneWindowLayout> {
    let scene_id = snapshot
        .pointer("/settings/loginSceneId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("default-scene");
    if scene_id.trim().is_empty() {
        return Vec::new();
    }
    snapshot
        .get("startupScenes")
        .and_then(serde_json::Value::as_array)
        .and_then(|scenes| {
            scenes
                .iter()
                .find(|scene| scene.get("id").and_then(serde_json::Value::as_str) == Some(scene_id))
        })
        .filter(|scene| {
            scene
                .get("restoreLayout")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .and_then(|scene| scene.get("windowLayouts"))
        .and_then(serde_json::Value::as_array)
        .map(|layouts| {
            layouts
                .iter()
                .filter_map(|layout| serde_json::from_value(layout.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod scene_tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct FakeScenePlatform {
        running: HashSet<String>,
        detection_errors: HashSet<String>,
        activatable: HashSet<String>,
        activated: Vec<String>,
        launched: Vec<String>,
        closed: Vec<String>,
        force_stopped: Vec<String>,
        windows: HashMap<String, SceneWindowLayout>,
        monitors: Vec<MonitorDescriptor>,
        restored: Vec<(String, WindowRect, bool)>,
    }

    impl ScenePlatform for FakeScenePlatform {
        fn is_executable_running(&mut self, path: &Path) -> Result<bool, String> {
            let normalized = normalize_executable_path(path);
            if self.detection_errors.contains(&normalized) {
                return Err("process inspection unavailable".into());
            }
            Ok(self.running.contains(&normalized))
        }

        fn activate_running(&mut self, path: &Path) -> Result<bool, String> {
            let normalized = normalize_executable_path(path);
            if self.activatable.contains(&normalized) {
                self.activated.push(normalized);
                return Ok(true);
            }
            Ok(false)
        }

        fn launch(&mut self, item: &StartupItem) -> Result<(), String> {
            self.launched.push(item.id.clone());
            Ok(())
        }

        fn request_close(&mut self, executable_path: &Path) -> Result<usize, String> {
            self.closed.push(normalize_executable_path(executable_path));
            Ok(1)
        }

        fn force_stop(&mut self, executable_path: &Path) -> Result<usize, String> {
            let normalized = normalize_executable_path(executable_path);
            self.force_stopped.push(normalized.clone());
            self.running.remove(&normalized);
            Ok(1)
        }

        fn capture_main_window(
            &mut self,
            item: &StartupItem,
        ) -> Result<Option<SceneWindowLayout>, String> {
            Ok(self.windows.get(&item.id).cloned())
        }

        fn available_monitors(&mut self) -> Result<Vec<MonitorDescriptor>, String> {
            Ok(self.monitors.clone())
        }

        fn apply_window_layout(
            &mut self,
            layout: &SceneWindowLayout,
            rect: WindowRect,
        ) -> Result<bool, String> {
            self.restored
                .push((layout.item_id.clone(), rect, layout.maximized));
            Ok(true)
        }
    }

    fn executable_item(id: &str, path: &Path, order: usize) -> StartupItem {
        StartupItem {
            id: id.into(),
            name: id.into(),
            path: path.to_string_lossy().into_owned(),
            args: Vec::new(),
            working_directory: None,
            delay_seconds: 0,
            enabled: true,
            order,
        }
    }

    fn temporary_startup_file(name: &str, extension: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atlas-{name}-{nonce}.{extension}"));
        fs::write(&path, b"test startup item").unwrap();
        path
    }

    #[test]
    fn launch_queue_checks_shortcut_targets_without_filtering_shortcuts() {
        let executable = temporary_startup_file("running", "exe");
        let running_shortcut = temporary_startup_file("running-shortcut", "lnk");
        let inspect_failed_shortcut = temporary_startup_file("inspect-failed-shortcut", "lnk");
        let inspect_failed_target = PathBuf::from(r"C:\Apps\Notes\notes.exe");
        let items = vec![
            executable_item("editor", &executable, 0),
            executable_item("editor-shortcut", &running_shortcut, 1),
            executable_item("notes-shortcut", &inspect_failed_shortcut, 2),
        ];
        let mut platform = FakeScenePlatform::default();
        platform
            .running
            .insert(normalize_executable_path(&executable));
        platform
            .activatable
            .insert(normalize_executable_path(&executable));
        platform
            .detection_errors
            .insert(normalize_executable_path(&inspect_failed_target));

        let results = launch_queue_with_process_resolver(
            items,
            &mut platform,
            |_| {},
            |item| match item.id.as_str() {
                "editor-shortcut" => Some(executable.clone()),
                "notes-shortcut" => Some(inspect_failed_target.clone()),
                _ => process_executable_path(item),
            },
        )
        .expect("queue should complete");

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].status, LaunchStatus::AlreadyRunning);
        assert!(results[0].success);
        assert_eq!(results[1].status, LaunchStatus::AlreadyRunning);
        assert!(results[1].success);
        assert_eq!(results[2].status, LaunchStatus::Started);
        assert!(results[2].success);
        assert_eq!(
            platform.activated,
            vec![normalize_executable_path(&executable)]
        );
        assert_eq!(platform.launched, vec!["notes-shortcut"]);
        fs::remove_file(executable).unwrap();
        fs::remove_file(running_shortcut).unwrap();
        fs::remove_file(inspect_failed_shortcut).unwrap();
    }

    #[test]
    fn scene_transition_closes_only_apps_absent_from_the_next_scene() {
        let editor = PathBuf::from(r"C:\Apps\Editor\editor.exe");
        let music = PathBuf::from(r"C:\Apps\Music\music.exe");
        let previous = vec![
            executable_item("editor-old", &editor, 0),
            executable_item("music", &music, 1),
        ];
        let next = vec![executable_item(
            "editor-new",
            Path::new(r"c:\apps\editor\EDITOR.exe"),
            0,
        )];
        let mut platform = FakeScenePlatform::default();
        platform.running.insert(normalize_executable_path(&music));

        let results = close_previous_scene_with_sleep(&previous, &next, &mut platform, |_| {});

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].executable_path, music.to_string_lossy());
        assert_eq!(results[0].status, CloseStatus::CloseRequested);
        assert_eq!(
            platform.closed,
            vec![normalize_executable_path(music.as_path())]
        );
        assert_eq!(
            platform.force_stopped,
            vec![normalize_executable_path(music.as_path())]
        );
    }

    #[test]
    fn capture_layout_keeps_item_window_geometry_and_monitor_name() {
        let executable = PathBuf::from(r"C:\Apps\Editor\editor.exe");
        let item = executable_item("editor", &executable, 0);
        let expected = SceneWindowLayout {
            item_id: item.id.clone(),
            executable_path: item.path.clone(),
            rect: WindowRect {
                x: 120,
                y: 80,
                width: 1280,
                height: 720,
            },
            maximized: true,
            monitor_device_name: Some(r"\\.\DISPLAY2".into()),
        };
        let mut platform = FakeScenePlatform::default();
        platform.windows.insert(item.id.clone(), expected.clone());

        let captured = capture_scene_layout_with(&[item], &mut platform);

        assert_eq!(captured.layouts, vec![expected]);
        assert!(captured.errors.is_empty());
    }

    #[test]
    fn missing_display_uses_nearest_monitor_and_clamps_the_window_inside_it() {
        let monitors = vec![
            MonitorDescriptor {
                device_name: r"\\.\DISPLAY1".into(),
                work_area: WindowRect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1040,
                },
                primary: true,
            },
            MonitorDescriptor {
                device_name: r"\\.\DISPLAY3".into(),
                work_area: WindowRect {
                    x: 1920,
                    y: 0,
                    width: 2560,
                    height: 1400,
                },
                primary: false,
            },
        ];
        let layout = SceneWindowLayout {
            item_id: "editor".into(),
            executable_path: r"C:\Apps\Editor\editor.exe".into(),
            rect: WindowRect {
                x: 4300,
                y: 120,
                width: 1200,
                height: 800,
            },
            maximized: false,
            monitor_device_name: Some(r"\\.\MISSING".into()),
        };

        let resolved = resolve_window_rect(&layout, &monitors).unwrap();

        assert_eq!(resolved.x, 3280);
        assert_eq!(resolved.y, 120);
        assert_eq!(resolved.width, 1200);
        assert_eq!(resolved.height, 800);
    }

    #[test]
    fn invalid_zero_sized_layout_is_not_restored_as_a_tiny_window() {
        let layout = SceneWindowLayout {
            item_id: "devcpp".into(),
            executable_path: r"C:\Apps\DevCpp\devcpp.exe".into(),
            rect: WindowRect {
                x: 1280,
                y: 800,
                width: 0,
                height: 0,
            },
            maximized: false,
            monitor_device_name: Some(r"\\.\DISPLAY1".into()),
        };
        let monitors = vec![MonitorDescriptor {
            device_name: r"\\.\DISPLAY1".into(),
            work_area: WindowRect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1528,
            },
            primary: true,
        }];

        assert_eq!(resolve_window_rect(&layout, &monitors), None);
    }

    #[test]
    fn restore_layout_passes_resolved_geometry_and_maximized_state_to_platform() {
        let layout = SceneWindowLayout {
            item_id: "editor".into(),
            executable_path: r"C:\Apps\Editor\editor.exe".into(),
            rect: WindowRect {
                x: 200,
                y: 100,
                width: 900,
                height: 600,
            },
            maximized: true,
            monitor_device_name: Some(r"\\.\DISPLAY1".into()),
        };
        let monitor = MonitorDescriptor {
            device_name: r"\\.\DISPLAY1".into(),
            work_area: WindowRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            },
            primary: true,
        };
        let mut platform = FakeScenePlatform {
            monitors: vec![monitor],
            ..Default::default()
        };

        let results = restore_scene_layout_with(&[layout], &mut platform);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, RestoreStatus::Restored);
        assert_eq!(
            platform.restored,
            vec![(
                "editor".into(),
                WindowRect {
                    x: 200,
                    y: 100,
                    width: 900,
                    height: 600,
                },
                true,
            )]
        );
    }
}
