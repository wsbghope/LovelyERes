// Windows ACL 加固：把敏感文件的权限收紧到「仅当前用户」
//
// Unix 上我们用 0o600 文件模式保护设置文件、SSH 配置和加密密钥；
// Windows 没有等价概念，需要显式写 DACL，否则同一台机器上的其他
// 用户账户仍可读取这些含凭据的文件。

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use winapi::shared::minwindef::DWORD;
use winapi::shared::winerror::ERROR_SUCCESS;
use winapi::um::accctrl::{
    EXPLICIT_ACCESS_W, NO_INHERITANCE, SE_FILE_OBJECT, SET_ACCESS, TRUSTEE_W,
};
use winapi::um::aclapi::{SetEntriesInAclW, SetNamedSecurityInfoW};
use winapi::um::securitybaseapi::GetTokenInformation;
use winapi::um::winnt::{
    ACL, DACL_SECURITY_INFORMATION, GENERIC_ALL, PROTECTED_DACL_SECURITY_INFORMATION,
    TOKEN_QUERY, TOKEN_USER, TokenUser,
};

/// 生成以 NUL 结尾的 UTF-16 字符串，供 Win32 宽字符 API 使用。
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

/// 取当前进程所属用户的 SID。
fn current_user_sid() -> Result<Vec<u8>, String> {
    unsafe {
        let mut token: winapi::um::winnt::HANDLE = std::ptr::null_mut();
        if winapi::um::processthreadsapi::OpenProcessToken(
            winapi::um::processthreadsapi::GetCurrentProcess(),
            TOKEN_QUERY,
            &mut token,
        ) == 0
        {
            return Err("无法打开当前进程令牌".to_string());
        }

        let mut size: DWORD = 0;
        // 第一次调用只取所需缓冲区大小，预期返回 0 并设置 ERROR_INSUFFICIENT_BUFFER
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        if size == 0 {
            winapi::um::handleapi::CloseHandle(token);
            return Err("无法获取令牌用户信息大小".to_string());
        }

        let mut buffer = vec![0u8; size as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut _,
            size,
            &mut size,
        );
        winapi::um::handleapi::CloseHandle(token);
        if ok == 0 {
            return Err("无法读取令牌用户信息".to_string());
        }

        let token_user = buffer.as_ptr() as *const TOKEN_USER;
        let sid = (*token_user).User.Sid;
        let sid_len = winapi::um::securitybaseapi::GetLengthSid(sid);
        if sid_len == 0 {
            return Err("无法获取 SID 长度".to_string());
        }
        let mut owned = vec![0u8; sid_len as usize];
        if winapi::um::securitybaseapi::CopySid(sid_len, owned.as_mut_ptr() as *mut _, sid) == 0 {
            return Err("无法复制 SID".to_string());
        }
        Ok(owned)
    }
}

/// 把 `path` 的 DACL 替换为「仅当前用户可完全控制」。
///
/// 失败时返回错误字符串而不是 panic：权限加固是纵深防御，
/// 在某些文件系统（如网络盘、FAT32）上本来就无法设置 ACL。
pub fn restrict_to_current_user(path: &Path) -> Result<(), String> {
    let sid = current_user_sid()?;
    let path_wide = wide(path.as_os_str());

    unsafe {
        let mut trustee: TRUSTEE_W = std::mem::zeroed();
        trustee.TrusteeForm = winapi::um::accctrl::TRUSTEE_IS_SID;
        trustee.TrusteeType = winapi::um::accctrl::TRUSTEE_IS_USER;
        // TRUSTEE_W 的 ptstrName 字段是 *mut c_void，这里指向 SID 缓冲区
        trustee.ptstrName = sid.as_ptr() as *mut _;

        let mut entry: EXPLICIT_ACCESS_W = std::mem::zeroed();
        entry.grfAccessPermissions = GENERIC_ALL;
        entry.grfAccessMode = SET_ACCESS;
        entry.grfInheritance = NO_INHERITANCE;
        entry.Trustee = trustee;

        let mut new_acl: *mut ACL = std::ptr::null_mut();
        let result = SetEntriesInAclW(1, &mut entry, std::ptr::null_mut(), &mut new_acl);
        if result != ERROR_SUCCESS {
            return Err(format!("构建 ACL 失败 (错误码 {})", result));
        }

        let result = SetNamedSecurityInfoW(
            path_wide.as_ptr() as *mut _,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_acl,
            std::ptr::null_mut(),
        );

        winapi::um::winbase::LocalFree(new_acl as *mut _);

        if result != ERROR_SUCCESS {
            return Err(format!("设置文件 ACL 失败 (错误码 {})", result));
        }
    }

    Ok(())
}
