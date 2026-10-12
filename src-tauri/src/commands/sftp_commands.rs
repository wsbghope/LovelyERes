// All SFTP operations (list, read, write, upload, download, compress, extract, chmod, get_file_details)

use crate::AppState;
use crate::ssh_manager_russh;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use tauri::State;

const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const UPLOAD_TEMP_PREFIX: &str = "upload-";

fn upload_session_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 清理上次运行崩溃或断电时残留的上传临时文件。
///
/// `sftp_upload_bytes` 正常路径会自行删除临时文件，但进程异常终止时
/// 那一行不会执行。应用数据目录不像系统临时目录那样会被操作系统自动
/// 回收，所以需要在启动时兜底清理一次。
pub fn cleanup_stale_upload_files() {
    let Ok(paths) = crate::types::AppDataPaths::new() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&paths.temp_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(UPLOAD_TEMP_PREFIX) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(entry.path()) {
            eprintln!("清理残留上传临时文件失败 {:?}: {}", entry.path(), error);
        }
    }
}

fn validate_upload_file_name(file_name: &str) -> Result<(), String> {
    use std::path::{Component, Path};

    let mut components = Path::new(file_name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) if !file_name.trim().is_empty() => Ok(()),
        _ => Err("临时文件名必须是不含路径的普通文件名".to_string()),
    }
}

fn save_upload_temp_file(file_name: &str, data: &[u8]) -> Result<std::path::PathBuf, String> {
    validate_upload_file_name(file_name)?;
    if data.len() as u64 > MAX_UPLOAD_BYTES {
        return Err("单个上传文件不能超过 512 MiB".to_string());
    }

    let paths = crate::types::AppDataPaths::new()
        .map_err(|e| format!("创建应用临时目录失败: {}", e))?;
    let temp_file_path = paths
        .temp_dir
        .join(format!("upload-{}-{}", uuid::Uuid::new_v4(), file_name));
    std::fs::write(&temp_file_path, data)
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    Ok(temp_file_path)
}

struct UploadSessionPaths {
    data: std::path::PathBuf,
    metadata: std::path::PathBuf,
    ready: std::path::PathBuf,
}

fn upload_session_paths(upload_id: &str) -> Result<UploadSessionPaths, String> {
    let id = uuid::Uuid::parse_str(upload_id)
        .map_err(|_| "无效的上传会话 ID".to_string())?;
    let paths = crate::types::AppDataPaths::new()
        .map_err(|e| format!("创建应用临时目录失败: {}", e))?;
    Ok(UploadSessionPaths {
        data: paths.temp_dir.join(format!("upload-{id}")),
        metadata: paths.temp_dir.join(format!("upload-{id}.size")),
        ready: paths.temp_dir.join(format!("upload-{id}.ready")),
    })
}

fn read_expected_upload_size(path: &std::path::Path) -> Result<u64, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("读取上传会话失败: {}", e))?;
    raw.parse::<u64>()
        .map_err(|_| "上传会话元数据无效".to_string())
}

