use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PacketEntry {
    pub id: usize,
    pub timestamp: String,
    pub protocol: String,
    pub src: String,
    pub dst: String,
    pub length: String,
    pub info: String,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInterface {
    pub name: String,
    pub index: u32,
    pub mac: Option<String>,
    pub ips: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PacketCapturePrivilege {
    pub mode: String,
    pub username: String,
    pub message: String,
    pub architecture: Option<String>,
    pub remote_path: Option<String>,
    pub can_deploy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketCaptureProbe {
    pub mode: String,
    pub username: String,
    pub message: String,
    pub machine: String,
    pub abi: String,
    pub uid: u32,
    pub tool_path: Option<String>,
    pub tool_source: String,
}

/// 从端口号推断应用层协议
fn infer_protocol_from_port(addr: &str) -> Option<&'static str> {
    // tcpdump 格式: 192.168.1.1.80 或 192.168.1.1.443
    let has_tcpdump_port = addr.contains(':') || addr.matches('.').count() == 4;
    if has_tcpdump_port {
        let pos = addr.rfind('.')?;
        if let Ok(port) = addr[pos + 1..].parse::<u16>() {
            return match port {
                80 | 8080 | 8000 | 8888 => Some("HTTP"),
                443 | 8443 => Some("HTTPS"),
                53 => Some("DNS"),
                22 | 2222 => Some("SSH"),
                21 => Some("FTP"),
                25 | 465 | 587 => Some("SMTP"),
                110 | 995 => Some("POP3"),
                143 | 993 => Some("IMAP"),
                3306 => Some("MySQL"),
                5432 => Some("PgSQL"),
                6379 => Some("Redis"),
                27017 => Some("MongoDB"),
                _ => None,
            };
        }
    }
    None
}

fn infer_transport_protocol(info: &str) -> Option<&'static str> {
    let normalized = info.trim_start();
    if normalized.starts_with("ICMP6") || normalized.starts_with("ICMPv6") {
        Some("ICMP6")
    } else if normalized.starts_with("ICMP") {
        Some("ICMP")
    } else if normalized.starts_with("UDP") {
        Some("UDP")
    } else if normalized.contains("Flags [") {
        Some("TCP")
    } else {
        None
    }
}

/// 从 info 字段提取 length
fn extract_length(info: &str) -> String {
    // 匹配 "length N" 或 "len N"
    for word_pair in info.split_whitespace().collect::<Vec<&str>>().windows(2) {
        if word_pair[0] == "length" || word_pair[0] == "len" {
            let num_str = word_pair[1].trim_end_matches([',', ':']);
            if !num_str.is_empty() {
                if num_str.parse::<u64>().is_ok() {
                    return num_str.to_string();
                }
            }
        }
    }
    String::new()
}

/// 解析 tcpdump 输出行（支持 -tttt -v 格式）
pub fn parse_tcpdump_line(line: &str, id: usize) -> PacketEntry {
    let parts: Vec<&str> = line.split_whitespace().collect();

    let mut entry = PacketEntry {
        id,
        timestamp: String::new(),
        protocol: "OTHER".to_string(),
        src: String::new(),
        dst: String::new(),
        length: String::new(),
        info: line.to_string(),
        raw: line.to_string(),
    };

    if parts.len() < 4 {
        return entry;
    }

    // 检测 -tttt 格式: "2024-01-15 19:43:01.123456 IP ..."
    // 或普通格式: "19:43:01.123456 IP ..."
    let (ts, offset) = if parts[0].contains('-') && parts.len() > 1 && parts[1].contains(':') {
        // -tttt 格式
        (format!("{} {}", parts[0], parts[1]), 2)
    } else {
        (parts[0].to_string(), 1)
    };
    entry.timestamp = ts;

    if parts.len() <= offset {
        return entry;
    }

    // `tcpdump -e` prepends link-layer fields and Linux's `any` interface may
    // prepend direction fields (for example `eth0 In`). Find the actual
    // network protocol token instead of assuming it immediately follows time.
    let proto_idx = parts
        .iter()
        .enumerate()
        .skip(offset)
        .find_map(|(idx, token)| {
            let normalized = token.trim_end_matches(',');
            matches!(normalized, "IP" | "IP6" | "IPv4" | "IPv6" | "ARP").then_some(idx)
        });

    let Some(proto_idx) = proto_idx else {
        return entry;
    };
    let proto_token = parts[proto_idx].trim_end_matches(',');

    if matches!(proto_token, "IP" | "IP6" | "IPv4" | "IPv6") {
        entry.protocol = if matches!(proto_token, "IP6" | "IPv6") {
            "IP6".to_string()
        } else {
            "IP".to_string()
        };

        // 找 ">" 分隔 src > dst
        if let Some(arrow_idx) = parts[proto_idx..].iter().position(|&x| x == ">") {
            let abs_arrow = proto_idx + arrow_idx;

            // Source
            if abs_arrow > 0 {
                entry.src = parts[abs_arrow - 1].to_string();
            }

            // Destination (去掉末尾冒号)
            if abs_arrow + 1 < parts.len() {
                entry.dst = parts[abs_arrow + 1].trim_end_matches(':').to_string();

                // Info
                let info_start = abs_arrow + 2;
                if info_start < parts.len() {
                    entry.info = parts[info_start..].join(" ");
                }
            }

            if let Some(transport) = infer_transport_protocol(&entry.info) {
                entry.protocol = transport.to_string();
            }

            // 从端口推断应用层协议
            if let Some(app_proto) = infer_protocol_from_port(&entry.src)
                .or_else(|| infer_protocol_from_port(&entry.dst))
            {
                entry.protocol = app_proto.to_string();
            }
        }
    } else if proto_token == "ARP" {
        entry.protocol = "ARP".to_string();
        // Keep the link-layer prefix so ARP/MAC anomaly detection can inspect it.
        entry.info = parts[offset..].join(" ");
    }

    // 提取 length
    entry.length = extract_length(&entry.info);

    entry
}

/// 生成 tcpdump 命令（增强版: -tttt 完整时间戳, -v 获取 length）
pub fn generate_tcpdump_command(
    interface: &str,
    filter: Option<&str>,
    count: Option<u32>,
    management_ssh_port: u16,
    use_password_sudo: bool,
) -> String {
    let shell_quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    // Avoid `-v`: on Linux's `any` interface verbose output wraps one packet
    // across multiple lines, while the event protocol is deliberately line-based.
    let mut tcpdump_args = format!("-nne -l -tttt -i {}", shell_quote(interface));

    if let Some(c) = count {
        tcpdump_args.push_str(&format!(" -c {}", c));
    }

    // Exclude the management SSH port. Otherwise every packet event sent over
    // the same SSH session creates more captured SSH packets (feedback loop).
    let capture_filter = filter
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("({value}) and not port {management_ssh_port}"))
        .unwrap_or_else(|| format!("not port {management_ssh_port}"));
    tcpdump_args.push(' ');
    tcpdump_args.push_str(&shell_quote(&capture_filter));

    let resolve_tool = "uid_value=$(id -u 2>/dev/null || printf '%s' \"${UID:-}\"); \
        machine=$(uname -m 2>/dev/null || printf unknown); abi=default; \
        case \"$machine\" in armv6*|armv7*) if [ -e /lib/ld-linux-armhf.so.3 ] || [ -e /lib/arm-linux-gnueabihf/ld-linux-armhf.so.3 ]; then abi=hardfloat; else abi=softfloat; fi ;; esac; \
        case \"$machine:$abi\" in x86_64:*|amd64:*) tool_arch=x86_64 ;; i?86:*|x86:*) tool_arch=i686 ;; aarch64:*|arm64:*) tool_arch=aarch64 ;; armv6*:hardfloat) tool_arch=armv6-hardfloat ;; armv7*:softfloat) tool_arch=armv7-softfloat ;; armv7*:*) tool_arch=armv7-hardfloat ;; ppc64le:*|powerpc64le:*) tool_arch=powerpc64le ;; ppc64:*|powerpc64:*) tool_arch=powerpc64 ;; ppc:*|powerpc:*) tool_arch=powerpc ;; *) tool_arch=$machine ;; esac; \
        tool=$(command -v tcpdump 2>/dev/null || true); \
        if [ -n \"$tool\" ] && [ ! -x \"$tool\" ]; then tool=; fi; \
        if [ -z \"$tool\" ] && [ -n \"$uid_value\" ] && [ -x \"/tmp/lovelyres-$uid_value/bin/tcpdump\" ]; then tool=\"/tmp/lovelyres-$uid_value/bin/tcpdump\"; fi; \
        if [ -z \"$tool\" ] && [ -n \"$uid_value\" ]; then for candidate in /tmp/lovelyres-$uid_value/bin/tcpdump-$tool_arch-*; do if [ -f \"$candidate\" ] && [ -x \"$candidate\" ]; then tool=$candidate; break; fi; done; fi; \
        if [ ! -x \"$tool\" ]; then echo 'tcpdump is not installed and no executable LovelyRes fallback is available' >&2; exit 127; fi";

    if use_password_sudo {
        return format!("{resolve_tool}; exec sudo -S -p '' \"$tool\" {tcpdump_args}");
    }

    // Packet capture generally needs root/CAP_NET_RAW. Prefer an explicitly
    // permitted non-interactive sudo invocation, then fall back to direct
    // execution for root or binaries carrying Linux capabilities.
    format!(
        "{resolve_tool}; \
         if [ \"$uid_value\" = 0 ]; then exec \"$tool\" {tcpdump_args}; \
         elif command -v sudo >/dev/null 2>&1 && sudo -n \"$tool\" --version >/dev/null 2>&1; then exec sudo -n \"$tool\" {tcpdump_args}; \
         else exec \"$tool\" {tcpdump_args}; fi"
    )
}

