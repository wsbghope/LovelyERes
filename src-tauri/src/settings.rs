// LovelyRes 设置管理

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
#[cfg(unix)]
use std::{fs::OpenOptions, io::Write, os::unix::fs::{OpenOptionsExt, PermissionsExt}};

fn write_private_file(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("打开设置文件失败: {}", e))?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("限制设置文件权限失败: {}", e))?;
        file.write_all(data)
            .map_err(|e| format!("写入设置文件失败: {}", e))
    }

    #[cfg(not(unix))]
    {
        fs::write(path, data).map_err(|e| format!("写入设置文件失败: {}", e))
    }
}

#[cfg(unix)]
fn harden_private_file_permissions(path: &std::path::Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("限制设置文件权限失败: {}", e))
}

#[cfg(not(unix))]
fn harden_private_file_permissions(path: &std::path::Path) -> Result<(), String> {
    crate::win_acl::restrict_to_current_user(path)
        .map_err(|e| format!("限制设置文件权限失败: {}", e))
}

/// Themes supported by both the frontend and the persisted settings format.
pub const SUPPORTED_THEMES: [&str; 5] = ["light", "dark", "sakura", "midnight", "ocean"];

pub fn is_supported_theme(theme: &str) -> bool {
    SUPPORTED_THEMES.contains(&theme)
}

/// 应用程序设置
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub language: String,
    #[serde(alias = "auto_connect")]
    pub auto_connect: bool,
    #[serde(rename = "defaultSSHPort", alias = "default_ssh_port", alias = "defaultSshPort")]
    pub default_ssh_port: u16,
    #[serde(alias = "terminal_font")]
    pub terminal_font: String,
    #[serde(alias = "terminal_font_size")]
    pub terminal_font_size: u16,
    #[serde(alias = "max_log_lines")]
    pub max_log_lines: u32,
    #[serde(alias = "auto_save_interval")]
    pub auto_save_interval: u32,
    pub notifications: NotificationSettings,
    pub security: SecuritySettings,
    pub ui: UISettings,
    pub docker: DockerSettings,
    pub ssh: SSHSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<serde_json::Value>, // AI设置作为动态JSON，避免结构变化导致序列化失败
}

/// 通知设置
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub enabled: bool,
    #[serde(alias = "connection_status")]
    pub connection_status: bool,
    #[serde(alias = "command_completion")]
    pub command_completion: bool,
    #[serde(alias = "error_alerts")]
    pub error_alerts: bool,
}

/// 安全设置
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    #[serde(alias = "save_passwords")]
    pub save_passwords: bool,
    #[serde(alias = "session_timeout")]
    pub session_timeout: u32,
    #[serde(alias = "require_confirmation")]
    pub require_confirmation: bool,
}

/// UI设置
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UISettings {
    #[serde(alias = "sidebar_width")]
    pub sidebar_width: u32,
    #[serde(alias = "show_status_bar")]
    pub show_status_bar: bool,
    #[serde(alias = "compact_mode")]
    pub compact_mode: bool,
    #[serde(alias = "animations_enabled")]
    pub animations_enabled: bool,
    #[serde(default = "default_global_font", alias = "global_font")]
    pub global_font: String,
    #[serde(default = "default_global_font_size", alias = "global_font_size")]
    pub global_font_size: u16,
}

/// Docker设置
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerSettings {
    #[serde(alias = "auto_refresh")]
    pub auto_refresh: bool,
    #[serde(alias = "refresh_interval")]
    pub refresh_interval: u32,
    #[serde(alias = "show_system_containers")]
    pub show_system_containers: bool,
}

/// SSH设置
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SSHSettings {
    #[serde(alias = "keep_alive_interval")]
    pub keep_alive_interval: u32,
    #[serde(alias = "connection_timeout")]
    pub connection_timeout: u32,
    #[serde(alias = "max_retries")]
    pub max_retries: u32,
}

fn default_global_font() -> String {
    "system".to_string()
}

fn default_global_font_size() -> u16 {
    14
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "light".to_string(),
            language: "zh-CN".to_string(),
            auto_connect: false,
            default_ssh_port: 22,
            terminal_font: "Monaco, Consolas, monospace".to_string(),
            terminal_font_size: 14,
            max_log_lines: 1000,
            auto_save_interval: 30000, // 30秒
            notifications: NotificationSettings::default(),
            security: SecuritySettings::default(),
            ui: UISettings::default(),
            docker: DockerSettings::default(),
            ssh: SSHSettings::default(),
            ai: None, // AI设置默认为None，由前端管理
        }
    }
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            connection_status: true,
            command_completion: false,
            error_alerts: true,
        }
    }
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            save_passwords: false,
            session_timeout: 86400000, // 24小时 - 大幅增加避免频繁超时
            require_confirmation: false, // 关闭确认要求，减少操作限制
        }
    }
}

