# 设计与实现

## 目录

- `plugins/long-conversation-canvas/src`：MCP 服务、React UI、SQLite 存储、原文来源、工程校验和复核派发。
- `plugins/long-conversation-canvas/skills`：随包技能及模型调用边界。
- `plugins/long-conversation-canvas/tests`、`test-*.mjs`：合成数据及隔离测试。
- `.agents/plugins/marketplace.json`：本地 marketplace 声明。
- `packaging`：安装脚本、候选检查和 ZIP 打包。

## 从源码构建

需要 Node.js 24+；打包工具使用 Python 3，插件运行不依赖 Python。

```powershell
cd plugins/long-conversation-canvas
npm ci
npm run check
npm run build
npm run test:store
npm run test:remote
npm run test:governance
npm run test:task-growth
```

测试生成的 `runtime/`、`evidence/` 和本地数据库不提交到仓库。隔离测试不证明实际 Codex UI 或真实模型长任务已经通过。

## 发布

现有发布载荷附带哈希清单。新的代码版本从仓库根目录执行：

```powershell
py packaging/prepare_release.py --version <新的数字版本>
py packaging/build_embed_bundle.py
```

先检查与构建、隔离 MCP 探针，最后更新插件版本清单。包保存在 `delivery/`。公开上传前检查没有本机用户路径、真实聊天来源、密钥或数据库。

## 核心约束

主对话唯一，主干版本带来源；子聊天持久且具有独立范围。成果必须明确纳入，上下文按预算选取。摘要不能无限连续套用。派发先保存记录，不确定结果先核查原请求，恢复不盲目重发。代码检查依据实际 Git 基线与文件内容，旧报告不能证明新代码通过。

插件通过宿主公开能力加载界面与聊天操作，不修改 Codex 安装文件。宿主升级后的兼容性应重新验收。第三方依赖许可见 `THIRD_PARTY_NOTICES.txt`。
