use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OpenFlags};

use crate::domain::default_data_directory;

const DATABASE_NAME: &str = "atlas.db";
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

fn retire_legacy_pointer(pointer: &Path) {
    for artifact in [
        pointer.to_path_buf(),
        pointer.with_file_name(LOCATION_BACKUP),
        pointer.with_file_name("data-location.backup.json"),
    ] {
        let _ = fs::remove_file(artifact);
    }
}

pub struct StorageManager {
    data_dir: RwLock<PathBuf>,
    operation_gate: Mutex<()>,
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
        let data_dir = select_writable_default(&default_data_directory(executable))?;
        retire_legacy_pointer(&data_dir.join(LOCATION_POINTER));
        if let Some(legacy_pointer) = legacy_pointer {
            retire_legacy_pointer(legacy_pointer);
        }
        let manager = Self {
            data_dir: RwLock::new(data_dir),
            operation_gate: Mutex::new(()),
        };
        manager.with_connection(|_| Ok(()))?;
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
}
