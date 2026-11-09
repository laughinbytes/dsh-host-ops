# 错误处理纪律（dsh-agent-console）

> 原则：**核心功能 fail-fast；附加信息允许降级，但必须"可见 + 可观测 + 可测试 + 不吞编程错误"。**
> 这份纪律适用于本插件全部代码；新增 catch 前先对照本文件。

## 1. 三类错误，三种处置

| 类型 | 例子 | 处置 |
|---|---|---|
| **核心功能失败** | 读不到会话/事件、投递消息失败、写配置失败、归档/取消失败、权限或授权失败 | **抛出可行动错误**（fail-fast / fail-closed），绝不降级 |
| **附加信息失败** | 取标题、取摘要、Workspace 摘要里的标题、补帧所需的行快照 | **降级 + 在输出里写明 + 记 warn**（graceful degradation） |
| **纯副作用失败** | announce 补帧（UI 刷新提醒） | **不阻塞主操作**；warn + 在工具文本尾部告知"界面可能没刷新" |

## 2. 四条硬性规则

1. **写操作与授权路径禁止降级**：任何改变状态、授权、数据一致性的失败都必须抛出。
2. **降级必须可见**：不能只警告到日志（运行期日志默认不落盘）；必须在工具输出里出现一句说明（例：`⚠️ 部分标题读取失败（列表仍可用，刷新可重试）`、`⚠️ 界面行可能未刷新（刷新页面可恢复）`）。
3. **编程错误必须重新抛出**：`TypeError / RangeError / ReferenceError` 永远 rethrow（`rethrowIfProgrammerError`），兜底只允许接住环境/依赖失败，防止掩盖我们自己的 bug。
4. **降级必须有测试**：测试要断言"主操作仍成功 + 预期 warn + 输出里的提示"；`strictErrors: true` 模式下所有降级直接抛错，用于测试/开发把静默路径逼出来。

## 3. 统一入口

- `degradeOrRethrow(error, strict)`：catch 块第一行调用；编程错误或 strict 模式 → 抛出。
- `rethrowIfProgrammerError(error)`：只做编程错误判定（用于还要转换错误信息的 catch）。
- `strictOf(ctx)`：helper 函数读取 strict 标记。
- Workbench 实例：`this.strictErrors`、`this.announceFailures`、`this.summaryTitleFailure`。

## 4. 现有 catch 分类表（2026-11-09 审计）

| # | 位置 | 类型 | 处置 |
|---|---|---|---|
| 1 | `announce` 播报失败 | 纯副作用 | 降级 + `announceFailures` → 工具文本提示 |
| 2 | `summaryFor` 公开 `controller.list` 失败 | 附加信息 | 降级到私有路径 + warn |
| 3 | `summaryFor` 私有 `summaryFor/summarizeCold` 失败 | 附加信息 | 降级 + warn（不发幽灵帧） |
| 4 | `collect` 标题批量读失败 | 附加信息 | 降级 + `fetchError` → 列表输出提示 |
| 5 | `summarizeWorkspaces` 摘要标题失败 | 附加信息 | 降级 + `summaryTitleFailure` → 摘要输出提示 |
| 6 | `titleProjectionFor` 读标题快照失败 | 附加信息 | 降级（undefined） |
| 7 | `logEndSeq` 读日志末尾失败 | 附加信息 | 降级（cursor 未知） |
| 8 | `readCurrentPreset` projection/冷读失败 | 附加信息 | 降级（回落 header 并标注来源） |
| 9 | start 后写标题/登记工作区失败 | 附加信息 | 降级 + notes 文本说明（可见） |
| 10 | fork 后登记工作区失败 | 附加信息 | 降级 + 文本"未分组"（可见） |
| 11 | 配置工具查活动会话数失败 | 附加信息 | 降级 + 输出"查不到"（可见） |
| — | resume/投递/归档/取消/写配置 | 核心 | 抛出可行动错误（fail-fast） |

## 5. 配置

```yaml
- id: workbench
  name: 'dsh-host-ops'
  config:
    strictErrors: false   # 默认 false；测试/开发可开 true：任何降级直接抛错
```

## 6. 测试证据

- 逻辑测试：379/379（含 6 组故障注入 × 12+ 断言、编程错误重抛、strict 模式）；
- schema 测试：64/64；
- 真机：正常路径 + 上一批 read/wait/cursor 验证。