impl Default for UISettings {
    fn default() -> Self {
        // Windows 下默认隐藏状态栏，macOS 下默认显示
        #[cfg(target_os = "windows")]
        let show_status_bar = false;

        #[cfg(not(target_os = "windows"))]
        let show_status_bar = true;

        Self {
            sidebar_width: 280,
            show_status_bar,
            compact_mode: false,
            animations_enabled: true,
            global_font: default_global_font(),
            global_font_size: default_global_font_size(),
        }
    }
}

impl Default for DockerSettings {
    fn default() -> Self {
        Self {
            auto_refresh: true,
            refresh_interval: 5000, // 5秒
            show_system_containers: false,
        }
    }
}

impl Default for SSHSettings {
    fn default() -> Self {
        Self {
            keep_alive_interval: 30000, // 30秒
            connection_timeout: 0, // 0 = 禁用超时，避免长时间操作被中断
            max_retries: 3,
        }
    }
}

/// 获取应用数据目录
pub fn get_app_data_dir() -> Result<PathBuf, String> {
    crate::types::get_app_data_dir().map_err(|e| format!("获取应用数据目录失败: {}", e))
}

/// 获取设置文件路径
fn get_settings_file_path() -> Result<PathBuf, String> {
    let app_data_dir = get_app_data_dir()?;
    Ok(app_data_dir.join("settings.json"))
}

/// 加载应用设置
pub fn load_settings() -> Result<AppSettings, String> {
    let settings_file = get_settings_file_path()?;

    if !settings_file.exists() {
        println!("🔍 设置文件不存在，返回默认设置");
        return Ok(AppSettings::default());
    }

    // 权限加固属于纵深防御：在网络盘、exFAT 等不支持模式位/ACL 的位置
    // 会失败，此时只告警，不应让用户连设置都打不开。
    if let Err(error) = harden_private_file_permissions(&settings_file) {
        eprintln!("⚠️ 收紧设置文件权限失败，继续加载: {}", error);
    }

    let settings_content =
        fs::read_to_string(&settings_file).map_err(|e| format!("读取设置文件失败: {}", e))?;

    let settings: AppSettings =
        serde_json::from_str(&settings_content).map_err(|e| format!("解析设置文件失败: {}", e))?;

    println!("✅ 成功加载应用设置");
    Ok(settings)
}

/// 保存应用设置
pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let settings_file = get_settings_file_path()?;

    let settings_content =
        serde_json::to_string_pretty(settings).map_err(|e| format!("序列化设置失败: {}", e))?;

    write_private_file(&settings_file, settings_content.as_bytes())?;

    println!("✅ 成功保存应用设置");
    Ok(())
}

/// 重置设置到默认值
pub fn reset_settings() -> Result<(), String> {
    let default_settings = AppSettings::default();
    save_settings(&default_settings)
}

/// 备份当前设置
pub fn backup_settings() -> Result<PathBuf, String> {
    let settings = load_settings()?;
    let app_data_dir = get_app_data_dir()?;

    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    let backup_file = app_data_dir.join(format!("settings_backup_{}.json", timestamp));

    let settings_content =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化设置失败: {}", e))?;

    write_private_file(&backup_file, settings_content.as_bytes())?;

    println!("✅ 设置已备份到: {:?}", backup_file);
    Ok(backup_file)
}

/// 从备份恢复设置
pub fn restore_settings(backup_file: PathBuf) -> Result<(), String> {
    if !backup_file.exists() {
        return Err("备份文件不存在".to_string());
    }

    let backup_content =
        fs::read_to_string(&backup_file).map_err(|e| format!("读取备份文件失败: {}", e))?;

    let settings: AppSettings =
        serde_json::from_str(&backup_content).map_err(|e| format!("解析备份文件失败: {}", e))?;

    save_settings(&settings)?;

    println!("✅ 设置已从备份恢复: {:?}", backup_file);
    Ok(())
}

