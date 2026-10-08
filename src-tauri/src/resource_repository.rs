use crate::{offline_tools, AppState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use xz2::read::XzDecoder;

const RESOURCE_DIR_NAME: &str = "LovelyERes-Resources";
const OFFICIAL_SOURCE: &str = "0typos-statics";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTool {
    pub key: String,
    pub name: String,
    pub provider: String,
    pub architecture: String,
    pub source: String,
    pub version: Option<String>,
    pub category: String,
    pub description: String,
    pub size: u64,
    pub sha256: String,
    pub verified: bool,
    pub system_path: Option<String>,
    pub deployed_paths: Vec<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceScanResult {
    pub root: String,
    pub target_architecture: String,
    pub selected_architecture: String,
    pub uid: u32,
    pub available_architectures: Vec<String>,
    pub tools: Vec<ResourceTool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployResourceToolsRequest {
    pub keys: Vec<String>,
    #[serde(default)]
    pub verify_after_upload: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDeployment {
    pub key: String,
    pub name: String,
    pub provider: String,
    pub architecture: String,
    pub remote_path: String,
    pub invocation: String,
    pub sha256: String,
    pub verification: Option<String>,
    pub verification_ok: Option<bool>,
}

#[derive(Debug)]
struct RemoteContext {
    architecture: String,
    uid: u32,
}

#[derive(Debug)]
struct LoadedTool {
    tool: ResourceTool,
    bytes: Vec<u8>,
}

fn architecture_names() -> Vec<String> {
    [
        "x86_64",
        "i686",
        "aarch64",
        "armv6-hardfloat",
        "armv7-hardfloat",
        "armv7-softfloat",
        "mips",
        "mipsel",
        "powerpc",
        "powerpc64",
        "powerpc64le",
        "riscv64",
        "s390x",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn path_is_inside(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
        && path
            .components()
            .all(|part| !matches!(part, Component::ParentDir))
}

fn copy_missing_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("创建资源目录 {} 失败: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("读取内置资源目录 {} 失败: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("读取内置资源条目失败: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_missing_tree(&source_path, &destination_path)?;
        } else if source_path.is_file() && !destination_path.exists() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "初始化资源文件 {} 失败: {error}",
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("LOVELYRES_RESOURCES_DIR") {
        let path = PathBuf::from(explicit);
        fs::create_dir_all(&path).map_err(|error| format!("创建资源目录失败: {error}"))?;
        return path
            .canonicalize()
            .map_err(|error| format!("解析资源目录失败: {error}"));
    }

    let current = std::env::current_dir().map_err(|error| format!("获取当前目录失败: {error}"))?;
    let mut candidates = Vec::new();
    if current.join("package.json").is_file() {
        candidates.push(current.join(RESOURCE_DIR_NAME));
    }
    if current.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        if let Some(parent) = current.parent() {
            candidates.push(parent.join(RESOURCE_DIR_NAME));
        }
    }
    if let Some(path) = candidates.into_iter().find(|path| path.is_dir()) {
        return path
            .canonicalize()
            .map_err(|error| format!("解析资源目录失败: {error}"));
    }

    let fallback = crate::types::get_app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败: {error}"))?
        .join(RESOURCE_DIR_NAME);
    fs::create_dir_all(&fallback).map_err(|error| format!("创建资源目录失败: {error}"))?;
    if let Ok(resource_dir) = app.path().resource_dir() {
        copy_missing_tree(&resource_dir.join(RESOURCE_DIR_NAME), &fallback)?;
    }
    fallback
        .canonicalize()
        .map_err(|error| format!("解析资源目录失败: {error}"))
}

fn latest_official_release(root: &Path) -> Result<(String, PathBuf), String> {
    let source_root = root.join("official").join(OFFICIAL_SOURCE);
    let mut versions = fs::read_dir(&source_root)
        .map_err(|error| format!("未找到官方工具包目录 {}: {error}", source_root.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            entry
                .file_name()
                .into_string()
                .ok()
                .map(|name| (name, entry.path()))
        })
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| right.0.cmp(&left.0));
    versions
        .into_iter()
        .next()
        .ok_or_else(|| "官方工具包目录中没有可用版本".to_string())
}

fn release_digest(release_dir: &Path, archive_name: &str) -> Result<String, String> {
    let release_path = release_dir.join("release.json");
    let release: serde_json::Value = serde_json::from_slice(
        &fs::read(&release_path)
            .map_err(|error| format!("读取 {} 失败: {error}", release_path.display()))?,
    )
    .map_err(|error| format!("解析 release.json 失败: {error}"))?;
    release["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find_map(|asset| {
                (asset["name"].as_str() == Some(archive_name))
                    .then(|| asset["digest"].as_str())
                    .flatten()
            })
        })
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(str::to_string)
        .ok_or_else(|| format!("release.json 中缺少 {archive_name} 的 SHA-256"))
}

fn hash_reader(mut reader: impl Read) -> Result<String, String> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("计算 SHA-256 失败: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn verify_archive(release_dir: &Path, architecture: &str) -> Result<PathBuf, String> {
    let archive_name = format!("statics-{architecture}.tar.xz");
    let archive_path = release_dir.join("packs").join(&archive_name);
    let expected = release_digest(release_dir, &archive_name)?;
    let actual = hash_reader(
        File::open(&archive_path)
            .map_err(|error| format!("打开 {} 失败: {error}", archive_path.display()))?,
    )?;
    if actual != expected {
        return Err(format!(
            "官方工具包摘要不匹配，已拒绝使用 {}（期望 {expected}，实际 {actual}）",
            archive_path.display()
        ));
    }
    Ok(archive_path)
}

fn tool_profile(name: &str) -> (String, String) {
    let network = [
        "arp",
        "arping",
        "bridge",
        "curl",
        "drill",
        "ethtool",
        "ifconfig",
        "ip",
        "iperf3",
        "mtr",
        "mtr-packet",
        "nc",
        "ncat",
        "netcat",
        "netstat",
        "nmap",
        "nslookup",
        "ping",
        "ping6",
        "route",
        "socat",
        "ss",
        "tc",
        "tcpdump",
        "telnet",
        "traceroute",
        "traceroute6",
        "wg",
    ];
    let analysis = [
        "jq", "lsof", "strace", "openssl", "findmnt", "lsns", "nsenter",
    ];
    let transfer = ["rsync", "scp", "wget", "dbclient", "dropbear"];
    let category = if network.contains(&name) {
        "网络诊断"
    } else if analysis.contains(&name) {
        "调查分析"
    } else if transfer.contains(&name) {
        "文件与远程访问"
    } else if name == "busybox" {
        "基础恢复"
    } else {
        "其他工具"
    };
    let description = match name {
        "busybox" => "恢复基础命令，并提供 wget、nc、ping 等 applet",
        "curl" => "HTTP/HTTPS 与多协议请求诊断",
        "wget" => "通过 BusyBox 下载文件",
        "nc" | "netcat" => "通过 BusyBox 检查 TCP/UDP 连通性",
        "tcpdump" => "捕获和分析网络数据包",
        "strace" => "跟踪进程系统调用",
        "lsof" => "查看进程打开的文件和套接字",
        "jq" => "处理 JSON 数据",
        "socat" => "网络转发和双向数据通道",
        "ip" => "查看和管理网络地址、路由与链路",
        "ss" => "查看网络套接字",
        "nmap" => "网络发现与服务探测",
        _ => "静态 Linux 应急诊断工具",
    };
    (category.to_string(), description.to_string())
}

fn parse_sha256sums(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let hash = fields.next()?;
            let name = fields.next()?.trim_start_matches('*');
            (hash.len() == 64).then(|| (name.to_string(), hash.to_string()))
        })
        .collect()
}

