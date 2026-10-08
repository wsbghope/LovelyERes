# LovelyERes Resources

该目录是 LovelyERes 的可扩展应急资源仓库。程序只扫描和展示这里的工具；
是否上传、是否验证、是否用于当前任务，始终由用户决定。

## 官方工具包

固定版本的 `0typos/statics` 架构包存放在：

`official/0typos-statics/<version>/packs/`

每个压缩包在使用前都会根据同目录 `release.json` 中的 SHA-256 摘要校验。
打包安装后，官方资源首次使用时会复制到用户可写的应用数据目录，方便后续直接
在同一个 `LovelyERes-Resources` 中增加自定义工具；程序升级只补充缺失资源，不覆盖已有文件。

## 用户工具

把 Linux ELF 文件放入对应架构目录，例如：

- `custom/x86_64/bin/`
- `custom/aarch64/bin/`
- `custom/armv7-hardfloat/bin/`

程序不会在本机执行这些文件。没有描述文件也可以扫描和上传；这类文件会显示为
“用户添加 / 来源未验证”。架构与目标机不一致时仍允许上传，但会明确提示预计无法执行。

所有工具都上传到当前 SSH 用户专属的 `/tmp/lovelyres-UID/`，不会覆盖目标机的
`/usr/bin`、`/bin` 或其他系统命令。
