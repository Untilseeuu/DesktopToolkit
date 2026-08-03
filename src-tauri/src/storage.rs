use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use parking_lot::{Mutex, MutexGuard, RwLock};
use rusqlite::{Connection, OpenFlags};

use crate::domain::default_data_directory;

const DATABASE_NAME: &str = "atlas.db";
const SEARCH_DATABASE_NAME: &str = "search-index.db";
const LOCATION_POINTER: &str = "data-location.json";
const LOCATION_BACKUP: &str = "data-location.backup";

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
    verify_writable_directory(preferred).map_err(|error| {
        format!(
            "软件安装目录内的 data 文件夹不可写（{}）：{error}。请将 Atlas 安装到当前用户可写的目录",
            preferred.display()
        )
    })?;
    Ok(preferred.to_path_buf())
}

fn retire_location_pointer(pointer: &Path) {
    for artifact in [
        pointer.to_path_buf(),
        pointer.with_file_name(LOCATION_BACKUP),
        pointer.with_file_name("data-location.backup.json"),
    ] {
        let _ = fs::remove_file(artifact);
    }
}

fn read_location_pointer(pointer: &Path) -> Option<PathBuf> {
    let value = serde_json::from_slice::<serde_json::Value>(&fs::read(pointer).ok()?).ok()?;
    let path = value
        .get("dataDirectory")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.as_str())?;
    let directory = PathBuf::from(path);
    directory.is_dir().then_some(directory)
}

fn write_location_pointer(pointer: &Path, data_dir: &Path) -> Result<(), String> {
    if let Some(parent) = pointer.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = pointer.with_extension("tmp");
    let payload = serde_json::to_vec_pretty(&serde_json::json!({
        "dataDirectory": data_dir
    }))
    .map_err(|error| error.to_string())?;
    fs::write(&temporary, payload).map_err(|error| error.to_string())?;
    if pointer.exists() {
        fs::remove_file(pointer).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, pointer).map_err(|error| error.to_string())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with("-wal") || name.ends_with("-shm") || name == ".atlas-write-test" {
                continue;
            }
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "复制 {} 到 {} 失败：{error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn replace_path_prefix(value: &mut serde_json::Value, old: &Path, new: &Path) {
    match value {
        serde_json::Value::String(text) => {
            let old = old.to_string_lossy();
            if text
                .to_ascii_lowercase()
                .starts_with(&old.to_ascii_lowercase())
            {
                *text = format!("{}{}", new.to_string_lossy(), &text[old.len()..]);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                replace_path_prefix(value, old, new);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values_mut() {
                replace_path_prefix(value, old, new);
            }
        }
        _ => {}
    }
}

fn checkpoint_database(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(15))
        .map_err(|error| error.to_string())?;
    let busy = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| error.to_string())?;
    if busy != 0 {
        return Err(format!(
            "数据库正在使用中，暂时无法移动：{}",
            path.display()
        ));
    }
    Ok(())
}

fn configure_read_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "
            PRAGMA query_only = ON;
            PRAGMA cache_size = -8192;
            PRAGMA mmap_size = 67108864;
            PRAGMA temp_store = MEMORY;
            ",
        )
        .map_err(|error| error.to_string())
}

pub struct StorageManager {
    data_dir: RwLock<PathBuf>,
    location_pointer: PathBuf,
    operation_gate: Mutex<()>,
    index_gate: Mutex<()>,
}

