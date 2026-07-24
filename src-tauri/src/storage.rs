use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, DatabaseName, OpenFlags};

use crate::domain::{default_data_directory, migration_plan, MigrationPlan};

const DATABASE_NAME: &str = "atlas.db";
const LOCATION_POINTER: &str = "data-location.json";
const LOCATION_BACKUP: &str = "data-location.backup";
const LOCATION_TEMPORARY: &str = "data-location.tmp";

fn verify_writable_directory(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let probe = directory.join(".atlas-write-test");
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&probe)
            .map_err(|error| error.to_string())?;
        file.write_all(b"atlas")
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(&probe);
    result
}

fn select_writable_default(preferred: &Path) -> Result<PathBuf, String> {
    if verify_writable_directory(preferred).is_ok() {
        return Ok(preferred.to_path_buf());
    }
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .map_err(|_| {
            format!(
                "应用目录不可写（{}），且无法确定备用数据目录",
                preferred.display()
            )
        })?
        .join("Atlas Desktop Toolkit")
        .join("data");
    verify_writable_directory(&local).map_err(|error| {
        format!(
            "应用目录和备用数据目录都不可写（{}）：{error}",
            local.display()
        )
    })?;
    Ok(local)
}

pub struct StorageManager {
    bootstrap_dir: PathBuf,
    data_dir: RwLock<PathBuf>,
    operation_gate: Mutex<()>,
}