pub fn generate_capture_privilege_command(_interface: &str) -> String {
    "username=$(id -un 2>/dev/null || printf unknown); \
     uid_value=$(id -u 2>/dev/null || printf '%s' \"${UID:-}\"); \
     machine=$(uname -m 2>/dev/null || printf unknown); \
     abi=default; \
     case \"$machine\" in \
       armv6*|armv7*) if [ -e /lib/ld-linux-armhf.so.3 ] || [ -e /lib/arm-linux-gnueabihf/ld-linux-armhf.so.3 ]; then abi=hardfloat; else abi=softfloat; fi ;; \
     esac; \
     case \"$machine:$abi\" in x86_64:*|amd64:*) tool_arch=x86_64 ;; i?86:*|x86:*) tool_arch=i686 ;; aarch64:*|arm64:*) tool_arch=aarch64 ;; armv6*:hardfloat) tool_arch=armv6-hardfloat ;; armv7*:softfloat) tool_arch=armv7-softfloat ;; armv7*:*) tool_arch=armv7-hardfloat ;; ppc64le:*|powerpc64le:*) tool_arch=powerpc64le ;; ppc64:*|powerpc64:*) tool_arch=powerpc64 ;; ppc:*|powerpc:*) tool_arch=powerpc ;; *) tool_arch=$machine ;; esac; \
     case \"$uid_value\" in ''|*[!0-9]*) echo \"unavailable|$username|无法确定当前账号 UID|$machine|$abi|0||none\"; exit 0 ;; esac; \
     system_tool=$(command -v tcpdump 2>/dev/null || true); tool=$system_tool; tool_source=system; \
     bundled=\"/tmp/lovelyres-$uid_value/bin/tcpdump\"; \
     if [ -z \"$tool\" ] || [ ! -x \"$tool\" ]; then if [ -x \"$bundled\" ]; then tool=\"$bundled\"; tool_source=bundled; else for candidate in /tmp/lovelyres-$uid_value/bin/tcpdump-$tool_arch-*; do if [ -f \"$candidate\" ] && [ -x \"$candidate\" ]; then tool=$candidate; tool_source=bundled; break; fi; done; fi; fi; \
     if [ -z \"$tool\" ]; then echo \"tool_missing|$username|目标机未安装 tcpdump，可在应急响应的文件上传中选择离线版本|$machine|$abi|$uid_value|/tmp/lovelyres-$uid_value/bin/tcpdump-$tool_arch-*|none\"; \
     elif [ ! -x \"$tool\" ]; then echo \"tool_missing|$username|tcpdump 存在但当前账号没有执行权限，可由 LovelyRes 修复|$machine|$abi|$uid_value|$tool|$tool_source\"; \
     elif [ \"$uid_value\" = 0 ]; then echo \"direct|$username|当前账号为 root|$machine|$abi|$uid_value|$tool|$tool_source\"; \
     elif [ -u \"$tool\" ]; then echo \"direct|$username|tcpdump 已配置 SUID 权限|$machine|$abi|$uid_value|$tool|$tool_source\"; \
     elif command -v getcap >/dev/null 2>&1 && getcap \"$tool\" 2>/dev/null | grep -q 'cap_net_raw'; then echo \"direct|$username|tcpdump 已配置网络抓包 capability|$machine|$abi|$uid_value|$tool|$tool_source\"; \
     elif command -v sudo >/dev/null 2>&1 && sudo -n \"$tool\" --version >/dev/null 2>&1; then echo \"sudo_nopasswd|$username|当前账号可免密 sudo 抓包|$machine|$abi|$uid_value|$tool|$tool_source\"; \
     elif command -v sudo >/dev/null 2>&1 && LC_ALL=C sudo -n -l 2>&1 | grep -qiE 'password is required|a password is required'; then echo \"sudo_password|$username|sudo 需要当前账号密码|$machine|$abi|$uid_value|$tool|$tool_source\"; \
     elif command -v sudo >/dev/null 2>&1 && id -nG 2>/dev/null | grep -qwE 'sudo|wheel|admin'; then echo \"sudo_password|$username|当前账号属于 sudo 管理组，需要密码|$machine|$abi|$uid_value|$tool|$tool_source\"; \
     else echo \"unavailable|$username|当前账号没有直接抓包或 sudo 权限|$machine|$abi|$uid_value|$tool|$tool_source\"; fi".to_string()
}

