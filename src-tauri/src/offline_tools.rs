use sha2::{Digest, Sha256};

pub fn normalize_linux_architecture(machine: &str, abi: Option<&str>) -> Option<&'static str> {
    let machine = machine.trim().to_ascii_lowercase();
    match machine.as_str() {
        "x86_64" | "amd64" => Some("x86_64"),
        "i386" | "i486" | "i586" | "i686" | "x86" => Some("i686"),
        "aarch64" | "arm64" => Some("aarch64"),
        "armv6" | "armv6l" if abi == Some("hardfloat") => Some("armv6-hardfloat"),
        "armv7" | "armv7l" if abi == Some("softfloat") => Some("armv7-softfloat"),
        "armv7" | "armv7l" => Some("armv7-hardfloat"),
        "mips" => Some("mips"),
        "mipsel" => Some("mipsel"),
        "ppc" | "powerpc" => Some("powerpc"),
        "ppc64" | "powerpc64" => Some("powerpc64"),
        "ppc64le" | "powerpc64le" => Some("powerpc64le"),
        "riscv64" => Some("riscv64"),
        "s390x" => Some("s390x"),
        _ => None,
    }
}

pub fn remote_tool_root(uid: u32) -> String {
    format!("/tmp/lovelyres-{uid}")
}

pub fn valid_tool_name(tool_name: &str) -> bool {
    !tool_name.is_empty()
        && tool_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn remote_tool_path(uid: u32, tool_name: &str) -> Result<String, String> {
    if !valid_tool_name(tool_name) {
        return Err("离线工具名称包含非法字符".to_string());
    }

    Ok(format!("{}/bin/{tool_name}", remote_tool_root(uid)))
}

pub fn validate_remote_tool_path(path: &str, uid: u32) -> bool {
    let prefix = format!("{}/bin/", remote_tool_root(uid));
    path.strip_prefix(&prefix)
        .is_some_and(|name| !name.contains('/') && valid_tool_name(name))
}

pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_linux_architectures() {
        assert_eq!(normalize_linux_architecture("x86_64", None), Some("x86_64"));
        assert_eq!(normalize_linux_architecture("arm64", None), Some("aarch64"));
        assert_eq!(
            normalize_linux_architecture("armv7l", Some("hardfloat")),
            Some("armv7-hardfloat")
        );
        assert_eq!(
            normalize_linux_architecture("armv7l", Some("softfloat")),
            Some("armv7-softfloat")
        );
        assert_eq!(normalize_linux_architecture("mipsel", None), Some("mipsel"));
        assert_eq!(normalize_linux_architecture("sparc64", None), None);
    }

    #[test]
    fn builds_uid_scoped_remote_paths() {
        assert_eq!(remote_tool_root(1000), "/tmp/lovelyres-1000");
        assert_eq!(
            remote_tool_path(1000, "tcpdump").unwrap(),
            "/tmp/lovelyres-1000/bin/tcpdump"
        );
        assert!(remote_tool_path(1000, "../tcpdump").is_err());
        assert!(validate_remote_tool_path(
            "/tmp/lovelyres-1000/bin/tcpdump",
            1000
        ));
        assert!(!validate_remote_tool_path(
            "/tmp/lovelyres-0/bin/tcpdump",
            1000
        ));
        assert!(!validate_remote_tool_path(
            "/tmp/lovelyres-1000/bin/../tcpdump",
            1000
        ));
    }
}
