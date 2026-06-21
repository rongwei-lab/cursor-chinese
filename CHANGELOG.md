# Changelog

## 1.0.3 - 2026-06-21

### 改进

- 调整终端启动界面风格，移除调侃式 Banner 和菜单文案。
- 将交互菜单简化为 `一键汉化`、`恢复英文` 和 `退出`。
- 补充 Rules、Skills、Subagents、Commands 二级菜单的空状态、加载失败、表单占位、保存按钮和错误提示汉化。
- 补充压缩资源中的 Rules 空状态兜底替换，覆盖 `No Rules Yet`、`Create rules to guide Agent behavior` 和 `New User Rule` 等未汉化文案。
- 重新生成 Windows、macOS、Linux x64 和 Linux arm64 成品。

## 1.0.2 - 2026-06-21

### 改进

- 将汉化过程中的随机提示文案改为进度条展示。
- 新增本次修改内容摘要，显示总修改数量、分类统计和部分命中文案。
- 备份提示增加文件名，便于区分正在处理的资源文件。
- 补充运行模式设置页汉化，包括审批与执行、运行模式、白名单和了解更多等文案。

## 1.0.1 - 2026-06-20

### 修复

- 补充 Agent 面板顶部 `New Agent` 的汉化。
- 补充聊天标签页更多菜单汉化，包括切换聊天面板、最大化聊天、关闭标签页、导出对话记录、复制请求 ID 和智能体设置等菜单项。
- 补充 Agent 搜索弹窗汉化，包括 `Search Agents...`、`No matching agents` 和 `Archived`。
- 补充输入框提示 `Plan, search, build anything` 及其悬浮提示汉化。

## 1.0.0 - 2026-06-20

首次正式发布 `cursor chinese`。

### 新增

- 提供 Cursor 编辑器本地一键汉化能力，覆盖设置、Agent、工具调用、套餐与用量、MCP、Hooks、权限、沙盒等常见英文界面。
- 支持一键恢复英文原版，恢复时优先使用首次运行生成的原始备份文件。
- 支持自动定位 Cursor 常见安装路径，也支持通过 `--cursor-path` 手动指定 `resources/app` 目录。
- 提供 Windows、macOS 和 Linux 的预编译成品：
  - `cursor-chinese-win-x64.exe`
  - `cursor-chinese-macos-arm64`
  - `cursor-chinese-macos-x64`
  - `cursor-chinese-linux-x64`
  - `cursor-chinese-linux-arm64`
- 新增 Linux 常见安装路径支持，覆盖 `/opt/Cursor`、`/usr/share/cursor`、`/usr/lib/cursor`、`~/.local/share/cursor` 等路径。

### 改进

- 将项目名称统一为 `cursor chinese`。
- 自动更新 `product.json` 中资源文件 checksum，减少 Cursor 提示安装损坏的概率。
- macOS 下自动清理隔离属性并尝试重新签名，降低系统安全机制拦截概率。
- README 已补充使用方式、工作逻辑、解决的问题、创建问题说明和兼容性说明。
- 协议更新为 MIT。

### 注意

- 本工具不是 Cursor 官方项目，只修改本机 Cursor 应用资源文件，不会上传账号、项目代码、编辑器配置或其他个人数据。
- Cursor 更新后官方资源文件可能被覆盖，需要重新运行本工具。
- Cursor 大版本调整界面结构后，可能出现新的未汉化文案，需要继续更新词库或替换规则。
