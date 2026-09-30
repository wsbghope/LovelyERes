// SSH连接管理器
// 负责SSH连接的持久化存储和加密功能

use crate::types::{AppDataPaths, LovelyResError, LovelyResResult, SSHConnection};
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use rand::RngCore;
use serde_json;
use std::fs;
use std::path::Path;
#[cfg(unix)]
use std::{fs::OpenOptions, io::Write, os::unix::fs::{OpenOptionsExt, PermissionsExt}};

const ENCRYPTED_SECRET_PREFIX: &str = "enc:v1:";

fn write_private_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(data)
    }

    #[cfg(not(unix))]
    {
        fs::write(path, data)
    }
}

#[cfg(unix)]
fn harden_private_file_permissions(path: &Path) -> std::io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn harden_private_file_permissions(path: &Path) -> std::io::Result<()> {
    // Windows 没有文件模式位，改用 DACL 限制为当前用户。
    crate::win_acl::restrict_to_current_user(path).map_err(std::io::Error::other)
}

/// SSH连接管理器
pub struct SSHConnectionManager {
    data_paths: AppDataPaths,
    encryption_key: [u8; 32], // AES-256 密钥
}

impl SSHConnectionManager {
    /// 创建新的SSH连接管理器
    pub fn new() -> LovelyResResult<Self> {
        let data_paths =
            AppDataPaths::new().map_err(|e| LovelyResError::ConfigError(e.to_string()))?;

        // 生成或加载加密密钥
        let encryption_key = Self::get_or_create_encryption_key(&data_paths)?;

        Ok(Self {
            data_paths,
            encryption_key,
        })
    }

    /// 加载SSH连接配置
    pub fn load_connections(&self) -> LovelyResResult<Vec<SSHConnection>> {
        let config_file = &self.data_paths.ssh_connections_file;

        if !config_file.exists() {
            println!("📁 SSH连接配置文件不存在，返回空列表");
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(config_file)
            .map_err(|e| LovelyResError::FileError(format!("读取SSH配置文件失败: {}", e)))?;
        // 权限加固失败（网络盘、exFAT 等不支持模式位/ACL 的位置）只告警，
        // 不应导致连接列表整体加载失败。
        if let Err(e) = harden_private_file_permissions(config_file) {
            eprintln!("⚠️ 收紧SSH配置文件权限失败，继续加载: {}", e);
        }

        let mut connections: Vec<SSHConnection> = serde_json::from_str(&content)
            .map_err(|e| LovelyResError::ConfigError(format!("解析SSH配置文件失败: {}", e)))?;

        // 自动迁移旧的单账号数据到多账号模式
        let mut migrated_count = 0;
        for conn in connections.iter_mut() {
            if conn.accounts.is_empty() && !conn.username.is_empty() {
                conn.migrate_legacy_account();
                migrated_count += 1;
            }
        }

        let secrets_need_migration = Self::has_plaintext_key_passphrases(&connections);
        if migrated_count > 0 || secrets_need_migration {
            if migrated_count > 0 {
                println!("🔄 自动迁移了 {} 个旧账号数据到多账号模式", migrated_count);
            }
            if secrets_need_migration {
                println!("🔐 正在迁移明文SSH密钥口令");
            }
            if let Err(e) = self.save_connections(&connections) {
                println!("⚠️ 保存迁移后的数据失败: {}", e);
            }
        }

        self.decrypt_key_passphrases(&mut connections)?;

        //println!("✅ 成功加载 {} 个SSH连接配置", connections.len());
        Ok(connections)
    }

    /// 保存SSH连接配置
    pub fn save_connections(&self, connections: &[SSHConnection]) -> LovelyResResult<()> {
        let config_file = &self.data_paths.ssh_connections_file;

        // 确保目录存在
        if let Some(parent) = config_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| LovelyResError::FileError(format!("创建配置目录失败: {}", e)))?;
        }

        let mut persisted_connections = connections.to_vec();
        self.encrypt_key_passphrases(&mut persisted_connections)?;

        let content = serde_json::to_string_pretty(&persisted_connections)
            .map_err(|e| LovelyResError::ConfigError(format!("序列化SSH配置失败: {}", e)))?;

