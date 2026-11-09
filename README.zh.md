**给 Agent 的 DSH 宿主侧操作能力**：工作区、会话，以及带治理的配置变更。
纯工具，无产品界面、无 client 半边、不直接写文件。

> 非官方社区插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
> 与 DeepSeek 官方无隶属或背书关系。

## 能力

Agent 能读文件、跑命令，但通常不能操作 DSH 本身。这个插件把三类能力做成宿主侧工具：

- **整理工作区/会话**：列出、新建、改名、排序、置顶、归档；
- **跨会话派活与取回**：start/send/steer/queue，用 `wait` 等回复或等一步，用 `cursor`+`after` 只读增量；
- **配置写入治理**：预览 → 审批 → 写入 → 审计 → 回滚，fail-closed，绝不静默写。

所有操作都走 DSH 自己的宿主服务（`workspaceRegistry` / `sessionController` / `sessionQuery` /
`sessionTitle` / `agents` / `configEditor` / `approval`）。

## 工具

| 工具 | 能力 |
| --- | --- |
| `dsh_workspace_manage` | 工作区组：list/get/create/rename/reorder/remove（remove 只取消登记，不删文件/会话/历史） |
| `dsh_session_manage` | 会话：list/get/search/read、start/send/steer/queue、wait/notify、fork/attach/rename/reorder/sort/pin/archive/cancel、cursor 增量读 |
| `dsh_config_manage` | DSH 配置：list/get/set/reset/revert/history；两步写入（预览凭证 + 审批 + 审计 + 冲突检测回滚） |

## 安装

```bash
# npm 发布后
dsh plugin --profile desktop add dsh-host-ops

# npm 发布前：直接从 GitHub 安装
dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"
```

也可以用 Plugins 页的「添加插件」。（`desktop` 是桌面端 profile，Web 版是 `web`。）

## 配置

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `approval` | `ask` | `ask` = 每次写配置都要审批；`never` = 配置只读 |
| `requirePreview` | `true` | 写入必须带预览凭证 |
| `strictErrors` | `false` | 所有降级路径直接抛错（开发/测试用） |

改法：直接让 Agent 改（走 `dsh_config_manage`，带预览/审批/审计）。纯 Host 插件**在 Plugins 页没有可编辑表单**——
那一页只有组件的启用/停用开关；要做可编辑表单需要 client 配置页，本插件有意不做。

## 安全模型

纯 Host 半边；不直接写文件，配置写入走官方通道（校验、文件锁、原子替换）；写入必须
预览 + 审批（没有审批通道即拒绝）；可选信息降级时在输出里写明，核心失败抛可行动错误；
预览/收据/审批/审计里敏感字段掩码（含 `providers[].apiKey`）。

## 要求与限制

DSH `>=0.2.1-rc.2` 或 `>=0.2.2-rc.1`（在 `0.2.2-rc.1` 验证）；Node `>=22.19.0`。
审计是内存环形（最近 100 条），收据是恢复兜底；只支持改已存在行的顶层字段；
**故意不做自定义设置页**（见下方设计说明）。

## 卸载

在 Plugins 页禁用/移除 `dsh-host-ops`（或 `dsh plugin --profile desktop remove dsh-host-ops`）。
插件不创建文件、不残留状态。配置改动在 profile patch 层，用 `dsh_config_manage` 的
`revert`/`reset` 撤销。若改坏启动必需行导致 DSH 起不来：退出 DSH，把
`~/.dsh/profiles/<profile>/cordis.patch.yml` 改名成 `.bak-<时间>`，再启动。

## 开发

```bash
node scripts/verify-dsh-host-ops.mjs         # 逻辑验证（假 DSH 服务）
node scripts/verify-dsh-host-ops-schema.mjs  # schema 验证（真实 dsh-tools）
```

设计说明在 `docs/`。插件**故意保持纯 Host**：三个"设一次就不动"的选项通过模型工具修改即可；
再加 client 自定义设置页只会带来前端构建和首次安装重启的成本。

## 许可证

[MIT](./LICENSE) © 2026 laughinbytes。英文版：[README.md](./README.md)。
