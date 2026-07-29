use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const LOG_DIRECTORY: &str = "logs";
const LOG_FILE: &str = "atlas-runtime.log";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const LOG_BACKUPS: usize = 3;
static LOG_WRITE_GATE: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LOG_DIRECTORY).join(LOG_FILE)
}

fn rotate(path: &Path) -> Result<(), String> {
    if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) < MAX_LOG_BYTES {
        return Ok(());
    }
    for index in (1..=LOG_BACKUPS).rev() {
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            path.with_file_name(format!("{LOG_FILE}.{}", index - 1))
        };
        let destination = path.with_file_name(format!("{LOG_FILE}.{index}"));
        if source.exists() {
            if destination.exists() {
                fs::remove_file(&destination).map_err(|error| error.to_string())?;
            }
            fs::rename(source, destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn sanitize_line(line: &str) -> String {
    let single_line = line
        .replace(['\r', '\n'], " ")
        .trim()
        .chars()
        .take(MAX_LINE_BYTES)
        .collect::<String>();
    if single_line.is_empty() {
        "[invalid empty runtime log entry]".into()
    } else {
        single_line
    }
}

pub(crate) fn append_lines(data_dir: &Path, lines: &[String]) -> Result<PathBuf, String> {
    let _guard = LOG_WRITE_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "运行日志写入锁异常".to_string())?;
    let path = log_path(data_dir);
    let directory = path
        .parent()
        .ok_or_else(|| "运行日志目录无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    rotate(&path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    for line in lines {
        writeln!(file, "{}", sanitize_line(line)).map_err(|error| error.to_string())?;
    }
    file.flush().map_err(|error| error.to_string())?;
    Ok(path)
}

pub(crate) fn append_event(data_dir: &Path, level: &str, action: &str, result: &str, detail: &str) {
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let _ = append_lines(
        data_dir,
        &[format!(
            "epoch_ms={epoch_ms} [{level}] action={action} result={result} detail={detail}"
        )],
    );
}