impl StorageManager {
    pub fn initialize() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let legacy_pointer = std::env::var("APPDATA")
            .ok()
            .map(PathBuf::from)
            .map(|roaming| {
                roaming
                    .join("atlas")
                    .join("desktop-toolkit")
                    .join("config")
                    .join(LOCATION_POINTER)
            });
        Self::initialize_for_executable(&executable, legacy_pointer.as_deref())
    }

    fn initialize_for_executable(
        executable: &Path,
        legacy_pointer: Option<&Path>,
    ) -> Result<Self, String> {
        let location_pointer = legacy_pointer.map(Path::to_path_buf).unwrap_or_else(|| {
            executable
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(LOCATION_POINTER)
        });
        let selected = read_location_pointer(&location_pointer);
        if selected.is_none() && location_pointer.exists() {
            retire_location_pointer(&location_pointer);
        }
        let preferred = selected.unwrap_or_else(|| default_data_directory(executable));
        let data_dir = match select_writable_default(&preferred) {
            Ok(directory) => directory,
            Err(error) if preferred != default_data_directory(executable) => {
                retire_location_pointer(&location_pointer);
                select_writable_default(&default_data_directory(executable)).map_err(|_| error)?
            }
            Err(error) => return Err(error),
        };
        let manager = Self {
            data_dir: RwLock::new(data_dir),
            location_pointer,
            operation_gate: Mutex::new(()),
            index_gate: Mutex::new(()),
        };
        manager.initialize_database()?;
        manager.initialize_search_database()?;
        Ok(manager)
    }

    #[cfg(test)]
    pub(crate) fn for_installed_test_with_legacy_pointer(
        executable: &Path,
        legacy_pointer: &Path,
    ) -> Result<Self, String> {
        Self::initialize_for_executable(executable, Some(legacy_pointer))
    }

    #[cfg(test)]
    pub(crate) fn for_test(bootstrap_dir: PathBuf, data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&bootstrap_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let manager = Self {
            data_dir: RwLock::new(data_dir),
            location_pointer: bootstrap_dir.join(LOCATION_POINTER),
            operation_gate: Mutex::new(()),
            index_gate: Mutex::new(()),
        };
        manager.initialize_database()?;
        manager.initialize_search_database()?;
        Ok(manager)
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.read().clone()
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_dir().join(DATABASE_NAME)
    }

    pub fn search_database_path(&self) -> PathBuf {
        self.data_dir().join(SEARCH_DATABASE_NAME)
    }

    pub fn migrate_to_parent(&self, destination_parent: &Path) -> Result<PathBuf, String> {
        let current = self.data_dir();
        let target = destination_parent.join("data");
        if target == current {
            return Ok(current);
        }
        if destination_parent.starts_with(&current) || current.starts_with(&target) {
            return Err("新的存储位置不能位于当前 data 文件夹内部或包含当前 data 文件夹".into());
        }
        verify_writable_directory(destination_parent)?;
        if target.exists() {
            let mut entries = fs::read_dir(&target).map_err(|error| error.to_string())?;
            if entries.next().is_some() {
                return Err(format!(
                    "目标位置已经存在非空 data 文件夹：{}",
                    target.display()
                ));
            }
            fs::remove_dir(&target).map_err(|error| error.to_string())?;
        }

        let _operation = self.operation_gate.lock();
        let _index = self.index_gate.lock();
        checkpoint_database(&current.join(DATABASE_NAME))?;
        checkpoint_database(&current.join(SEARCH_DATABASE_NAME))?;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let staging = destination_parent.join(format!(".atlas-data-migration-{nonce}"));
        let result = (|| {
            copy_directory(&current, &staging)?;
            let state_path = staging.join(DATABASE_NAME);
            let connection = Connection::open(&state_path).map_err(|error| error.to_string())?;
            let stored = connection.query_row(
                "SELECT value FROM app_state WHERE key = 'snapshot'",
                [],
                |row| row.get::<_, String>(0),
            );
            if let Ok(json) = stored {
                let mut snapshot = serde_json::from_str::<serde_json::Value>(&json)
                    .map_err(|error| error.to_string())?;
                replace_path_prefix(&mut snapshot, &current, &target);
                snapshot["settings"]["dataDirectory"] =
                    serde_json::Value::String(target.to_string_lossy().to_string());
                connection
                    .execute(
                        "UPDATE app_state SET value = ?1, updated_at = unixepoch() WHERE key = 'snapshot'",
                        [serde_json::to_string(&snapshot).map_err(|error| error.to_string())?],
                    )
                    .map_err(|error| error.to_string())?;
            }
            drop(connection);
            Connection::open(staging.join(SEARCH_DATABASE_NAME))
                .and_then(|connection| {
                    connection
                        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                })
                .map_err(|error| error.to_string())
                .and_then(|result| {
                    (result == "ok")
                        .then_some(())
                        .ok_or("搜索索引校验失败".into())
                })?;
            fs::rename(&staging, &target).map_err(|error| error.to_string())?;
            if let Err(error) = write_location_pointer(&self.location_pointer, &target) {
                let _ = fs::remove_dir_all(&target);
                return Err(error);
            }
            *self.data_dir.write() = target.clone();
            let _ = fs::remove_dir_all(&current);
            Ok(target.clone())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub(crate) fn index_write_guard(&self) -> MutexGuard<'_, ()> {
        self.index_gate.lock()
    }

    #[cfg(test)]
    pub fn with_state_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operation_gate.lock();
        let mut connection = self.open_connection()?;
        operation(&mut connection)
    }

    #[cfg(test)]
    pub fn with_search_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.index_gate.lock();
        let mut connection = self.open_search_connection()?;
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
        configure_read_connection(&connection)?;
        operation(&connection)
    }

    pub fn with_search_read_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let connection = Connection::open_with_flags(
            self.search_database_path(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| error.to_string())?;
        configure_read_connection(&connection)?;
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
            .execute_batch("PRAGMA synchronous = NORMAL;")
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn open_search_connection(&self) -> Result<Connection, String> {
        let database_path = self.search_database_path();
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(8))
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA synchronous = NORMAL;")
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn initialize_database(&self) -> Result<(), String> {
        let _operation = self.operation_gate.lock();
        let connection = self.open_connection()?;
        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                DROP TABLE IF EXISTS search_fts;
                DROP TABLE IF EXISTS search_entries;
                DROP TABLE IF EXISTS search_meta;
                DROP TABLE IF EXISTS search_build_meta;
                DROP TABLE IF EXISTS search_build_dirty_paths;
                ",
            )
            .map_err(|error| error.to_string())
    }

    fn initialize_search_database(&self) -> Result<(), String> {
        let _operation = self.index_gate.lock();
        let connection = self.open_search_connection()?;
        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS search_meta (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    scope TEXT NOT NULL,
                    complete INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS search_build_meta (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    scope TEXT NOT NULL,
                    completed_roots INTEGER NOT NULL DEFAULT 0,
                    indexed_items INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS search_build_dirty_paths (
                    path TEXT PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS search_build_directories (
                    path TEXT PRIMARY KEY COLLATE NOCASE,
                    root_index INTEGER NOT NULL,
                    started INTEGER NOT NULL DEFAULT 0
                );
                DROP TABLE IF EXISTS search_entries;
                ",
            )
            .map_err(|error| error.to_string())?;
        let has_directory_started = connection
            .prepare("PRAGMA table_info(search_build_directories)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                for column in columns {
                    if column?.eq_ignore_ascii_case("started") {
                        return Ok(true);
                    }
                }
                Ok(false)
            })
            .map_err(|error| error.to_string())?;
        if !has_directory_started {
            connection
                .execute(
                    "ALTER TABLE search_build_directories
                     ADD COLUMN started INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        let fts_schema = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'",
            [],
            |row| row.get::<_, String>(0),
        );
        let has_trigram_schema = fts_schema
            .as_ref()
            .map(|schema| {
                let schema = schema.to_ascii_lowercase();
                schema.contains("trigram") && schema.contains("path unindexed")
            })
            .unwrap_or(false);
        if !has_trigram_schema {
            connection
                .execute_batch(
                    "
                    DROP TABLE IF EXISTS search_fts;
                    CREATE VIRTUAL TABLE search_fts USING fts5(
                        name,
                        path UNINDEXED,
                        kind UNINDEXED,
                        modified_at UNINDEXED,
                        tokenize = 'trigram'
                    );
                    ",
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn load_snapshot(&self) -> Result<serde_json::Value, String> {
        self.with_read_connection(|connection| {
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
}