impl StorageManager {
    pub fn initialize() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let preferred_data_dir = default_data_directory(&executable);
        let default_data_dir = select_writable_default(&preferred_data_dir)?;
        let bootstrap_dir = default_data_dir.clone();
        let pointer = bootstrap_dir.join(LOCATION_POINTER);
        let pointer_backup = bootstrap_dir.join(LOCATION_BACKUP);
        if !pointer.exists() {
            if let Ok(roaming) = std::env::var("APPDATA") {
                let legacy_pointer = PathBuf::from(roaming)
                    .join("atlas")
                    .join("desktop-toolkit")
                    .join("config")
                    .join(LOCATION_POINTER);
                if legacy_pointer.is_file() {
                    let _ = fs::copy(legacy_pointer, &pointer);
                }
            }
        }
        recover_location_pointer(&pointer, &pointer_backup)?;
        let data_dir = if pointer.exists() {
            let value = fs::read_to_string(&pointer).map_err(|error| error.to_string())?;
            serde_json::from_str::<PathBuf>(&value).map_err(|error| error.to_string())?
        } else {
            default_data_dir.clone()
        };
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let new_database = data_dir.join(DATABASE_NAME);
        if !new_database.exists() && data_dir == default_data_dir {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let legacy_database = PathBuf::from(local)
                    .join("atlas")
                    .join("desktop-toolkit")
                    .join("data")
                    .join(DATABASE_NAME);
                if legacy_database.is_file() {
                    let source =
                        Connection::open(&legacy_database).map_err(|error| error.to_string())?;
                    if let Err(error) = source.backup(DatabaseName::Main, &new_database, None) {
                        let _ = fs::remove_file(&new_database);
                        return Err(format!(
                            "迁移旧版数据失败（{} → {}）：{error}",
                            legacy_database.display(),
                            new_database.display()
                        ));
                    }
                }
            }
        }
        let manager = Self {
            bootstrap_dir,
            data_dir: RwLock::new(data_dir),
            operation_gate: Mutex::new(()),
        };
        manager.with_connection(|_| Ok(()))?;
        Ok(manager)
    }

    #[cfg(any())]
    fn initialize_legacy() -> Result<Self, String> {
        let project_dirs = ProjectDirs::from("com", "atlas", "desktop-toolkit")
            .ok_or_else(|| "无法确定系统应用数据目录".to_string())?;
        let bootstrap_dir = project_dirs.config_dir().to_path_buf();
        fs::create_dir_all(&bootstrap_dir).map_err(|error| error.to_string())?;
        let pointer = bootstrap_dir.join(LOCATION_POINTER);
        let pointer_backup = bootstrap_dir.join(LOCATION_BACKUP);
        recover_location_pointer(&pointer, &pointer_backup)?;
        let default_data_dir = project_dirs.data_local_dir().to_path_buf();
        let data_dir = if pointer.exists() {
            let value = fs::read_to_string(&pointer).map_err(|error| error.to_string())?;
            serde_json::from_str::<PathBuf>(&value).map_err(|error| error.to_string())?
        } else {
            default_data_dir
        };
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;

        let manager = Self {
            bootstrap_dir,
            data_dir: RwLock::new(data_dir),
            operation_gate: Mutex::new(()),
        };
        manager.with_connection(|_| Ok(()))?;
        Ok(manager)
    }

    #[cfg(test)]
    pub(crate) fn for_test(bootstrap_dir: PathBuf, data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&bootstrap_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let manager = Self {
            bootstrap_dir,
            data_dir: RwLock::new(data_dir),
            operation_gate: Mutex::new(()),
        };
        manager.with_connection(|_| Ok(()))?;
        Ok(manager)
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.read().clone()
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_dir().join(DATABASE_NAME)
    }

    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operation_gate.lock();
        let mut connection = self.open_connection()?;
        operation(&mut connection)
    }

    pub fn with_read_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let connection = Connection::open_with_flags(
            self.database_path(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())?;
        operation(&connection)
    }

    fn open_connection(&self) -> Result<Connection, String> {
        let database_path = self.database_path();
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(8))
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS search_meta (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    scope TEXT NOT NULL,
                    complete INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                DROP TABLE IF EXISTS search_entries;
                ",
            )
            .map_err(|error| error.to_string())?;
        let fts_schema = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'",
            [],
            |row| row.get::<_, String>(0),
        );
        let has_trigram_schema = fts_schema
            .as_ref()
            .map(|schema| schema.to_ascii_lowercase().contains("trigram"))
            .unwrap_or(false);
        if !has_trigram_schema {
            connection
                .execute_batch(
                    "
                    DROP TABLE IF EXISTS search_fts;
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
        }
        Ok(connection)
    }

    pub fn load_snapshot(&self) -> Result<serde_json::Value, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare("SELECT value FROM app_state WHERE key = 'snapshot'")
                .map_err(|error| error.to_string())?;
            let value = statement.query_row([], |row| row.get::<_, String>(0));
            match value {
                Ok(json) => serde_json::from_str(&json).map_err(|error| error.to_string()),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(serde_json::Value::Null),
                Err(error) => Err(error.to_string()),
            }
        })
    }

    pub fn update_snapshot<T>(
        &self,
        update: impl FnOnce(&mut serde_json::Value) -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operation_gate.lock();
        let mut connection = self.open_connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let stored = transaction.query_row(
            "SELECT value FROM app_state WHERE key = 'snapshot'",
            [],
            |row| row.get::<_, String>(0),
        );
        let mut snapshot = match stored {
            Ok(json) => serde_json::from_str(&json).map_err(|error| error.to_string())?,
            Err(rusqlite::Error::QueryReturnedNoRows) => serde_json::Value::Null,
            Err(error) => return Err(error.to_string()),
        };
        let result = update(&mut snapshot)?;
        let json = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
        transaction
            .execute(
                "
                INSERT INTO app_state(key, value, updated_at)
                VALUES ('snapshot', ?1, unixepoch())
                ON CONFLICT(key) DO UPDATE
                SET value = excluded.value, updated_at = excluded.updated_at
                ",
                [json],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(result)
    }

    pub fn migrate(&self, target: &Path) -> Result<PathBuf, String> {
        let _operation = self.operation_gate.lock();
        if target.as_os_str().is_empty() {
            return Err("请选择有效的数据目录".into());
        }
        if target.exists() && !target.is_dir() {
            return Err("目标位置不是目录".into());
        }

        let current = self.data_dir();
        let current_database = current.join(DATABASE_NAME);
        let plan = migration_plan(
            &current.to_string_lossy(),
            &target.to_string_lossy(),
            current_database.exists(),
        );
        if plan == MigrationPlan::Noop {
            return Ok(current);
        }

        fs::create_dir_all(target).map_err(|error| format!("无法创建目标目录：{error}"))?;
        let probe = target.join(".atlas-write-test");
        fs::write(&probe, b"atlas").map_err(|error| format!("目标目录不可写：{error}"))?;
        fs::remove_file(&probe).map_err(|error| error.to_string())?;

        if current_database.exists() {
            let connection = self.open_connection()?;
            let temporary = target.join("atlas.migrating.db");
            if temporary.exists() {
                fs::remove_file(&temporary).map_err(|error| error.to_string())?;
            }
            connection
                .backup(DatabaseName::Main, &temporary, None)
                .map_err(|error| format!("创建一致性数据库副本失败：{error}"))?;
            drop(connection);
            let validation = Connection::open(&temporary).map_err(|error| error.to_string())?;
            let integrity: String = validation
                .query_row("PRAGMA quick_check;", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            if integrity != "ok" {
                let _ = fs::remove_file(&temporary);
                return Err(format!("新数据库完整性检查失败：{integrity}"));
            }
            drop(validation);
            let final_database = target.join(DATABASE_NAME);
            if final_database.exists() {
                return Err("目标目录中已存在 atlas.db，请选择空目录".into());
            }
            fs::rename(&temporary, &final_database)
                .map_err(|error| format!("无法启用新数据库：{error}"))?;
        }

        if let Err(error) = self.write_location_pointer(target) {
            let final_database = target.join(DATABASE_NAME);
            if final_database.exists() && current_database.exists() {
                let _ = fs::remove_file(final_database);
            }
            return Err(error);
        }
        *self.data_dir.write() = target.to_path_buf();
        let _ = self.open_connection()?;
        Ok(target.to_path_buf())
    }

    fn write_location_pointer(&self, target: &Path) -> Result<(), String> {
        let pointer = self.bootstrap_dir.join(LOCATION_POINTER);
        let backup = self.bootstrap_dir.join(LOCATION_BACKUP);
        let temporary = self.bootstrap_dir.join(LOCATION_TEMPORARY);
        let payload = serde_json::to_vec(target).map_err(|error| error.to_string())?;
        fs::write(&temporary, payload).map_err(|error| error.to_string())?;
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        if pointer.exists() {
            fs::rename(&pointer, &backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(&temporary, &pointer) {
            if backup.exists() {
                let _ = fs::rename(&backup, &pointer);
            }
            return Err(format!("无法提交新的数据位置，已恢复原位置：{error}"));
        }
        cleanup_committed_backup(&backup);
        Ok(())
    }
}

pub(crate) fn cleanup_committed_backup(backup: &Path) {
    if backup.exists() {
        // The new pointer is already committed. A stale backup is harmless and
        // will be cleaned during the next startup; failure here is not rollback.
        let _ = fs::remove_file(backup);
    }
}

pub(crate) fn recover_location_pointer(pointer: &Path, backup: &Path) -> Result<(), String> {
    if pointer.exists() {
        if backup.exists() {
            fs::remove_file(backup).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    if backup.exists() {
        fs::rename(backup, pointer)
            .map_err(|error| format!("检测到未完成的数据位置切换，但恢复原位置失败：{error}"))?;
    }
    Ok(())
}