#[tauri::command]
pub async fn sftp_list_files(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<ssh_manager_russh::SftpFileInfo>, String> {
    let manager = &state.ssh_manager;
    manager.list_sftp_files(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_read_file(
    path: String,
    max_bytes: Option<usize>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let manager = &state.ssh_manager;
    let limit = max_bytes
        .unwrap_or(MAX_TEXT_PREVIEW_BYTES)
        .min(MAX_TEXT_PREVIEW_BYTES);
    let content = manager
        .read_sftp_file_limited(&path, limit)
        .map_err(|e| e.to_string())?;

    let mut text = match String::from_utf8(content) {
        Ok(text) => text,
        Err(error) if error.utf8_error().error_len().is_none() => {
            let valid = error.utf8_error().valid_up_to();
            String::from_utf8(error.into_bytes()[..valid].to_vec())
                .map_err(|e| format!("Failed to decode file as UTF-8: {}", e))?
        }
        Err(error) => return Err(format!("Failed to decode file as UTF-8: {}", error)),
    };
    if text.len() > limit {
        let mut boundary = limit;
        while boundary > 0 && !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
    }
    Ok(text)
}

#[tauri::command]
pub async fn sftp_chmod(path: String, mode: u32, state: State<'_, AppState>) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager.chmod_sftp(&path, mode).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_get_file_details(
    path: String,
    state: State<'_, AppState>,
) -> Result<ssh_manager_russh::SftpFileDetails, String> {
    let manager = &state.ssh_manager;
    manager.get_file_details(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_write_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .write_sftp_file(&path, content.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_compress(
    source_path: String,
    target_path: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .compress_file(&source_path, &target_path, &format)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_extract(
    archive_path: String,
    target_dir: String,
    overwrite: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .extract_file(&archive_path, &target_dir, overwrite)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_upload(
    local_path: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .upload_file(&local_path, &remote_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_download(
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .download_file(&remote_path, &local_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_create_directory(
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .create_directory(&remote_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .rename_sftp_file(&old_path, &new_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_delete(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = &state.ssh_manager;
    manager
        .delete_sftp_file(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_upload_bytes(
    file_name: String,
    data: Vec<u8>,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let temp_file_path = save_upload_temp_file(&file_name, &data)?;
    let temp_path_string = temp_file_path.to_string_lossy().to_string();
    let upload_result = state
        .ssh_manager
        .upload_file(&temp_path_string, &remote_path)
        .map_err(|e| e.to_string());

    if let Err(error) = std::fs::remove_file(&temp_file_path) {
        eprintln!("清理上传临时文件失败 {:?}: {}", temp_file_path, error);
    }

    upload_result
}

#[tauri::command]
pub async fn sftp_upload_begin(file_name: String, total_size: u64) -> Result<String, String> {
    validate_upload_file_name(&file_name)?;
    if total_size > MAX_UPLOAD_BYTES {
        return Err("单个上传文件不能超过 512 MiB".to_string());
    }

    let upload_id = uuid::Uuid::new_v4();
    let paths = upload_session_paths(&upload_id.to_string())?;
    let _guard = upload_session_lock()
        .lock()
        .map_err(|_| "上传会话锁已损坏".to_string())?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&paths.data)
        .map_err(|e| format!("创建上传临时文件失败: {}", e))?;
    if let Err(error) = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&paths.metadata)
        .and_then(|mut file| write!(file, "{total_size}"))
    {
        let _ = std::fs::remove_file(&paths.data);
        return Err(format!("创建上传会话失败: {}", error));
    }
    Ok(upload_id.to_string())
}

#[tauri::command]
pub async fn sftp_upload_chunk(upload_id: String, data: Vec<u8>) -> Result<(), String> {
    let paths = upload_session_paths(&upload_id)?;
    let _guard = upload_session_lock()
        .lock()
        .map_err(|_| "上传会话锁已损坏".to_string())?;
    let expected_size = read_expected_upload_size(&paths.metadata)?;
    let current_size = std::fs::metadata(&paths.data)
        .map_err(|e| format!("读取上传会话失败: {}", e))?
        .len();
    if current_size.saturating_add(data.len() as u64) > expected_size {
        return Err("上传数据超过文件声明大小".to_string());
    }

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&paths.data)
        .map_err(|e| format!("打开上传临时文件失败: {}", e))?;
    file.write_all(&data)
        .map_err(|e| format!("写入上传分块失败: {}", e))
}

#[tauri::command]
pub async fn sftp_upload_finish(
    upload_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let paths = upload_session_paths(&upload_id)?;
    {
        let _guard = upload_session_lock()
            .lock()
            .map_err(|_| "上传会话锁已损坏".to_string())?;
        let expected_size = read_expected_upload_size(&paths.metadata)?;
        let actual_size = std::fs::metadata(&paths.data)
            .map_err(|e| format!("读取上传会话失败: {}", e))?
            .len();
        if actual_size != expected_size {
            return Err(format!(
                "上传数据不完整：期望 {} 字节，实际 {} 字节",
                expected_size, actual_size
            ));
        }
        std::fs::rename(&paths.data, &paths.ready)
            .map_err(|e| format!("锁定待上传文件失败: {}", e))?;
        if let Err(error) = std::fs::remove_file(&paths.metadata) {
            let _ = std::fs::rename(&paths.ready, &paths.data);
            return Err(format!("更新上传会话失败: {}", error));
        }
    }

    let temp_path_string = paths.ready.to_string_lossy().to_string();
    let result = state
        .ssh_manager
        .upload_file(&temp_path_string, &remote_path)
        .map_err(|e| e.to_string());
    if let Err(error) = std::fs::remove_file(&paths.ready) {
        eprintln!("清理上传临时文件失败 {:?}: {}", paths.ready, error);
    }
    result
}

#[tauri::command]
pub async fn sftp_upload_cancel(upload_id: String) -> Result<(), String> {
    let paths = upload_session_paths(&upload_id)?;
    let _guard = upload_session_lock()
        .lock()
        .map_err(|_| "上传会话锁已损坏".to_string())?;
    let mut cleanup_error = None;
    for path in [&paths.data, &paths.metadata] {
        if let Err(error) = std::fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                cleanup_error = Some(format!("清理上传临时文件失败: {}", error));
            }
        }
    }
    cleanup_error.map_or(Ok(()), Err)
}
