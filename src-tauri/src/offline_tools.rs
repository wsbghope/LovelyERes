use sha2::{Digest, Sha256};

pub const TOOLKIT_SOURCE: &str = "0typos/statics";
pub const TOOLKIT_RELEASE: &str = "v2026.08.01";
pub const TCPDUMP_VERSION: &str = "4.99.6";

pub struct BundledTool {
    pub name: &'static str,
    pub architecture: &'static str,
    pub version: &'static str,
    pub bytes: &'static [u8],
}

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

pub fn bundled_tcpdump(architecture: &str) -> Option<BundledTool> {
    let bytes: &'static [u8] = match architecture {
        "x86_64" => include_bytes!("../resources/capture/x86_64/tcpdump"),
        "i686" => include_bytes!("../resources/capture/i686/tcpdump"),
        "aarch64" => include_bytes!("../resources/capture/aarch64/tcpdump"),
        "armv6-hardfloat" => include_bytes!("../resources/capture/armv6-hardfloat/tcpdump"),
        "armv7-hardfloat" => include_bytes!("../resources/capture/armv7-hardfloat/tcpdump"),
        "armv7-softfloat" => include_bytes!("../resources/capture/armv7-softfloat/tcpdump"),
        "mips" => include_bytes!("../resources/capture/mips/tcpdump"),
        "mipsel" => include_bytes!("../resources/capture/mipsel/tcpdump"),
        "powerpc" => include_bytes!("../resources/capture/powerpc/tcpdump"),
        "powerpc64" => include_bytes!("../resources/capture/powerpc64/tcpdump"),
        "powerpc64le" => include_bytes!("../resources/capture/powerpc64le/tcpdump"),
        "riscv64" => include_bytes!("../resources/capture/riscv64/tcpdump"),
        "s390x" => include_bytes!("../resources/capture/s390x/tcpdump"),
        _ => return None,
    };

    Some(BundledTool {
        name: "tcpdump",
        architecture: match architecture {
            "x86_64" => "x86_64",
            "i686" => "i686",
            "aarch64" => "aarch64",
            "armv6-hardfloat" => "armv6-hardfloat",
            "armv7-hardfloat" => "armv7-hardfloat",
            "armv7-softfloat" => "armv7-softfloat",
            "mips" => "mips",
            "mipsel" => "mipsel",
            "powerpc" => "powerpc",
            "powerpc64" => "powerpc64",
            "powerpc64le" => "powerpc64le",
            "riscv64" => "riscv64",
            "s390x" => "s390x",
            _ => unreachable!(),
        },
        version: TCPDUMP_VERSION,
        bytes,
    })
}

pub fn remote_tool_root(uid: u32) -> String {
    format!("/tmp/lovelyres-{uid}")
}

pub fn remote_tool_path(uid: u32, tool_name: &str) -> Result<String, String> {
    if tool_name.is_empty()
        || !tool_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("离线工具名称包含非法字符".to_string());
    }

    Ok(format!("{}/bin/{tool_name}", remote_tool_root(uid)))
}

pub fn validate_remote_tool_path(path: &str, uid: u32) -> bool {
    let prefix = format!("{}/bin/", remote_tool_root(uid));
    path.strip_prefix(&prefix).is_some_and(|name| {
        !name.is_empty()
            && !name.contains('/')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    })
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

    #[test]
    fn bundled_x86_64_tcpdump_has_an_elf_header() {
        let tool = bundled_tcpdump("x86_64").expect("x86_64 tcpdump should be bundled");
        assert_eq!(&tool.bytes[..4], b"\x7fELF");
        assert!(tool.bytes.len() > 500_000);
        assert_eq!(tool.name, "tcpdump");
        assert_eq!(tool.version, TCPDUMP_VERSION);
    }
}
