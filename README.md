# cursor chinese

cursor chinese 是一个用于汉化 Cursor 编辑器界面的本地工具。它通过修改 Cursor 安装目录中的前端资源文件，将部分英文界面文案替换为中文，并同步修复 Cursor 的文件校验信息，尽量避免出现“安装已损坏”等提示。

> 注意：本工具不是 Cursor 官方项目，也不会修改 Cursor 的账号、模型、插件、项目代码或云端配置。它只处理本机已安装 Cursor 的应用资源文件。

## 它解决什么

Cursor 的官方界面中仍有不少英文文案，尤其是设置页、Agent 运行状态、工具调用状态、套餐与用量、MCP、Hooks、权限、沙盒和新版本新增界面。本工具用于：

- 将 Cursor 常见英文 UI 文案替换为中文。
- 补充 Cursor 新版本中遗漏或新增的英文界面。
- 支持一键汉化和恢复英文原版。
- 自动备份原始资源文件，便于回退。
- 自动更新 `product.json` 校验值，减少“安装已损坏”提示。
- macOS 下自动清理隔离属性并重新签名，减少系统拦截。

## 支持平台与产物

预编译产物位于 `dist` 目录：

| 文件 | 平台 | 架构 |
| --- | --- | --- |
| `cursor-chinese-win-x64.exe` | Windows | x64 |
| `cursor-chinese-macos-arm64` | macOS | Apple Silicon |
| `cursor-chinese-macos-x64` | macOS | Intel |
| `cursor-chinese-linux-x64` | Linux | x64 |
| `cursor-chinese-linux-arm64` | Linux | arm64 |

兼容性说明：

- Windows：支持常见的 Cursor 用户目录安装和 Program Files 安装路径。
- macOS：支持 `/Applications/Cursor.app` 和用户目录下的 `Applications/Cursor.app`。
- Linux：支持常见的 `/opt/Cursor`、`/usr/share/cursor`、`/usr/lib/cursor`、`~/.local/share/cursor` 等安装路径；如果使用 AppImage 或非标准路径，建议手动指定 `resources/app`。
- Cursor 更新后，官方资源文件会被覆盖，需要重新运行本工具。
- Cursor 大版本更新后，如果出现新英文或结构变化，需要更新词库或核心替换规则后重新编译。

## 使用方式

### 方式一：运行预编译成品

根据系统选择对应文件：

macOS Apple Silicon：

```bash
./dist/cursor-chinese-macos-arm64
```

macOS Intel：

```bash
./dist/cursor-chinese-macos-x64
```

Windows：

```powershell
.\dist\cursor-chinese-win-x64.exe
```

Linux x64：

```bash
./dist/cursor-chinese-linux-x64
```

Linux arm64：

```bash
./dist/cursor-chinese-linux-arm64
```

运行后按提示选择：

- `一键汉化`：修改 Cursor 资源文件并应用中文。
- `恢复英文`：从 `.backup` 备份恢复原始文件。
- `退出`：关闭工具。

### 方式二：使用 Node.js 从源码运行

安装依赖：

```bash
npm install
```

启动交互式菜单：

```bash
npm start
```

直接指定 Cursor 路径并静默汉化：

```bash
node index.js --action=translate --cursor-path="/Applications/Cursor.app/Contents/Resources/app"
```

直接恢复英文：

```bash
node index.js --action=restore --cursor-path="/Applications/Cursor.app/Contents/Resources/app"
```

### 重新编译成品

生成 Windows 和 macOS 三个平台产物：

```bash
npm run build
```

仅生成 Windows：

```bash
npm run build:win
```

仅生成 macOS：

```bash
npm run build:mac
```

仅生成 Linux：

```bash
npm run build:linux
```

## 工作逻辑

工具运行时大致按以下步骤执行：

1. 定位 Cursor 安装目录。
   - 优先使用命令行传入的 `--cursor-path`。
   - 其次使用已保存的配置。
   - 最后自动扫描常见安装路径。

2. 生成待处理文件路径。
   - `out/vs/workbench/workbench.desktop.main.js`
   - `out/vs/code/electron-sandbox/workbench/workbench.html`
   - `product.json`

3. 创建原始备份。
   - 首次运行会生成 `.backup` 文件。
   - 再次运行时保留已有备份，避免把已汉化文件覆盖成备份。

