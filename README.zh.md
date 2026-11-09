**给 Agent 的 DSH 宿主侧操作能力**：工作区、会话，以及带治理的配置变更。
纯工具，无界面、无 client 半边、不直接写文件。

> 非官方社区插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
> 与 DeepSeek 官方无隶属或背书关系。

[English](./README.md)

## 它是干什么的

Agent 能读文件、跑命令，但通常**不能操作 DSH 本身**：整理侧边栏、把活派给另一个会话再取回结果、
安全地改一项设置。这个插件把这三类能力做成宿主侧工具：

- **整理工作区/会话**：列出、新建、改名、排序、置顶、归档；
- **跨会话派活与取回**：start/send/steer/queue，然后 `wait` 等回复或等一步，用 `cursor`+
  `after` 只读增量；
- **配置写入治理**：预览 → 凭证 → 审批 → 写入 → 审计 → 回滚，fail-closed，绝不静默写。

所有操作都走 DSH 自己的宿主服务（`workspaceRegistry` / `sessionController` / `sessionQuery` /
`sessionTitle` / `agents` / `configEditor` / `approval`），不改 `workspace.json`、会话日志或 profile 补丁文件。

## 要求

- DSH：`>=0.2.1-rc.2` 或 `>=0.2.2-rc.1`（在 `0.2.2-rc.1` 上验证）
- Node：`>=22.19.0`
- 纯 Host 半边；官方 `@deepseek-ai/*` peer 由 DSH 安装区解析，不要自己装

## 安装

在 Plugins 页（或你的部署的 bundle 安装器）里安装包名：

```text
dsh-host-ops
```

## 三个工具

| 工具 | 能力 |
| --- | --- |
| `dsh_workspace_manage` | list/get/create/rename/reorder/remove（remove 只取消登记，不删文件/会话/历史） |
| `dsh_session_manage` | list/get/search/read/start/send/steer/queue/wait/notify/fork/attach/rename/reorder/sort/pin/unpin/archive/unarchive/cancel/model |
| `dsh_config_manage` | list/get/set/reset/revert/history（两步写入 + 审批 + 审计 + 冲突检测） |

**cursor**：`send`/`steer`/`start`/`read`/`wait` 都返回事件序号；把它作为 `after` 传给 `read`/`wait`，
只看那次之后的新内容。**wait** 支持 `until: done|reply|step`，超时不报错，返回已收到内容 + `idleMs`。

**send vs steer vs queue**：`send` 交给下一轮（空闲立即开工，运行中排当前 turn 之后）；`steer`
插进正在跑的 turn 的下一步（空闲目标自动退回 queue 并说明）；`queue` 只查看/编辑待处理消息，从不发送。

**配置写入链**：预览（逐字段 diff + 后果 + previewToken）→ 凭证校验（防"看到 A 写成 B"）→
审批（只有 allowed-once 继续；没有审批通道就拒绝）→ 官方 `configEditor.edit()` → 审计 + 收据
（原始值、恢复命令、敏感字段掩码）。

启动必需行（`webserver`/`connection`/`modules` 等）会强提示"改坏可能让 DSH 起不来"，并附应急恢复步骤。

## 快速示例

```text
"把未分组的会话按目录归到对应工作区"
"去 session-xxx 让它跑一遍插件测试，跑完把结果摘要给我"
"把 session-query-sqlite 的 openAt 改成 never，先给我看预览" → 确认 → apply
"撤销你刚才那次配置改动"
```

## 配置项

```yaml
- id: host-ops
  name: dsh-host-ops
  config:
    strictErrors: false   # true = 所有降级路径直接抛错（开发/测试用）
    approval: ask         # ask = 每次写入要审批 | never = 只读
    requirePreview: true  # apply 必须带预览凭证
```

headless/无人值守部署若没有审批回答者，配置写入会 fail-closed 被拒绝，只读与预览可用。

## 安全模型

- 纯 Host 半边，无 UI；
- 不直接写文件；配置写入走官方通道（校验、文件锁、原子替换）；
- 写入前必须预览 + 审批，失败即拒绝；
- 可选信息（标题/摘要/界面刷新帧）降级时在输出里写明；核心失败抛出可行动错误；
  编程错误（TypeError/RangeError/ReferenceError）一律重新抛出；
- 预览/收据/审批/审计里敏感字段掩码（含 `providers[].apiKey` 这类嵌套字段）。

## 已知限制

- 审计是内存环形（最近 100 条），插件重载/App 重启后清空；收据是恢复兜底；
- 只支持改已存在行的顶层字段；不支持新增行/嵌套字段；
- DSH 是开发者预览版，API 变化可能导致需要更新插件。

## 卸载与回滚

1. 在 Plugins 页禁用/移除 `dsh-host-ops` bundle；插件不创建任何文件、不残留状态。
2. 用 `dsh_config_manage` 的 `revert`/`reset` 撤销配置改动，或在设置界面删掉该行覆盖。
3. 若改坏启动必需行导致 DSH 起不来：退出 DSH，把 `~/.dsh/profiles/<profile>/cordis.patch.yml`
   改名成 `.bak-<时间>`，再启动（Desktop 也有原生致命恢复）。原始值在工具收据里。

## 开发

```bash
node scripts/verify-dsh-host-ops.mjs         # 逻辑验证（假 DSH 服务），404 项
node scripts/verify-dsh-host-ops-schema.mjs  # 真实 dsh-tools 编译验证，64 项
```

## 许可证

[MIT](./LICENSE) © 2026 laughinbytes
