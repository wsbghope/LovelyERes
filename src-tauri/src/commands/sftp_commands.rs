// All SFTP operations (list, read, write, upload, download, compress, extract, chmod, get_file_details)

use tauri::State;
use crate::AppState;
use crate::ssh_manager_russh;

const MAX_IN_MEMORY_UPLOAD_BYTES: usize = 512 * 1024 * 1024;
const UPLOAD_TEMP_PREFIX: &str = "upload-";

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
    if data.len() > MAX_IN_MEMORY_UPLOAD_BYTES {
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
    let content = manager
        .read_sftp_file(&path)
        .map_err(|e| e.to_string())?;

    let mut text = String::from_utf8(content)
        .map_err(|e| format!("Failed to decode file as UTF-8: {}", e))?;
    if let Some(max) = max_bytes {
        if text.len() > max {
            let mut boundary = max;
            while boundary > 0 && !text.is_char_boundary(boundary) {
                boundary -= 1;
            }
            text.truncate(boundary);
        }
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