pub fn parse_capture_privilege_output(output: &str) -> Result<PacketCaptureProbe, String> {
    let marker = output
        .lines()
        .find(|line| {
            matches!(
                line.split('|').next(),
                Some("direct" | "sudo_nopasswd" | "sudo_password" | "tool_missing" | "unavailable")
            )
        })
        .ok_or_else(|| format!("无法识别抓包权限检查结果: {}", output.trim()))?;
    let fields = marker.splitn(8, '|').collect::<Vec<_>>();
    if fields.len() < 8 {
        return Err(format!("抓包权限检查结果字段不完整: {marker}"));
    }
    let uid = fields[5]
        .parse::<u32>()
        .map_err(|_| format!("抓包权限检查返回了无效 UID: {}", fields[5]))?;

    Ok(PacketCaptureProbe {
        mode: fields[0].to_string(),
        username: fields[1].to_string(),
        message: fields[2].to_string(),
        machine: fields[3].to_string(),
        abi: fields[4].to_string(),
        uid,
        tool_path: (!fields[6].is_empty()).then(|| fields[6].to_string()),
        tool_source: fields[7].to_string(),
    })
}

/// 生成获取网络接口的命令
pub fn generate_list_interfaces_command() -> String {
    "ip -o -4 addr show | awk '{print $2, $4}'".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ethernet_prefixed_ipv4_output() {
        let packet = parse_tcpdump_line(
            "2026-10-08 12:00:00.123456 eth0 Out ifindex 2 02:42:ac:11:00:02 ethertype IPv4 (0x0800), length 74: 192.168.9.247.2222 > 203.0.113.10.54321: Flags [P.], length 20",
            1,
        );

        assert_eq!(packet.protocol, "SSH");
        assert_eq!(packet.src, "192.168.9.247.2222");
        assert_eq!(packet.dst, "203.0.113.10.54321");
        assert_eq!(packet.length, "20");
    }

    #[test]
    fn parses_linux_any_interface_prefix() {
        let packet = parse_tcpdump_line(
            "2026-10-08 12:00:00.123456 eth0 In IP 10.0.0.2.53 > 10.0.0.3.53000: UDP, length 42",
            2,
        );

        assert_eq!(packet.protocol, "DNS");
        assert_eq!(packet.src, "10.0.0.2.53");
        assert_eq!(packet.dst, "10.0.0.3.53000");
        assert_eq!(packet.length, "42");
    }

    #[test]
    fn parses_icmp_without_treating_last_ip_octet_as_a_port() {
        let packet = parse_tcpdump_line(
            "2026-10-08 10:24:47.568546 lo In ifindex 1 00:00:00:00:00:00 ethertype IPv4 (0x0800), length 104: 127.0.0.1 > 127.0.0.1: ICMP echo request, id 1, seq 1, length 64",
            3,
        );

        assert_eq!(packet.protocol, "ICMP");
        assert_eq!(packet.src, "127.0.0.1");
        assert_eq!(packet.dst, "127.0.0.1");
        assert_eq!(packet.length, "64");
    }

    #[test]
    fn generated_command_supports_non_interactive_sudo_and_quotes_input() {
        let command =
            generate_tcpdump_command("any", Some("port 80 or port 443"), Some(10), 2222, false);

        assert!(command.contains("sudo -n \"$tool\" --version"));
        assert!(command.contains(
            "\"$tool\" -nne -l -tttt -i 'any' -c 10 '(port 80 or port 443) and not port 2222'"
        ));
        assert!(command.contains("tcpdump-$tool_arch-*"));
    }

    #[test]
    fn generated_password_sudo_command_reads_password_from_stdin() {
        let command = generate_tcpdump_command("eth0", None, None, 22, true);

        assert!(command.contains("exec sudo -S -p '' \"$tool\""));
        assert!(!command.contains("sudo -n"));
        assert!(command.contains("'not port 22'"));
    }

    #[test]
    fn parses_missing_tool_probe_with_architecture_and_uid() {
        let probe = parse_capture_privilege_output(
            "tool_missing|kali|目标机未安装 tcpdump|x86_64|default|1000|/tmp/lovelyres-1000/bin/tcpdump|none\n",
        )
        .unwrap();

        assert_eq!(probe.mode, "tool_missing");
        assert_eq!(probe.machine, "x86_64");
        assert_eq!(probe.uid, 1000);
        assert_eq!(
            probe.tool_path.as_deref(),
            Some("/tmp/lovelyres-1000/bin/tcpdump")
        );
    }

    #[test]
    fn rejects_incomplete_probe_output() {
        assert!(parse_capture_privilege_output("direct|root|ok").is_err());
    }
}
