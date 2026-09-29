# Windows/macOS 跨平台验证说明

本文件记录 LovelyRes 在 Windows 和 macOS 上的拉取、运行、构建和回归检查步骤。

> 当前 macOS 开发环境已经完成基础验证。Windows 侧计划于 **2026 年 9 月 30 日** 使用本文档进行首次验证。

## 1. 环境要求

- Git
- Node.js 18 或更高版本
- npm
- Rust stable toolchain
- Windows：安装 Microsoft Edge WebView2 Runtime
- macOS：安装 Xcode Command Line Tools

建议先确认版本：

```bash
node --version
npm --version
rustc --version
cargo --version
```

## 2. 拉取代码

如果是首次拉取：

```bash
git clone <你的仓库地址>
cd LovelyERes
```

如果本地已经有仓库：

```bash
git pull --ff-only origin main
```

确认当前提交包含本次跨平台修复：

```bash
git log -1 --oneline
```

## 3. 安装依赖

推荐使用锁定版本安装：

```bash
npm ci
```

如果 npm 缓存权限或缓存目录出现问题，临时缓存必须放在项目的 `tmp` 目录中：

```bash
npm ci --cache ./tmp/npm-cache
```

不要把 `.env`、SSH 私钥、API Key 或真实服务器凭据放入仓库。

## 4. 基础检查

在启动桌面应用前，先执行：

```bash
npm run build
npm test
cd src-tauri
cargo test --locked
cd ..
```

预期结果：

- `npm run build` 成功完成 Vite 构建
- 前端测试全部通过
- Rust 测试全部通过
- 不应出现编译错误

## 5. 启动开发模式

```bash
npm run tauri dev
```

需要重点确认：

- 主窗口能够正常打开
- Windows 窗口没有多余控制台窗口
- macOS 标题栏和窗口关闭行为正常
- 窗口可以最小化、最大化、还原和关闭
- 主页面加载完成后没有持续报错
- SSH 终端窗口可以打开和关闭
- 容器终端窗口可以打开和关闭
- Web Terminal URL 校验和窗口创建正常

## 6. 设置和主题回归

在设置页面依次验证：

- 浅色
- 深色
- 樱花粉
- 暗夜
- 深海

然后重启应用，确认主题和其他设置仍然保留。

重点检查：

- 全局字体
- 全局字体大小
- SSH 默认端口
- SSH 连接超时为 `0` 时可以表示禁用超时
- AI 提供商配置不会因为切换主题而丢失
- 设置文件损坏时应用能够给出错误，而不是静默覆盖用户配置

## 7. SSH/SFTP 回归

准备一台可测试的 Linux SSH 服务器，验证：

- 密码登录
- SSH 私钥登录
- 连接测试
- 断开连接
- SSH 终端输入和输出
- SFTP 列目录
- 下载文件
- 上传文件
- 新建目录
- 重命名文件
- 查看和修改文件权限
- 删除文件前的确认提示

Windows 上特别检查：

- 私钥路径使用 Windows 路径时可以正常选择和读取
- 路径中包含空格时不会失败
- 使用反斜杠的路径不会被错误转义

macOS 上特别检查：

- `~/Library/Application Support/lovelyres` 下的配置可以正常创建
- 私钥权限和读取行为正常
- 文件选择器能够访问用户选择的目录

## 8. 构建应用

```bash
npm run tauri build
```

构建产物位于：

```text
src-tauri/target/release/bundle/
```

Windows 预期检查：

- `msi` 或 `nsis` 安装包能够生成
- 安装包能够安装和卸载
- 安装后的程序能够启动
- 安装路径包含空格时仍能启动

macOS 预期检查：

- `LovelyRes.app` 能够生成
- DMG 能够生成
- 应用可以从 DMG 拖入 Applications
- 首次启动时不会因为 Bundle Identifier 或窗口配置失败

## 9. 反馈信息

如果 Windows 验证失败，请提供以下信息：

```text
Windows 版本：
Node.js 版本：
npm 版本：
Rust 版本：
失败命令：
完整错误信息：
```

同时建议附上：

- `npm run build` 输出
- `npm test` 输出
- `cd src-tauri && cargo test --locked` 输出
- `npm run tauri dev` 输出
- 失败功能的截图或复现步骤

## 10. 当前已知提醒

- `russh` 当前版本在 Rust 编译时会给出未来兼容性提醒，但目前不阻止构建。
- 本项目的远程应急检测命令主要针对 Linux 服务器；Windows/macOS 客户端跨平台不等于远端检测命令支持 Windows 服务器。
- `tmp/` 仅用于临时缓存和临时产出，不应提交到 Git。
