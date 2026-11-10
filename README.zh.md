**让 Agent 真正操作 DSH 本身**：整理工作区、跨会话派活取结果、带预览/审批/回滚地改配置。

> 非官方社区插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
> 与 DeepSeek 官方无隶属或背书关系。

Agent 已经能读文件、跑命令。这个插件补上缺的那一层：让它能在 **DSH 内部**工作——
操作工作区、会话和配置，这些本来只有人在界面上能做；同时把写入做成安全的
（预览 → 审批 → 写入 → 审计 → 回滚），不会绕过 DSH 自己改东西。

## 可以直接这样说

- “把未分组的会话按目录归到对应工作区里。”
- “去 session-xxx 让它跑一遍插件测试，跑完把结果摘要给我。”
- “把 session-query-sqlite 的 openAt 改成 never，先给我看预览。”

## 三个工具

| 工具 | Agent 能做什么 |
| --- | --- |
| `dsh_workspace_manage` | 侧边栏工作区组：列出、新建、改名、排序、移除（移除只取消登记，不删文件/会话/历史） |
| `dsh_session_manage` | 会话：列出/搜索/读取、新建、send/steer/queue、等待回复或步骤、提醒、fork、attach、改名、排序、置顶、归档、取消；cursor 增量读 |
| `dsh_config_manage` | 当前 profile 里任意可编辑行的配置（DSH 核心行与已安装插件行一样）：预览、审批、审计、回滚、冲突检测 |

所有操作都走 DSH 自己的宿主服务（`workspaceRegistry` / `sessionController` / `sessionQuery` /
`sessionTitle` / `agents` / `configEditor` / `approval`）。

## 安装

```bash
# npm 发布后
dsh plugin --profile desktop add dsh-host-ops

# npm 发布前：直接从 GitHub 安装
dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"
```

`desktop` 是桌面端 profile（Web 版是 `web`）；也可以用 **Plugins → 添加插件**。
官方 `@deepseek-ai/*` peer 依赖由 DSH 安装区解析，不要自己装。

## 配置

三个选项，设一次即可：

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `approval` | `ask` | 每次写配置都要审批；`never` 表示配置只读 |
| `requirePreview` | `true` | 写入必须带预览凭证 |
| `strictErrors` | `false` | 所有降级路径直接抛错（开发/测试用） |

**改法：直接让 Agent 改**（走 `dsh_config_manage`，带预览/审批/审计）。Plugins 页保留
常规的启用/停用开关，没有单独的设置表单。

## 安全

- 配置写入 fail-closed：必须有预览凭证 + 审批；没有审批通道就拒绝写入；
- 敏感值（key/token/secret、`providers[].apiKey` 这类嵌套字段）在预览/收据/审批/审计里掩码；
- 改启动必需行会给出警告与应急恢复步骤；
- 核心失败抛出可行动错误；可选信息降级时明确告知；编程错误绝不吞掉；
- 插件不创建文件、不存储凭据。

## 要求与限制

DSH `>=0.2.1-rc.2` 或 `>=0.2.2-rc.1`（在 `0.2.2-rc.1` 验证）；Node `>=22.19.0`；仅在
macOS Desktop 实测，其他平台未验证。审计是内存环形（最近 100 条），收据是恢复兜底；
只支持改已存在行的顶层字段；不能安装/启用插件、不能改 agent preset；会话与工作区操作都走 DSH 自己的服务，不直接改 DSH 的存储文件。

## 验证

安装后让 Agent“列一下我的工作区”，三个工具应能正常返回。在仓库里也可以运行两套测试
（见文档）。

## 卸载

在 **Plugins** 页禁用/移除 `dsh-host-ops`（或 `dsh plugin --profile desktop remove dsh-host-ops`）。
通过它做的配置改动会留在 profile patch 层，用 `dsh_config_manage` 的 `revert`/`reset` 撤销。
若改坏启动必需行导致 DSH 起不来：退出 DSH，把 `~/.dsh/profiles/<profile>/cordis.patch.yml`
改名成 `.bak-<时间>`，再启动；原始值在工具收据里。

## 文档

- [配置治理](./docs/config-governance.md) — 预览、审批、审计、回滚
- [错误处理纪律](./docs/error-handling.md) — fail-fast 与可见降级
- [开发与发布](./docs/development.md) — 测试、仓库结构、日常安装策略

## 许可证

[MIT](./LICENSE) © 2026 laughinbytes。英文版：[README.md](./README.md)。
