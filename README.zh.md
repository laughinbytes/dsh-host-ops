**给 Agent 的 DSH 宿主侧工具** — 工作区、会话与配置操作；写入带预览、审批、审计与回滚。

用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

本文件是**面向开发者**的 README。用户在 DSH 内看到的插件页，是由官方 `meta.detail` 机制
读取 [`docs/detail.zh.md`](./docs/detail.zh.md)（英文为 [`docs/detail.md`](./docs/detail.md)）
生成的，两者读者和内容不同。

## 提供什么

三个宿主侧工具，把 DSH 自己的操作暴露给 Agent。所有调用都走 DSH 服务
（`workspaceRegistry` / `sessionController` / `sessionQuery` / `sessionTitle` / `agents` /
`configEditor` / `approval`），插件从不直接改 DSH 的文件。

| 工具 | 操作 |
| --- | --- |
| `dsh_workspace_manage` | `list`、`get`、`create`、`rename`、`reorder`、`remove`（remove 只取消登记，不删文件/会话/历史） |
| `dsh_session_manage` | `list`、`get`、`search`、`read`、`start`、`send`、`steer`、`queue`、`wait`、`notify`、`fork`、`attach`、`rename`、`reorder`、`sort`、`pin`、`unpin`、`archive`、`unarchive`、`cancel`、`model` |
| `dsh_config_manage` | `list`、`get`、`set`、`reset`、`revert`、`history`——当前 profile 里任意可编辑行（DSH 核心行与已安装插件行一样）的配置 |

### 投递语义

- `send`：交给下一轮（空闲目标立即开工，运行中的目标在当前 turn 之后收到，不打断）；
- `steer`：插进正在跑的 turn 的下一步；空闲目标会自动退回 `queue` 并说明；
- `queue`：只查看/编辑待处理消息，从不发送新内容；
- `send`/`steer`/`start`/`read`/`wait` 返回 `cursor`；把它作为 `after` 传给 `read`/`wait`
  可只读增量。`wait` 支持 `until: done | reply | step`，超时返回已收到内容 + `idleForMs`。

## 安装

```bash
# npm 发布后
dsh plugin --profile desktop add dsh-host-ops

# npm 发布前：直接从 GitHub 安装
dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"
```

`desktop` 是桌面端 profile（Web 版是 `web`）；也可以用 **Plugins → 添加插件**。
不要自己安装 `@deepseek-ai/*`：它们是 peerDependencies，由 DSH 安装区解析。

## 配置

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `approval` | `ask` | `ask` = 每次写配置都要审批；`never` = 配置只读 |
| `requirePreview` | `true` | 写入必须带预览凭证 |
| `strictErrors` | `false` | 所有降级路径直接抛错（开发/测试用） |

通过 Agent 修改（`dsh_config_manage`，带预览/审批/审计）。纯 Host 插件在 Plugins 页没有
可编辑表单，那一页只有组件的启用/停用开关。

## 写入治理

- **预览凭证**：写入必须带预览返回的 token；写入时用当前状态重算，期间被改动就拒绝（TOCTOU）；
- **审批**：`approval.request` 必须返回 `allowed-once`；没有审批通道时 fail-closed；
- **审计**：每次成功写入都记录（最多 100 条，内存）改前/改后的覆盖值；工具结果里附带收据
  （原始值 + 恢复步骤）；
- **回滚**：按 `auditId` 做冲突检测回滚；字段现状不一致时拒绝并列出冲突；
- **掩码**：敏感字段（key/token/secret/password/credential/env，含 `providers[].apiKey`
  这类嵌套键）在预览/收据/审批/审计里统一掩码；
- **启动必需行**（`agent-loop`、`webserver`、`connection`、`modules` 等）会给出警告与
  应急恢复步骤；
- 核心失败抛可行动错误；可选信息降级时明确告知；编程错误一律重新抛出
  （见 [错误处理纪律](./docs/error-handling.md)）。

## 兼容性与限制

DSH `>=0.2.1-rc.2` 或 `>=0.2.2-rc.1`（在 `0.2.2-rc.1` 验证）；Node `>=22.19.0`；仅在
macOS Desktop 实测，其他平台未验证。审计是内存环形（最近 100 条）。配置只支持改已存在行的
顶层字段。不能安装/启用插件、不能改 agent preset、不直接写 DSH 存储文件。

## 验证

```bash
node scripts/verify-dsh-host-ops.mjs         # 逻辑验证（假 DSH 服务），404 项
node scripts/verify-dsh-host-ops-schema.mjs  # schema 验证（真实 dsh-tools），64 项
```

在已安装的 profile 里让 Agent“列一下我的工作区”，工具正常返回即端到端冒烟通过。

## 卸载

在 **Plugins** 页禁用/移除 `dsh-host-ops`（或 `dsh plugin --profile desktop remove dsh-host-ops`）。
通过它做的配置改动会留在 profile patch 层，用 `dsh_config_manage` 的 `revert`/`reset` 撤销。
若改坏启动必需行导致 DSH 起不来：退出 DSH，把 `~/.dsh/profiles/<profile>/cordis.patch.yml`
改名成 `.bak-<时间>`，再启动；原始值在工具收据里。

## 开发

仓库结构、日常安装策略与发布扫描见 [`docs/development.md`](./docs/development.md)。

## 许可证

[MIT](./LICENSE) © 2026 laughinbytes。英文版：[README.md](./README.md)。
