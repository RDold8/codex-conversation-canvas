# 安装与更新 / Installation

适用范围：Windows、Node.js 24+、具备本地插件和 MCP Apps 页面能力的 Codex Desktop，以及可从终端调用的 Codex CLI。其他平台尚未验收。

1. 从 GitHub Release 下载 `codex-long-tasks-embedded-0.6.33.zip`。
2. 完整解压到固定目录，在该目录打开 PowerShell。
3. 检查环境和包内哈希：

```powershell
powershell -NoProfile -File .\Install.ps1 -CheckOnly
```

4. 安装本地 marketplace 与插件：

```powershell
powershell -NoProfile -File .\Install.ps1
```

5. 正常重新打开 Codex。进入“插件”→“长任务”→“打开插件”；在“探索”中找到入口后按需固定到侧栏。入口名称和可见性受宿主版本影响。

安装脚本调用正常 Codex CLI 注册本地 marketplace，不修改 Codex 程序或侧栏缓存，不关闭当前窗口。安装后保留解压目录；本地 marketplace 引用它。

## 更新与恢复

更新使用同一个插件 ID 和 `conversation-canvas-local` marketplace。安装到新的固定目录后重新运行安装脚本并重开 Codex。若安装报错，先检查实际状态，避免重复操作：

```powershell
codex plugin list --marketplace conversation-canvas-local --json
```

数据保存于 Codex 用户目录的 `long-conversation-canvas/tasks.sqlite`，与插件安装载荷分开。更新前可以从画布“导出任务”保存可恢复文件；导出含个人聊天原文，请自行保存，不提交到公开仓库。

界面“恢复任务”支持任务 JSON 或 `.json.gz`，核对来源、引用和哈希，拒绝覆盖同一任务，不自动重发旧请求。

## 使用范围

本包配置启用真实聊天操作能力。默认仍由明确操作触发；提高授权档位后，符合规则的活动任务提案可以自动派发。先从人工复核开始，明确选定目标与工程范围。

Node、CLI、安装清单、新进程加载和实际界面显示是不同检查。`-CheckOnly` 成功只证明包内文件和本机依赖通过检查。

## English

Fully extract the ZIP into a permanent directory. With Node.js 24+ and the Codex CLI available, run the two PowerShell commands above, first with `-CheckOnly`, then without it. Reopen Codex normally and open “长任务” from Plugins. Pin it from Explore if available.

The installer registers a local marketplace using the normal CLI. Keep the extracted directory. Updates reuse the plugin ID and marketplace; data lives separately under the Codex user directory. If installation reports an error, inspect `codex plugin list` before retrying. Exports contain personal messages and must not be committed publicly.

The package enables chat operations. Manual controls and explicit authorization policies govern dispatch; higher policy levels can allow eligible automatic proposals. Start with human review. Package validation does not prove that your Codex version displays or has reloaded the plugin.
