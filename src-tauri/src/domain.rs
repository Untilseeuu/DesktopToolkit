#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationPlan {
    Noop,
    Initialize { target: String },
    Migrate { source: String, target: String },
}

fn normalized(path: &str) -> String {
    path.trim().trim_end_matches(['\\', '/']).to_lowercase()
}

pub fn migration_plan(current: &str, target: &str, database_exists: bool) -> MigrationPlan {
    if normalized(current) == normalized(target) {
        return MigrationPlan::Noop;
    }
    if database_exists {
        MigrationPlan::Migrate {
            source: current.trim_end_matches(['\\', '/']).into(),
            target: target.trim_end_matches(['\\', '/']).into(),
        }
    } else {
        MigrationPlan::Initialize {
            target: target.trim_end_matches(['\\', '/']).into(),
        }
    }
}

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
        "/tools/startup/enabled",
        "/tools/search/enabled",
        "/tools/prompts/enabled",
        "/tools/clipboard/enabled",
        "/settings/shortcuts/search",
        "/settings/shortcuts/prompts",
        "/settings/shortcuts/clipboard",
    ]
    .iter()
    .any(|pointer| runtime_value(previous, pointer) != runtime_value(next, pointer))
}
use std::path::{Path, PathBuf};
