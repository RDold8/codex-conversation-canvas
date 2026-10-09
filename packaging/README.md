# Codex 长对话画布 0.6.33

这是 Codex 内嵌插件的实验预览安装包。运行需要 Node.js 24+、Codex Desktop 与 Codex CLI，不需要 Python 或独立应用。

完整解压到固定目录后，先运行：

```powershell
powershell -NoProfile -File .\Install.ps1 -CheckOnly
powershell -NoProfile -File .\Install.ps1
```

正常重开 Codex，从“插件”打开“长任务”，在“探索”中按需固定侧栏入口。保留解压目录；安装器注册正常本地 marketplace，不修改客户端缓存，不关闭窗口。

安装报错先检查 `codex plugin list --marketplace conversation-canvas-local --json`，不要盲目重跑。聊天数据与插件分开保存于 Codex 用户目录 `long-conversation-canvas/tasks.sqlite`。本包不含聊天记录。

本包启用真实聊天操作，默认人工操作触发；提高授权档位后，符合规则的活动任务提案可能自动派发。先核对目标、授权与代码范围。0.6.33 新授权/自动派发的完整原生长任务验收尚未完成。

项目与完整说明：https://github.com/RDold8/codex-conversation-canvas

English: Extract fully into a permanent directory, run the commands above, reopen Codex, and open “长任务” from Plugins. Node.js 24+ and Codex CLI are required. Keep the directory. Chat operations are enabled but governed by explicit actions and authorization policies. New 0.6.33 dispatch features still need full native long-task validation. See THIRD_PARTY_NOTICES.txt for dependency notices.
