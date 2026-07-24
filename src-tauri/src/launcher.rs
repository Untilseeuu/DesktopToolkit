use std::{
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub id: String,
    pub name: String,
    pub success: bool,
    pub error: Option<String>,
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

pub fn launch_queue(mut items: Vec<StartupItem>) -> Result<Vec<LaunchResult>, String> {
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
            thread::sleep(Duration::from_secs(item.delay_seconds));
        }
        let outcome = launch_one(&item);
        results.push(LaunchResult {
            id: item.id,
            name: item.name,
            success: outcome.is_ok(),
            error: outcome.err(),
        });
    }
    Ok(results)
}

pub fn items_from_snapshot(snapshot: &serde_json::Value) -> Vec<StartupItem> {
    snapshot
        .get("startupItems")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}
