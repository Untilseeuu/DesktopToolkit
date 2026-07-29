pub fn default_data_directory(executable: &Path) -> PathBuf {
    executable
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("data")
}

fn runtime_value<'a>(
    snapshot: &'a serde_json::Value,
    pointer: &str,
) -> Option<&'a serde_json::Value> {
    snapshot.pointer(pointer)
}

pub fn runtime_settings_changed(previous: &serde_json::Value, next: &serde_json::Value) -> bool {
    [
        "/settings/launchAtLogin",
        "/tools/search/enabled",
        "/tools/prompts/enabled",
        "/tools/clipboard/enabled",
        "/tools/folders/enabled",
        "/settings/shortcuts/search",
        "/settings/shortcuts/prompts",
        "/settings/shortcuts/clipboard",
        "/settings/indexSetup",
    ]
    .iter()
    .any(|pointer| runtime_value(previous, pointer) != runtime_value(next, pointer))
        || previous.get("folderFavorites") != next.get("folderFavorites")
}
use std::path::{Path, PathBuf};
