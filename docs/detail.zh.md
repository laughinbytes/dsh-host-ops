**让 Agent 真正操作 DSH 本身**：整理工作区、跨会话派活取结果、带预览/审批/回滚地改配置。

Agent 已经能读文件、跑命令。这个插件补上缺的那一层：让它能在 **DSH 内部**工作——操作
工作区、会话和配置，这些本来只有人在界面上能做；同时把写入做成安全的。

## 可以直接这样说

- “把未分组的会话按目录归到对应工作区里。”
- “去 session-xxx 让它跑一遍插件测试，跑完把结果摘要给我。”
- “把 session-query-sqlite 的 openAt 改成 never，先给我看预览。”

## Agent 获得的能力

- **工作区操作**：列出、新建、改名、排序、置顶、归档侧边栏工作区组；
- **会话操作**：新建、send/steer/queue、等待回复或步骤、cursor 增量读、fork、attach、
  改名、归档、取消；
- **配置治理**：修改当前 profile 里任意可编辑行的配置（DSH 核心行与已安装插件行一样）：
  预览 → 审批 → 写入 → 审计 → 回滚，带回冲突检测。

## 安装

```bash
dsh plugin --profile desktop add dsh-host-ops
```

npm 发布前：`dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"`；
也可以用 **Plugins → 添加插件**。

## 设置

三个"设一次就不动"的选项（`approval`、`requirePreview`、`strictErrors`）通过让 Agent 改
（走 `dsh_config_manage`，带预览/审批/审计）。Plugins 页保留常规的启用/停用开关，没有单独的
设置表单。

## 安全

- 配置写入 fail-closed：必须有预览凭证 + 审批；
- 敏感值在预览/收据/审批/审计里掩码；
- 改启动必需行会给出警告与应急恢复步骤；
- 核心失败抛出可行动错误；可选信息降级时明确告知。

## 兼容性

DSH `>=0.2.1-rc.2` 或 `>=0.2.2-rc.1`（在 `0.2.2-rc.1` 验证）；Node `>=22.19.0`；
仅在 macOS Desktop 实测。完整文档（配置治理、错误处理纪律）见
<https://github.com/laughinbytes/dsh-host-ops#readme>。