/// 验证设置格式
pub fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    // 验证主题
    if !is_supported_theme(&settings.theme) {
        return Err("无效的主题设置".to_string());
    }

    // 验证语言
    if !["zh-CN", "en-US"].contains(&settings.language.as_str()) {
        return Err("无效的语言设置".to_string());
    }

    // 验证端口范围
    if settings.default_ssh_port == 0 {
        return Err("无效的SSH端口设置".to_string());
    }

    // 验证字体大小
    if settings.terminal_font_size < 8 || settings.terminal_font_size > 72 {
        return Err("无效的终端字体大小设置".to_string());
    }

    // 验证全局界面字体设置，避免异常值影响跨平台渲染或配置文件
    if settings.ui.global_font_size < 8 || settings.ui.global_font_size > 72 {
        return Err("无效的全局字体大小设置".to_string());
    }
    if settings.ui.global_font.len() > 128
        || settings
            .ui
            .global_font
            .chars()
            .any(|character| character == '\r' || character == '\n')
    {
        return Err("无效的全局字体设置".to_string());
    }

    // 验证日志行数
    if settings.max_log_lines == 0 || settings.max_log_lines > 100000 {
        return Err("无效的最大日志行数设置".to_string());
    }

    // 验证自动保存间隔
    if settings.auto_save_interval < 1000 || settings.auto_save_interval > 3600000 {
        return Err("无效的自动保存间隔设置".to_string());
    }

    // 验证会话超时
    if settings.security.session_timeout != 0
        && (settings.security.session_timeout < 60000 || settings.security.session_timeout > 86400000)
    {
        return Err("无效的会话超时设置".to_string());
    }

    // 验证侧边栏宽度
    if settings.ui.sidebar_width < 200 || settings.ui.sidebar_width > 800 {
        return Err("无效的侧边栏宽度设置".to_string());
    }

    // 验证Docker刷新间隔
    if settings.docker.refresh_interval < 1000 || settings.docker.refresh_interval > 60000 {
        return Err("无效的Docker刷新间隔设置".to_string());
    }

    // 验证SSH设置
    if settings.ssh.keep_alive_interval < 5000 || settings.ssh.keep_alive_interval > 300000 {
        return Err("无效的SSH保活间隔设置".to_string());
    }

    if settings.ssh.connection_timeout != 0
        && (settings.ssh.connection_timeout < 1000 || settings.ssh.connection_timeout > 600000)
    {
        return Err("无效的SSH连接超时设置".to_string());
    }

    if settings.ssh.max_retries == 0 || settings.ssh.max_retries > 10 {
        return Err("无效的SSH最大重试次数设置".to_string());
    }

    Ok(())
}

/// 获取设置文件信息
pub fn get_settings_info() -> Result<serde_json::Value, String> {
    let settings_file = get_settings_file_path()?;

    if !settings_file.exists() {
        return Ok(serde_json::json!({
            "exists": false,
            "path": settings_file.to_string_lossy(),
            "size": 0,
            "modified": null
        }));
    }

    let metadata =
        fs::metadata(&settings_file).map_err(|e| format!("获取文件元数据失败: {}", e))?;

    let modified = metadata
        .modified()
        .map_err(|e| format!("获取文件修改时间失败: {}", e))?;

    Ok(serde_json::json!({
        "exists": true,
        "path": settings_file.to_string_lossy(),
        "size": metadata.len(),
        "modified": chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_valid() {
        validate_settings(&AppSettings::default()).expect("default settings must be valid");
    }

    #[test]
    fn all_supported_themes_are_valid() {
        for theme in SUPPORTED_THEMES {
            let settings = AppSettings {
                theme: theme.to_string(),
                ..AppSettings::default()
            };
            validate_settings(&settings).expect("supported theme must be valid");
        }
    }

    #[test]
    fn disabled_timeouts_are_valid() {
        let mut settings = AppSettings::default();
        settings.security.session_timeout = 0;
        settings.ssh.connection_timeout = 0;
        validate_settings(&settings).expect("zero timeout disables the timeout");
    }

    #[test]
    fn invalid_global_font_size_is_rejected() {
        let mut settings = AppSettings::default();
        settings.ui.global_font_size = 7;
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn multiline_global_font_is_rejected() {
        let mut settings = AppSettings::default();
        settings.ui.global_font = "system\nmalformed".to_string();
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn settings_round_trip_uses_frontend_camel_case() {
        let value = serde_json::to_value(AppSettings::default()).expect("settings should serialize");

        assert!(value.get("autoConnect").is_some());
        assert!(value.get("defaultSSHPort").is_some());
        assert!(value["ui"].get("globalFont").is_some());
        assert!(value["ssh"].get("connectionTimeout").is_some());
        assert!(value.get("ai").is_none());

        let parsed: AppSettings = serde_json::from_value(value).expect("camelCase settings should deserialize");
        assert_eq!(parsed.ui.global_font, "system");
        assert_eq!(parsed.ssh.connection_timeout, 0);
    }

    #[test]
    fn legacy_snake_case_settings_are_accepted() {
        let mut value = serde_json::to_value(AppSettings::default()).expect("settings should serialize");
        let object = value.as_object_mut().expect("settings should be an object");

        let auto_connect = object.remove("autoConnect").expect("camelCase field should exist");
        object.insert("auto_connect".to_string(), auto_connect);

        let ssh = object
            .get_mut("ssh")
            .and_then(serde_json::Value::as_object_mut)
            .expect("ssh settings should be an object");
        let connection_timeout = ssh.remove("connectionTimeout").expect("camelCase field should exist");
        ssh.insert("connection_timeout".to_string(), connection_timeout);

        let parsed: AppSettings = serde_json::from_value(value).expect("legacy settings should deserialize");
        assert!(!parsed.auto_connect);
        assert_eq!(parsed.ssh.connection_timeout, 0);
    }
}