        write_private_file(config_file, content.as_bytes())
            .map_err(|e| LovelyResError::FileError(format!("写入SSH配置文件失败: {}", e)))?;

        println!("✅ 成功保存 {} 个SSH连接配置", connections.len());
        Ok(())
    }

    /// 加密密码
    pub fn encrypt_password(&self, password: &str) -> LovelyResResult<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.encryption_key)
            .map_err(|e| LovelyResError::AuthError(format!("创建加密器失败: {}", e)))?;

        // 生成随机nonce
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        // 加密密码
        let ciphertext = cipher
            .encrypt(nonce, password.as_bytes())
            .map_err(|e| LovelyResError::AuthError(format!("密码加密失败: {}", e)))?;

        // 将nonce和密文组合并编码为base64
        let mut encrypted_data = nonce_bytes.to_vec();
        encrypted_data.extend_from_slice(&ciphertext);

        Ok(general_purpose::STANDARD.encode(encrypted_data))
    }

    /// 解密密码
    pub fn decrypt_password(&self, encrypted_password: &str) -> LovelyResResult<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.encryption_key)
            .map_err(|e| LovelyResError::AuthError(format!("创建解密器失败: {}", e)))?;

        // 解码base64
        let encrypted_data = general_purpose::STANDARD
            .decode(encrypted_password)
            .map_err(|e| LovelyResError::AuthError(format!("base64解码失败: {}", e)))?;

        if encrypted_data.len() < 12 {
            return Err(LovelyResError::AuthError("加密数据格式错误".to_string()));
        }

        // 分离nonce和密文
        let (nonce_bytes, ciphertext) = encrypted_data.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);

        // 解密密码
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| LovelyResError::AuthError(format!("密码解密失败: {}", e)))?;

        String::from_utf8(plaintext)
            .map_err(|e| LovelyResError::AuthError(format!("解密结果不是有效UTF-8: {}", e)))
    }

    fn encrypt_key_passphrases(&self, connections: &mut [SSHConnection]) -> LovelyResResult<()> {
        for connection in connections {
            self.encrypt_optional_secret(&mut connection.key_passphrase)?;
            for account in &mut connection.accounts {
                self.encrypt_optional_secret(&mut account.key_passphrase)?;
            }
        }
        Ok(())
    }

    fn decrypt_key_passphrases(&self, connections: &mut [SSHConnection]) -> LovelyResResult<()> {
        for connection in connections {
            self.decrypt_optional_secret(&mut connection.key_passphrase)?;
            for account in &mut connection.accounts {
                self.decrypt_optional_secret(&mut account.key_passphrase)?;
            }
        }
        Ok(())
    }

    fn encrypt_optional_secret(&self, secret: &mut Option<String>) -> LovelyResResult<()> {
        let Some(value) = secret.as_ref() else { return Ok(()); };
        if value.is_empty() || value.starts_with(ENCRYPTED_SECRET_PREFIX) {
            return Ok(());
        }
        *secret = Some(format!("{}{}", ENCRYPTED_SECRET_PREFIX, self.encrypt_password(value)?));
        Ok(())
    }

    fn decrypt_optional_secret(&self, secret: &mut Option<String>) -> LovelyResResult<()> {
        let Some(value) = secret.as_ref() else { return Ok(()); };
        let Some(ciphertext) = value.strip_prefix(ENCRYPTED_SECRET_PREFIX) else { return Ok(()); };
        *secret = Some(self.decrypt_password(ciphertext)?);
        Ok(())
    }

    fn has_plaintext_key_passphrases(connections: &[SSHConnection]) -> bool {
        let is_plaintext = |secret: &Option<String>| {
            secret.as_ref().is_some_and(|value| {
                !value.is_empty() && !value.starts_with(ENCRYPTED_SECRET_PREFIX)
            })
        };

        connections.iter().any(|connection| {
            is_plaintext(&connection.key_passphrase)
                || connection.accounts.iter().any(|account| is_plaintext(&account.key_passphrase))
        })
    }

    /// 获取或创建加密密钥
    fn get_or_create_encryption_key(data_paths: &AppDataPaths) -> LovelyResResult<[u8; 32]> {
        let key_file = data_paths.app_data_dir.join("encryption.key");

        if key_file.exists() {
            harden_private_file_permissions(&key_file)
                .map_err(|e| LovelyResError::FileError(format!("限制加密密钥权限失败: {}", e)))?;
            // 加载现有密钥
            let key_data = fs::read(&key_file)
                .map_err(|e| LovelyResError::FileError(format!("读取加密密钥失败: {}", e)))?;

            if key_data.len() != 32 {
                return Err(LovelyResError::ConfigError("加密密钥长度错误".to_string()));
            }

            let mut key = [0u8; 32];
            key.copy_from_slice(&key_data);

            println!("🔑 加载现有加密密钥");
            Ok(key)
        } else {
            // 生成新密钥
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);

            // 保存密钥
            write_private_file(&key_file, &key)
                .map_err(|e| LovelyResError::FileError(format!("保存加密密钥失败: {}", e)))?;

            println!("🔑 生成新的加密密钥");
            Ok(key)
        }
    }

    /// 创建备份
    pub fn create_backup(&self) -> LovelyResResult<String> {
        let config_file = &self.data_paths.ssh_connections_file;

        if !config_file.exists() {
            return Err(LovelyResError::FileError("SSH配置文件不存在".to_string()));
        }

        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_filename = format!("ssh_connections_backup_{}.json", timestamp);
        let backup_path = self.data_paths.backups_dir.join(&backup_filename);

        fs::copy(config_file, &backup_path)
            .map_err(|e| LovelyResError::FileError(format!("创建备份失败: {}", e)))?;

        println!("✅ 创建SSH配置备份: {}", backup_filename);
        Ok(backup_filename)
    }

    /// 从备份恢复
    pub fn restore_from_backup(&self, backup_filename: &str) -> LovelyResResult<()> {
        let backup_path = self.data_paths.backups_dir.join(backup_filename);

        if !backup_path.exists() {
            return Err(LovelyResError::FileError("备份文件不存在".to_string()));
        }

        let config_file = &self.data_paths.ssh_connections_file;

        fs::copy(&backup_path, config_file)
            .map_err(|e| LovelyResError::FileError(format!("从备份恢复失败: {}", e)))?;

        println!("✅ 从备份恢复SSH配置: {}", backup_filename);
        Ok(())
    }

    /// 清理旧备份
    pub fn cleanup_old_backups(&self, keep_count: usize) -> LovelyResResult<usize> {
        let backups_dir = &self.data_paths.backups_dir;

        if !backups_dir.exists() {
            return Ok(0);
        }

        let mut backup_files: Vec<_> = fs::read_dir(backups_dir)
            .map_err(|e| LovelyResError::FileError(format!("读取备份目录失败: {}", e)))?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                if path.is_file()
                    && path
                        .file_name()?
                        .to_str()?
                        .starts_with("ssh_connections_backup_")
                {
                    Some(path)
                } else {
                    None
                }
            })
            .collect();

        // 按修改时间排序（最新的在前）
        backup_files.sort_by(|a, b| {
            let a_time = fs::metadata(a)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            let b_time = fs::metadata(b)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            b_time.cmp(&a_time)
        });

        let mut deleted_count = 0;
        for backup_file in backup_files.iter().skip(keep_count) {
            if let Err(e) = fs::remove_file(backup_file) {
                println!("⚠️ 删除旧备份失败: {}: {}", backup_file.display(), e);
            } else {
                deleted_count += 1;
            }
        }

        if deleted_count > 0 {
            println!("✅ 清理了 {} 个旧备份文件", deleted_count);
        }

        Ok(deleted_count)
    }

    /// 验证配置文件完整性
    pub fn validate_config(&self) -> LovelyResResult<bool> {
        let config_file = &self.data_paths.ssh_connections_file;

        if !config_file.exists() {
            return Ok(true); // 文件不存在是正常的
        }

        match self.load_connections() {
            Ok(_) => {
                println!("✅ SSH配置文件验证通过");
                Ok(true)
            }
            Err(e) => {
                println!("❌ SSH配置文件验证失败: {}", e);
                Ok(false)
            }
        }
    }
}
