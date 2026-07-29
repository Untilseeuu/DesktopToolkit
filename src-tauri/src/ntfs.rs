use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, BufWriter, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const USN_V2_MINIMUM_LENGTH: usize = 60;
const NTFS_FILE_RECORD_INDEX_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;
const NTFS_ROOT_FILE_RECORD_INDEX: u64 = 5;

fn file_record_index(reference: u64) -> u64 {
    reference & NTFS_FILE_RECORD_INDEX_MASK
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MftRecord {
    pub(crate) file_reference: u64,
    pub(crate) parent_reference: u64,
    pub(crate) attributes: u32,
    pub(crate) name: String,
}

impl MftRecord {
    pub(crate) fn is_directory(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DirectoryRecord {
    parent_reference: u64,
    name: String,
}

impl DirectoryRecord {
    pub(crate) fn new(parent_reference: u64, name: impl Into<String>) -> Self {
        Self {
            parent_reference,
            name: name.into(),
        }
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

pub(crate) fn parse_usn_output(bytes: &[u8]) -> Result<(u64, Vec<MftRecord>), String> {
    let next_reference =
        read_u64(bytes, 0).ok_or_else(|| "MFT 响应缺少下一条记录位置".to_string())?;
    let mut records = Vec::new();
    let mut offset = 8usize;
    while offset < bytes.len() {
        let record_length = read_u32(bytes, offset).unwrap_or(0) as usize;
        if record_length == 0 {
            break;
        }
        if record_length < USN_V2_MINIMUM_LENGTH || offset + record_length > bytes.len() {
            return Err("MFT 返回了损坏的 USN 记录".into());
        }
        let major_version = read_u16(bytes, offset + 4).unwrap_or_default();
        if major_version == 2 {
            let file_reference = file_record_index(
                read_u64(bytes, offset + 8).ok_or_else(|| "USN 记录缺少文件引用".to_string())?,
            );
            let parent_reference = file_record_index(
                read_u64(bytes, offset + 16).ok_or_else(|| "USN 记录缺少父目录引用".to_string())?,
            );
            let attributes =
                read_u32(bytes, offset + 52).ok_or_else(|| "USN 记录缺少文件属性".to_string())?;
            let name_length = read_u16(bytes, offset + 56).unwrap_or_default() as usize;
            let name_offset = read_u16(bytes, offset + 58).unwrap_or_default() as usize;
            if name_length % 2 != 0
                || name_offset < USN_V2_MINIMUM_LENGTH
                || name_offset + name_length > record_length
            {
                return Err("USN 记录中的文件名范围无效".into());
            }
            let name_bytes = &bytes[offset + name_offset..offset + name_offset + name_length];
            let name_utf16 = name_bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            records.push(MftRecord {
                file_reference,
                parent_reference,
                attributes,
                name: String::from_utf16_lossy(&name_utf16),
            });
        }
        offset += record_length;
    }
    Ok((next_reference, records))
}

pub(crate) fn resolve_all_directory_paths(
    directories: &HashMap<u64, DirectoryRecord>,
    volume_root: &str,
) -> HashMap<u64, PathBuf> {
    fn resolve_one(
        reference: u64,
        directories: &HashMap<u64, DirectoryRecord>,
        volume_root: &str,
        resolved: &mut HashMap<u64, PathBuf>,
        visiting: &mut HashSet<u64>,
    ) -> Option<PathBuf> {
        if let Some(path) = resolved.get(&reference) {
            return Some(path.clone());
        }
        if !visiting.insert(reference) {
            return None;
        }
        if reference == NTFS_ROOT_FILE_RECORD_INDEX {
            let path = PathBuf::from(volume_root);
            resolved.insert(reference, path.clone());
            visiting.remove(&reference);
            return Some(path);
        }
        let directory = directories.get(&reference)?;
        let path = if directory.parent_reference == reference {
            PathBuf::from(volume_root)
        } else {
            let mut parent = resolve_one(
                directory.parent_reference,
                directories,
                volume_root,
                resolved,
                visiting,
            )?;
            parent.push(&directory.name);
            parent
        };
        visiting.remove(&reference);
        resolved.insert(reference, path.clone());
        Some(path)
    }

    let mut resolved = HashMap::with_capacity(directories.len());
    let mut visiting = HashSet::new();
    for reference in directories.keys().copied() {
        visiting.clear();
        let _ = resolve_one(
            reference,
            directories,
            volume_root,
            &mut resolved,
            &mut visiting,
        );
    }
    resolved
}

pub(crate) fn volume_letter(path: &Path) -> Option<char> {
    let value = path.to_string_lossy();
    let value = value.strip_prefix(r"\\?\").unwrap_or(&value);
    let bytes = value.as_bytes();
    if bytes.len() == 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        Some((bytes[0] as char).to_ascii_uppercase())
    } else {
        None
    }
}

#[derive(Debug)]
pub(crate) enum FastIndexEvent {
    Entry { path: PathBuf, is_directory: bool },
    Progress { discovered: usize },
}

fn write_event(stream: &mut impl Write, event: &FastIndexEvent) -> Result<(), String> {
    match event {
        FastIndexEvent::Entry { path, is_directory } => {
            let path = path.to_string_lossy();
            let bytes = path.as_bytes();
            stream
                .write_all(&[if *is_directory { 2 } else { 1 }])
                .and_then(|_| stream.write_all(&(bytes.len() as u32).to_le_bytes()))
                .and_then(|_| stream.write_all(bytes))
                .map_err(|error| error.to_string())
        }
        FastIndexEvent::Progress { discovered } => stream
            .write_all(&[3])
            .and_then(|_| stream.write_all(&(*discovered as u64).to_le_bytes()))
            .and_then(|_| stream.flush())
            .map_err(|error| error.to_string()),
    }
}

fn read_event(stream: &mut impl Read) -> Result<Option<FastIndexEvent>, String> {
    let mut kind = [0u8; 1];
    stream
        .read_exact(&mut kind)
        .map_err(|error| error.to_string())?;
    match kind[0] {
        0 => Ok(None),
        1 | 2 => {
            let mut length = [0u8; 4];
            stream
                .read_exact(&mut length)
                .map_err(|error| error.to_string())?;
            let length = u32::from_le_bytes(length) as usize;
            if length > 32 * 1024 {
                return Err("MFT 路径长度超过安全上限".into());
            }
            let mut bytes = vec![0u8; length];
            stream
                .read_exact(&mut bytes)
                .map_err(|error| error.to_string())?;
            Ok(Some(FastIndexEvent::Entry {
                path: PathBuf::from(String::from_utf8_lossy(&bytes).to_string()),
                is_directory: kind[0] == 2,
            }))
        }
        3 => {
            let mut value = [0u8; 8];
            stream
                .read_exact(&mut value)
                .map_err(|error| error.to_string())?;
            Ok(Some(FastIndexEvent::Progress {
                discovered: u64::from_le_bytes(value) as usize,
            }))
        }
        255 => {
            let mut length = [0u8; 4];
            stream
                .read_exact(&mut length)
                .map_err(|error| error.to_string())?;
            let mut bytes = vec![0u8; u32::from_le_bytes(length).min(16_384) as usize];
            stream
                .read_exact(&mut bytes)
                .map_err(|error| error.to_string())?;
            Err(String::from_utf8_lossy(&bytes).to_string())
        }
        _ => Err("MFT 辅助进程返回了未知消息".into()),
    }
}

#[cfg(target_os = "windows")]
mod windows_fast_index {
    use super::*;
    use std::{mem::size_of, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_HANDLE_EOF, GENERIC_READ, GENERIC_WRITE,
            INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{
            CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::{
            Ioctl::{FSCTL_ENUM_USN_DATA, MFT_ENUM_DATA_V0},
            IO::DeviceIoControl,
        },
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_HIDE},
    };

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }

    fn enumerate_raw(
        volume: char,
        mut callback: impl FnMut(&MftRecord) -> Result<(), String>,
    ) -> Result<usize, String> {
        let device = wide(&format!(r"\\.\{volume}:"));
        let handle = unsafe {
            CreateFileW(
                device.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "无法读取 {volume}: 的 NTFS 主文件表，系统错误 {}",
                unsafe { GetLastError() }
            ));
        }
        let result = (|| {
            let mut cursor = MFT_ENUM_DATA_V0 {
                StartFileReferenceNumber: 0,
                LowUsn: 0,
                HighUsn: i64::MAX,
            };
            let mut output = vec![0u8; 1024 * 1024];
            let mut total = 0usize;
            loop {
                let mut returned = 0u32;
                let success = unsafe {
                    DeviceIoControl(
                        handle,
                        FSCTL_ENUM_USN_DATA,
                        &cursor as *const _ as *const _,
                        size_of::<MFT_ENUM_DATA_V0>() as u32,
                        output.as_mut_ptr() as *mut _,
                        output.len() as u32,
                        &mut returned,
                        ptr::null_mut(),
                    )
                };
                if success == 0 {
                    let error = unsafe { GetLastError() };
                    if error == ERROR_HANDLE_EOF {
                        break;
                    }
                    return Err(format!("读取 {volume}: 的 MFT 失败，系统错误 {error}"));
                }
                if returned < 8 {
                    break;
                }
                let (next, records) = parse_usn_output(&output[..returned as usize])?;
                if next <= cursor.StartFileReferenceNumber {
                    break;
                }
                cursor.StartFileReferenceNumber = next;
                for record in &records {
                    callback(record)?;
                }
                total = total.saturating_add(records.len());
            }
            Ok(total)
        })();
        unsafe {
            CloseHandle(handle);
        }
        result
    }

    fn scan_volume(
        volume: char,
        callback: &mut impl FnMut(FastIndexEvent) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut directories = HashMap::<u64, DirectoryRecord>::new();
        let mut discovered = 0usize;
        enumerate_raw(volume, |record| {
            discovered = discovered.saturating_add(1);
            if record.is_directory() {
                directories.insert(
                    record.file_reference,
                    DirectoryRecord::new(record.parent_reference, record.name.clone()),
                );
            }
            if discovered % 65_536 == 0 {
                callback(FastIndexEvent::Progress { discovered })?;
            }
            Ok(())
        })?;
        callback(FastIndexEvent::Progress { discovered })?;

        let root = format!("{volume}:\\");
        let directory_paths = resolve_all_directory_paths(&directories, &root);
        enumerate_raw(volume, |record| {
            let path = if record.is_directory() {
                directory_paths.get(&record.file_reference).cloned()
            } else {
                directory_paths
                    .get(&record.parent_reference)
                    .map(|parent| parent.join(&record.name))
            };
            if let Some(path) = path {
                callback(FastIndexEvent::Entry {
                    path,
                    is_directory: record.is_directory(),
                })?;
            }
            Ok(())
        })?;
        Ok(())
    }

    pub(super) fn run_helper(port: u16, token: &str, volumes: &[char]) -> Result<(), String> {
        let mut stream =
            TcpStream::connect(("127.0.0.1", port)).map_err(|error| error.to_string())?;
        writeln!(stream, "ATLAS-MFT-1 {token}").map_err(|error| error.to_string())?;
        let mut stream = BufWriter::with_capacity(1024 * 1024, stream);
        // Confirm that UAC authorization and the IPC handshake completed
        // before the first potentially expensive MFT pass begins.
        write_event(&mut stream, &FastIndexEvent::Progress { discovered: 0 })?;
        let result = volumes.iter().try_for_each(|volume| {
            scan_volume(*volume, &mut |event| write_event(&mut stream, &event))
        });
        match result {
            Ok(()) => stream
                .write_all(&[0])
                .and_then(|_| stream.flush())
                .map_err(|error| error.to_string()),
            Err(error) => {
                let bytes = error.as_bytes();
                let _ = stream.write_all(&[255]);
                let _ = stream.write_all(&(bytes.len() as u32).to_le_bytes());
                let _ = stream.write_all(bytes);
                let _ = stream.flush();
                Err(error)
            }
        }
    }

    pub(super) fn launch_elevated(port: u16, token: &str, volumes: &[char]) -> Result<(), String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let volume_list = volumes.iter().collect::<String>();
        let parameters = wide(&format!(
            "--atlas-mft-helper --port {port} --token {token} --volumes {volume_list}"
        ));
        let verb = wide("runas");
        let executable = wide(&executable.to_string_lossy());
        let result = unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                verb.as_ptr(),
                executable.as_ptr(),
                parameters.as_ptr(),
                ptr::null(),
                SW_HIDE,
            )
        };
        if result as isize <= 32 {
            Err("用户取消了 NTFS 高速索引授权，已回退普通扫描".into())
        } else {
            Ok(())
        }
    }
}