4. 执行汉化替换。
   - `src/dict.js` 保存相对安全的全局长句词典。
   - `src/i18n-core.js` 处理复杂模板、短词保护、作用域替换和顽固词条。
   - 对 `Read`、`file`、`Agent` 等高频词，尽量使用上下文精准替换，避免误伤代码逻辑。

5. 写回 Cursor 核心 JS 文件。

6. 更新 `product.json` 中对应资源文件的 checksum。

7. macOS 下执行系统兼容处理。
   - 清理隔离属性：`xattr -cr`
   - 本地重新签名：`codesign --force --deep --sign -`

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `index.js` | 命令入口、交互菜单、静默模式入口 |
| `src/platform.js` | 跨平台路径检测、配置保存、权限检查、提权执行 |
| `src/i18n-core.js` | 核心汉化、备份恢复、校验修复、macOS 签名处理 |
| `src/dict.js` | 安全词典和短词词典 |
| `keys.json` | 词条辅助数据 |
| `dist/` | 编译后的可执行文件 |

## 配置与备份

工具会在用户目录保存 Cursor 路径配置：

```text
~/.cursor-chinese/config.json
```

工具会在 Cursor 安装目录旁生成备份文件：

```text
workbench.desktop.main.js.backup
workbench.html.backup
product.json.backup
```

恢复英文时会优先使用这些备份文件。

## 权限说明

如果 Cursor 安装目录当前用户可写，工具会直接执行。

如果没有写入权限：

- Windows/macOS 会尝试通过 `sudo-prompt` 请求管理员权限。
- Linux 桌面环境如果支持系统提权提示，也会尝试请求管理员权限；如果提权不可用，请用 `sudo` 运行工具或手动指定用户可写的 Cursor 安装路径。
- 提权后会重新运行同一个工具，并带上当前选择的操作参数。

本工具不会主动上传文件、代码或用户数据。它的网络行为主要可能来自安装依赖或打包工具下载基础运行时；日常汉化流程本身不需要联网。

## 常见问题

### 汉化后没有变化

请确认：

- 已完全退出并重启 Cursor。
- 选择的是当前正在使用的 Cursor 安装目录。
- Cursor 更新后是否覆盖了资源文件，必要时重新运行汉化。

### 提示 Cursor 安装已损坏

本工具会尝试自动更新 `product.json` checksum。若仍出现提示，可以：

- 关闭 Cursor 后重新运行汉化。
- 使用“恢复英文”回退后再汉化。
- 检查是否被系统权限或安全软件阻止写入。

### macOS 提示无法打开或已损坏

工具会自动执行 `xattr` 和 `codesign`。如果仍失败，可以手动执行：

```bash
xattr -cr /Applications/Cursor.app
codesign --force --deep --sign - /Applications/Cursor.app
```

### Cursor 更新后英文又出现

Cursor 更新会覆盖已修改的资源文件。重新运行本工具即可。如果新版本增加了新的英文文案，需要补充词典或核心替换规则。

### 可以恢复官方英文吗

可以。运行工具后选择“恢复英文”，或执行：

```bash
node index.js --action=restore --cursor-path="/Applications/Cursor.app/Contents/Resources/app"
```

## 创建问题与反馈

如果发现漏翻、误翻或运行失败，建议提交问题时附带以下信息：

- 操作系统和架构，例如 macOS arm64、macOS x64、Windows x64。
- Cursor 版本号。
- 使用的是源码运行还是 `dist` 里的成品。
- 执行命令和完整报错日志。
- 漏翻界面的截图。
- 如果是漏翻，尽量提供英文原文。

不要在公开问题中粘贴账号 Token、API Key、公司私有代码、日志中的敏感路径或内部项目内容。

## 开发说明

安装依赖：

```bash
npm install
```

检查语法：

```bash
node --check index.js
node --check src/i18n-core.js
node --check src/platform.js
node --check src/dict.js
```

本地运行：

```bash
npm start
```

构建：

```bash
npm run build
```

## 安全边界

本工具会修改 Cursor 应用安装目录中的资源文件，因此建议：

- 使用前先退出 Cursor。
- 保留 `.backup` 文件，方便恢复。
- 从可信来源获取工具或自行从源码构建。
- 不要把未知来源的二进制文件放到生产或敏感环境中直接运行。

## 许可证

本项目使用 MIT License。详见 [LICENSE](LICENSE)。