fn scan_official_archive(
    version: &str,
    archive_path: &Path,
    architecture: &str,
) -> Result<Vec<ResourceTool>, String> {
    let decoder = XzDecoder::new(
        File::open(archive_path)
            .map_err(|error| format!("打开 {} 失败: {error}", archive_path.display()))?,
    );
    let mut archive = tar::Archive::new(decoder);
    let mut sums = HashMap::new();
    let mut files = HashMap::<String, u64>::new();
    let mut links = HashMap::<String, String>::new();

    for item in archive
        .entries()
        .map_err(|error| format!("读取工具包目录失败: {error}"))?
    {
        let mut entry = item.map_err(|error| format!("读取工具包条目失败: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("工具包路径无效: {error}"))?
            .into_owned();
        let components = path
            .components()
            .filter_map(|part| match part {
                Component::Normal(value) => value.to_str().map(str::to_string),
                _ => None,
            })
            .collect::<Vec<_>>();
        if components.len() != 2 || components[0] != architecture {
            continue;
        }
        let name = components[1].clone();
        if name == "SHA256SUMS" {
            let mut text = String::new();
            entry
                .read_to_string(&mut text)
                .map_err(|error| format!("读取 SHA256SUMS 失败: {error}"))?;
            sums = parse_sha256sums(&text);
        } else if entry.header().entry_type().is_file() {
            if !matches!(
                name.as_str(),
                "BUILDINFO"
                    | "BUILD_RECIPES_LICENSE"
                    | "COMPONENTS.tsv"
                    | "SBOM.spdx.json"
                    | "THIRD_PARTY_NOTICES.md"
                    | "sources.lock"
            ) {
                files.insert(name, entry.size());
            }
        } else if entry.header().entry_type().is_symlink() {
            if let Some(target) = entry
                .link_name()
                .map_err(|error| format!("读取工具链接失败: {error}"))?
                .and_then(|path| {
                    path.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
            {
                links.insert(name, target);
            }
        }
    }

    let mut names = files
        .keys()
        .chain(links.keys())
        .cloned()
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names
        .into_iter()
        .map(|name| {
            let provider = links.get(&name).cloned().unwrap_or_else(|| name.clone());
            let sha256 = sums.get(&provider).cloned().unwrap_or_default();
            let size = files.get(&provider).copied().unwrap_or_default();
            let (category, description) = tool_profile(&name);
            ResourceTool {
                key: format!("official:{version}:{architecture}:{name}"),
                name,
                provider,
                architecture: architecture.to_string(),
                source: "official".to_string(),
                version: Some(version.to_string()),
                category,
                description,
                size,
                verified: sha256.len() == 64,
                sha256,
                system_path: None,
                deployed_paths: Vec::new(),
                warning: None,
            }
        })
        .collect())
}

fn detect_elf_architecture(bytes: &[u8], declared: &str) -> Option<String> {
    if bytes.len() < 20 || &bytes[..4] != b"\x7fELF" {
        return None;
    }
    let little_endian = bytes[5] == 1;
    let machine = if little_endian {
        u16::from_le_bytes([bytes[18], bytes[19]])
    } else {
        u16::from_be_bytes([bytes[18], bytes[19]])
    };
    let architecture = match machine {
        3 => "i686",
        8 if little_endian => "mipsel",
        8 => "mips",
        20 => "powerpc",
        21 if little_endian => "powerpc64le",
        21 => "powerpc64",
        22 => "s390x",
        40 => declared,
        62 => "x86_64",
        183 => "aarch64",
        243 => "riscv64",
        _ => return None,
    };
    Some(architecture.to_string())
}

fn scan_custom_tools(root: &Path, architecture: &str) -> Result<Vec<ResourceTool>, String> {
    let custom_root = root.join("custom").join(architecture).join("bin");
    if !custom_root.exists() {
        return Ok(Vec::new());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("解析资源目录失败: {error}"))?;
    let mut tools = Vec::new();
    for entry in fs::read_dir(&custom_root)
        .map_err(|error| format!("扫描 {} 失败: {error}", custom_root.display()))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() || entry.file_name() == ".gitkeep" {
            continue;
        }
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("解析用户工具路径失败: {error}"))?;
        if !path_is_inside(&canonical, &canonical_root) {
            continue;
        }
        let bytes = fs::read(&canonical)
            .map_err(|error| format!("读取用户工具 {} 失败: {error}", path.display()))?;
        let sha256 = offline_tools::sha256_hex(&bytes);
        let name = entry.file_name().to_string_lossy().to_string();
        if !offline_tools::valid_tool_name(&name) {
            continue;
        }
        let detected = detect_elf_architecture(&bytes, architecture);
        let actual_architecture = detected.clone().unwrap_or_else(|| architecture.to_string());
        let (category, description) = tool_profile(&name);
        tools.push(ResourceTool {
            key: format!("custom:{architecture}:{name}:{}", &sha256[..12]),
            name: name.clone(),
            provider: name,
            architecture: actual_architecture,
            source: "custom".to_string(),
            version: None,
            category,
            description,
            size: bytes.len() as u64,
            sha256,
            verified: false,
            system_path: None,
            deployed_paths: Vec::new(),
            warning: if detected.is_none() {
                Some("不是可识别的 Linux ELF；仍允许上传，但程序不会自动执行".to_string())
            } else {
                Some("用户添加工具，来源未经 LovelyRes 验证".to_string())
            },
        });
    }
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(tools)
}

fn remote_context(state: &AppState) -> Result<RemoteContext, String> {
    let command = "machine=$(uname -m 2>/dev/null || printf unknown); abi=default; case \"$machine\" in armv6*|armv7*) if [ -e /lib/ld-linux-armhf.so.3 ] || [ -e /lib/arm-linux-gnueabihf/ld-linux-armhf.so.3 ]; then abi=hardfloat; else abi=softfloat; fi ;; esac; printf '%s|%s|%s' \"$machine\" \"$abi\" \"$(id -u)\"";
    let output = state
        .ssh_manager
        .execute_command(command)
        .map_err(|error| format!("检测目标架构失败: {error}"))?;
    let fields = output.output.trim().split('|').collect::<Vec<_>>();
    if fields.len() != 3 {
        return Err(format!("无法识别目标架构信息: {}", output.output.trim()));
    }
    let architecture = offline_tools::normalize_linux_architecture(fields[0], Some(fields[1]))
        .unwrap_or(fields[0])
        .to_string();
    let uid = fields[2]
        .parse::<u32>()
        .map_err(|_| format!("目标返回了无效 UID: {}", fields[2]))?;
    Ok(RemoteContext { architecture, uid })
}

fn probe_system_paths(state: &AppState, names: &[String]) -> HashMap<String, String> {
    let names = names
        .iter()
        .filter(|name| offline_tools::valid_tool_name(name))
        .map(|name| format!("'{name}'"))
        .collect::<Vec<_>>()
        .join(" ");
    if names.is_empty() {
        return HashMap::new();
    }
    let command = format!(
        "for lovelyres_name in {names}; do lovelyres_path=$(command -v \"$lovelyres_name\" 2>/dev/null || true); printf '%s|%s\\n' \"$lovelyres_name\" \"$lovelyres_path\"; done"
    );
    state
        .ssh_manager
        .execute_command(&command)
        .ok()
        .map(|output| {
            output
                .output
                .lines()
                .filter_map(|line| {
                    let (name, path) = line.split_once('|')?;
                    (!path.is_empty()).then(|| (name.to_string(), path.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn deployed_paths(state: &AppState, uid: u32) -> Vec<String> {
    state
        .ssh_manager
        .list_sftp_files(&format!("/tmp/lovelyres-{uid}/bin"))
        .map(|files| {
            files
                .into_iter()
                .filter(|file| file.file_type == "file")
                .map(|file| file.path)
                .collect()
        })
        .unwrap_or_default()
}

fn scan_tools_for_architecture(
    root: &Path,
    architecture: &str,
) -> Result<Vec<ResourceTool>, String> {
    if !architecture_names().iter().any(|item| item == architecture) {
        return Err(format!("资源仓库中没有架构 {architecture}"));
    }
    let (version, release_dir) = latest_official_release(root)?;
    let archive_path = verify_archive(&release_dir, architecture)?;
    let mut tools = scan_official_archive(&version, &archive_path, architecture)?;
    tools.extend(scan_custom_tools(root, architecture)?);
    Ok(tools)
}

fn extract_official_provider(
    archive_path: &Path,
    architecture: &str,
    provider: &str,
) -> Result<Vec<u8>, String> {
    let decoder = XzDecoder::new(
        File::open(archive_path)
            .map_err(|error| format!("打开 {} 失败: {error}", archive_path.display()))?,
    );
    let mut archive = tar::Archive::new(decoder);
    let expected = PathBuf::from(architecture).join(provider);
    for item in archive
        .entries()
        .map_err(|error| format!("读取工具包失败: {error}"))?
    {
        let mut entry = item.map_err(|error| format!("读取工具条目失败: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("工具路径无效: {error}"))?;
        if path == expected && entry.header().entry_type().is_file() {
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut bytes)
                .map_err(|error| format!("解压工具失败: {error}"))?;
            return Ok(bytes);
        }
    }
    Err(format!("工具包中缺少 {architecture}/{provider}"))
}

fn load_tool(root: &Path, key: &str) -> Result<LoadedTool, String> {
    let fields = key.split(':').collect::<Vec<_>>();
    match fields.as_slice() {
        ["official", version, architecture, _name] => {
            let release_dir = root.join("official").join(OFFICIAL_SOURCE).join(version);
            let archive_path = verify_archive(&release_dir, architecture)?;
            let tool = scan_official_archive(version, &archive_path, architecture)?
                .into_iter()
                .find(|tool| tool.key == key)
                .ok_or_else(|| format!("资源索引中不存在工具 {key}"))?;
            let bytes = extract_official_provider(&archive_path, architecture, &tool.provider)?;
            let actual = offline_tools::sha256_hex(&bytes);
            if actual != tool.sha256 {
                return Err(format!("工具 {} 的包内 SHA-256 校验失败", tool.name));
            }
            Ok(LoadedTool { tool, bytes })
        }
        ["custom", declared_architecture, _name, _hash] => {
            let tool = scan_custom_tools(root, declared_architecture)?
                .into_iter()
                .find(|tool| tool.key == key)
                .ok_or_else(|| format!("用户工具已移动或内容发生变化: {key}"))?;
            let path = root
                .join("custom")
                .join(declared_architecture)
                .join("bin")
                .join(&tool.name);
            let canonical_root = root
                .canonicalize()
                .map_err(|error| format!("解析资源目录失败: {error}"))?;
            let canonical = path
                .canonicalize()
                .map_err(|error| format!("解析用户工具失败: {error}"))?;
            if !path_is_inside(&canonical, &canonical_root) {
                return Err("拒绝读取资源目录之外的用户工具".to_string());
            }
            let bytes =
                fs::read(canonical).map_err(|error| format!("读取用户工具失败: {error}"))?;
            Ok(LoadedTool { tool, bytes })
        }
        _ => Err("无效的资源工具标识".to_string()),
    }
}

#[tauri::command]
pub async fn get_resource_directory(app: AppHandle) -> Result<String, String> {
    Ok(resource_root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn scan_resource_tools(
    architecture: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceScanResult, String> {
    let root = resource_root(&app)?;
    let context = remote_context(&state)?;
    let selected_architecture = architecture.unwrap_or_else(|| context.architecture.clone());
    let mut tools = scan_tools_for_architecture(&root, &selected_architecture)?;
    let names = tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    let system = probe_system_paths(&state, &names);
    let deployed = deployed_paths(&state, context.uid);

    for tool in &mut tools {
        tool.system_path = system.get(&tool.name).cloned();
        let prefix = format!("{}-{}-", tool.provider, selected_architecture);
        tool.deployed_paths = deployed
            .iter()
            .filter(|path| {
                Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix))
            })
            .cloned()
            .collect();
        if selected_architecture != context.architecture {
            tool.warning = Some(format!(
                "工具架构为 {selected_architecture}，目标架构为 {}；仍允许上传，但通常无法直接执行",
                context.architecture
            ));
        }
    }

    Ok(ResourceScanResult {
        root: root.to_string_lossy().to_string(),
        target_architecture: context.architecture,
        selected_architecture,
        uid: context.uid,
        available_architectures: architecture_names(),
        tools,
    })
}

#[tauri::command]
pub async fn deploy_resource_tools(
    request: DeployResourceToolsRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ResourceDeployment>, String> {
    if request.keys.is_empty() {
        return Err("请至少选择一个工具".to_string());
    }
    if request.keys.len() > 64 {
        return Err("单次最多上传 64 个工具".to_string());
    }
    let root = resource_root(&app)?;
    let context = remote_context(&state)?;
    let mut loaded = Vec::new();
    for key in &request.keys {
        loaded.push(load_tool(&root, key)?);
    }

    // wget/nc 等 BusyBox applet 只上传一次物理 provider。
    let mut provider_paths = HashMap::<(String, String, String), String>::new();
    let mut results = Vec::new();
    for loaded_tool in loaded {
        let hash = offline_tools::sha256_hex(&loaded_tool.bytes);
        let provider_key = (
            loaded_tool.tool.provider.clone(),
            loaded_tool.tool.architecture.clone(),
            hash.clone(),
        );
        let remote_path = if let Some(path) = provider_paths.get(&provider_key) {
            path.clone()
        } else {
            let remote_name = format!(
                "{}-{}-{}",
                loaded_tool.tool.provider,
                loaded_tool.tool.architecture,
                &hash[..12]
            );
            let path = offline_tools::remote_tool_path(context.uid, &remote_name)?;
            state
                .ssh_manager
                .deploy_offline_tool(&path, context.uid, &loaded_tool.bytes)
                .map_err(|error| format!("上传 {} 失败: {error}", loaded_tool.tool.name))?;
            provider_paths.insert(provider_key, path.clone());
            path
        };

        let invocation = if loaded_tool.tool.provider != loaded_tool.tool.name {
            format!("{remote_path} {}", loaded_tool.tool.name)
        } else {
            remote_path.clone()
        };
        let (verification, verification_ok) = if request.verify_after_upload {
            let command = format!(
                "LC_ALL=C {invocation} --version 2>&1 || LC_ALL=C {invocation} --help 2>&1"
            );
            match state.ssh_manager.execute_command(&command) {
                Ok(output) => (Some(output.output), output.exit_code.map(|code| code == 0)),
                Err(error) => (Some(error), Some(false)),
            }
        } else {
            (None, None)
        };

        results.push(ResourceDeployment {
            key: loaded_tool.tool.key,
            name: loaded_tool.tool.name,
            provider: loaded_tool.tool.provider,
            architecture: loaded_tool.tool.architecture,
            remote_path,
            invocation,
            sha256: hash,
            verification,
            verification_ok,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_elf_architectures_without_executing_the_file() {
        let mut elf = vec![0u8; 20];
        elf[..4].copy_from_slice(b"\x7fELF");
        elf[5] = 1;
        elf[18..20].copy_from_slice(&62u16.to_le_bytes());
        assert_eq!(
            detect_elf_architecture(&elf, "unknown").as_deref(),
            Some("x86_64")
        );
    }

    #[test]
    fn rejects_non_elf_files_for_architecture_detection() {
        assert_eq!(detect_elf_architecture(b"shell script", "x86_64"), None);
    }

    #[test]
    fn parses_toolkit_checksums() {
        let sums = parse_sha256sums(&format!("{}  tcpdump\n", "a".repeat(64)));
        assert_eq!(
            sums.get("tcpdump").map(String::as_str),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }

    #[test]
    fn scans_verified_official_pack_and_resolves_busybox_applets() {
        let release_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(RESOURCE_DIR_NAME)
            .join("official")
            .join(OFFICIAL_SOURCE)
            .join("v2026.08.01");
        let archive = verify_archive(&release_dir, "x86_64").expect("official pack must verify");
        let tools = scan_official_archive("v2026.08.01", &archive, "x86_64")
            .expect("official pack must be readable");

        let tcpdump = tools.iter().find(|tool| tool.name == "tcpdump").unwrap();
        assert_eq!(tcpdump.provider, "tcpdump");
        assert!(tcpdump.verified);
        let wget = tools.iter().find(|tool| tool.name == "wget").unwrap();
        assert_eq!(wget.provider, "busybox");
        assert!(tools.iter().any(|tool| tool.name == "curl"));
        assert!(tools.iter().any(|tool| tool.name == "nc"));
    }
}