pub(crate) fn run_helper_if_requested() -> Option<Result<(), String>> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if !arguments
        .iter()
        .any(|argument| argument == "--atlas-mft-helper")
    {
        return None;
    }
    let argument = |name: &str| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    };
    let port = argument("--port")
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "MFT 辅助进程端口无效".to_string());
    let token = argument("--token").ok_or_else(|| "MFT 辅助进程令牌缺失".to_string());
    let volumes = argument("--volumes")
        .map(|value| {
            value
                .chars()
                .filter(|character| character.is_ascii_alphabetic())
                .map(|character| character.to_ascii_uppercase())
                .collect::<Vec<_>>()
        })
        .filter(|volumes| !volumes.is_empty())
        .ok_or_else(|| "MFT 辅助进程磁盘列表无效".to_string());
    Some(port.and_then(|port| {
        token.and_then(|token| {
            volumes.and_then(|volumes| {
                #[cfg(target_os = "windows")]
                {
                    windows_fast_index::run_helper(port, &token, &volumes)
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = (port, token, volumes);
                    Err("MFT 高速索引仅支持 Windows".into())
                }
            })
        })
    }))
}

pub(crate) fn scan_volumes_elevated(
    volumes: &[char],
    mut callback: impl FnMut(FastIndexEvent) -> Result<(), String>,
) -> Result<(), String> {
    if volumes.is_empty() {
        return Err("没有可进行 MFT 索引的 NTFS 磁盘".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let token = format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default(),
        volumes.iter().map(|value| *value as u64).sum::<u64>()
    );
    #[cfg(target_os = "windows")]
    windows_fast_index::launch_elevated(port, &token, volumes)?;
    #[cfg(not(target_os = "windows"))]
    return Err("MFT 高速索引仅支持 Windows".into());

    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err("等待 NTFS 高速索引授权超时".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    // On Windows an accepted socket can retain the listener's nonblocking
    // mode. The helper may not have written its handshake yet, so a direct
    // read would otherwise fail with WSAEWOULDBLOCK (10035).
    stream
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|error| error.to_string())?;
    let mut hello = Vec::with_capacity(96);
    while hello.len() < 256 {
        let mut byte = [0u8; 1];
        stream
            .read_exact(&mut byte)
            .map_err(|error| error.to_string())?;
        if byte[0] == b'\n' {
            break;
        }
        hello.push(byte[0]);
    }
    let hello = String::from_utf8_lossy(&hello);
    if hello.trim() != format!("ATLAS-MFT-1 {token}") {
        return Err("MFT 辅助进程身份校验失败".into());
    }
    let mut stream = BufReader::with_capacity(1024 * 1024, stream);
    loop {
        match read_event(&mut stream)? {
            Some(event) => callback(event)?,
            None => return Ok(()),
        }
    }
}
