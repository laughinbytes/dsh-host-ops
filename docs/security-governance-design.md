# dsh-agent-console 安全治理层设计（config 写面）

> 目标：把「模型可编辑 DSH profile 配置」从**单次无审批写入**（当前审计 B7 最高风险）升级为**治理式写面**：
> **预览 → 审批 → 应用 → 可回滚 → 有审计**，失败关闭。
> 依据：官方 `dsh-tools` 管线与 `dsh-user-approval` 服务源码（0.2.2-rc.1，`reference/tmp/dsh-host-ops-schema/node_modules/...` 只读核对）。

## 1. 官方原语（已核实）

| 原语 | 事实（源码位置） |
|---|---|
| `tools/pre-execute` waterfall | 工具调用前的可重排 allow/deny/ask 门；返回 `{kind:'allow'|'deny'|'ask'|'cancel'}`（`dsh-tools/lib/types/index.js:885`） |
| `approval.request(...)` | `ctx.get('approval')`；入参 `{agent, toolName, callId, reason?, displayReason?, signal}`；返回 `allowed-once | rejected | cancelled | unavailable`（`dsh-tools/lib/types/index.js:1102-1139`） |
| ask → 审批的桥接 | 管线把 `ask` 交给 `serviceAsk`：无 approval 服务 → **deny**；无 agent → deny；`unavailable` → deny。**原生失败关闭** |
| `configEditor.edit(entry, () => next)` | 校验完整候选 → profile 文件锁 → 原子替换 → 只重组该行；失败恢复原文件（`dsh-config-editor`，本插件已用） |
| `configEditor.configuration()` | 返回 `[{entry, inherited, override}]`，可读当前覆盖值——**可作为"回滚基线"与"diff 来源"，无需直接文件 I/O** |

结论：**审批门不需要新协议**——用 `approval.request` 即可；**回滚不需要直接写文件**——用 `edit()` 把覆盖值改回基线。

## 2. 设计

### 2.1 新增/改造的 config 动作

| 动作 | 行为 | 写？ | 审批 | 备注 |
|---|---|---|---|---|
| `list` / `get` | 现有：列行/读行 | 否 | 无 | 不变 |
| **`preview`** | 计算 `next` 覆盖值 → 生成：① 用户面摘要（改什么/影响/是否重启/能否回滚，复用现有 `userFacingSummary`）② **逐字段 diff**（current override vs next）③ `previewToken`（对 `{entryId, currentOverride, next}` 的哈希）④ 回滚基线快照 | 否 | 无 | 不落盘；token 用于 apply 校验 |
| **`apply`** | 校验 `previewToken` 与当前 profile 状态一致（防 TOCTOU）→ **`approval.request` 必须 `allowed-once`** → `editor.edit(entry, () => next)` → 记录审计（含 before/after、operator=模型、callId）→ 返回与 `preview` 一致的摘要 + 结果 | **是** | **必须** | 默认要求先 preview；config 可放宽 |
| **`revert`** | 按审计 id 或"最近一次 apply"取回 before 基线 → 只回滚 `apply` 改过的字段（不覆盖用户在此期间的其它修改：先 diff 检测冲突，冲突则拒绝并提示）→ 审批 → `edit()` 回写 | **是** | **必须** | 冲突检测是安全关键 |
| **`history`** | 列最近 N 次 apply/revert 审计（时间、entry、字段、before→after、callId、结果） | 否 | 无 | 数据来自审计存储 |

> 兼容：现有 `apply`（两段式提示词约定）**保留语义但强制升级**——`apply:true` 若没有有效 `previewToken` → 返回 `PREVIEW_REQUIRED`（模型必须先 preview）。配置项 `requirePreview: true`（默认）/`false` 可放宽（不建议）。

### 2.2 审批门实现（不使用 pre-execute，直接在动作内调用）

理由：`approval.request` 需要 agent/callId/signal，工具 `execute(args, exec)` 里都有；直接调用比注册 waterfall 更简单、行为等价，且失败关闭由服务保证。

```js
async function requireApproval(ctx, exec, reason, displayReason) {
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('配置写入需要审批通道，但本部署没有 approval 服务；已拒绝（fail closed）')
  }
  const outcome = await approval.request({
    agent: exec.agent, toolName: 'dsh_config_manage', callId: exec.callId,
    reason, displayReason, signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`配置写入未获批准（${outcome}）；未做任何修改`)
  }
}
```

- 配置项：`approval: 'ask' | 'never'`（默认 `ask`）——`never` 时所有写动作直接拒绝（headless/CI 场景的安全底线）。
- 写动作清单：`apply`、`revert`（未来新增写动作必须登记，单测覆盖"每个写动作都过审批"）。

### 2.3 审计存储

- 优先 `ctx.storageDomain`（官方持久化 seam；tool-discovery 已确认其在 0.2.2-rc.1 可用）：`<domain>/config-audit.json` 追加式记录。
- 不可用时降级为内存环（最近 50 条），并在结果里标注 `auditPersistent: false`（不静默丢）。
- 审计字段：`{at, action, entryId, fields: [{key, before, after}], previewToken, callId, sessionId, outcome: 'applied'|'rejected'|'reverted'|'conflict'|'failed'}`。
- **不记录配置值以外的内容**（不落凭据；MCP env 等敏感行只在字段名层面记录，值做 mask）。

### 2.4 安全边界（写进 README）

- 不改 `profile.bundles`（不装/卸插件）——那是 `plugin_manager` 的职责；
- 不编辑 `home` 层 patch（只编辑 profile 用户层），不提供"任意路径写入"；
- 审批失败/预览过期/冲突 → 一律拒绝，**不做"尽力而为"的写入**；
- 每次 apply 的输出带 `rollback: {auditId}`，models/humans 都能据此 revert。

## 3. 与竞品优点的关系

- 竞品 `dsh-session-tools`（SisyphusSQ）的 6 个 per-action 审批开关 → 我们采用 **config `approval` + 写动作登记 + 单测**，并且对 **config 写**强制审批（比 session 写更高风险面）。
- 竞品 `dsh-session-groups` 的 `approval.request` 用法 → 同源，我们按官方 `serviceAsk` 语义对齐（allowed-once / rejected / cancelled / unavailable 四态）。
- 竞品缺的（审计/回滚/冲突检测）→ 我们补上，作为"唯一可治理的配置编辑"主张的证据。

## 4. 测试与证据（发布时必须）

1. 单测：每个写动作在 approval 缺失/拒绝/取消/unavailable 时不写（用 fake ctx + fake editor 断言 `edit` 未被调用）；
2. 单测：previewToken 过期（profile 被外部修改）→ apply 拒绝；
3. 单测：revert 冲突检测 → 拒绝并给出冲突字段；
4. e2e 证据：干净 profile 上 apply→revert 往返，`--dump-config` 前后一致；
5. README「Permissions and data」逐条声明本设计。

## 5. 工作量

| 工作 | 估时 |
|---|---|
| approval 门 + 写动作登记 + 配置项 | 2–3 h |
| preview/diff/previewToken + 与现有摘要合并 | 3–4 h |
| 审计存储（storageDomain + 降级） | 2–3 h |
| revert + 冲突检测 | 3–4 h |
| 单测 4 组 + e2e 证据 | 3–4 h |
| **合计** | **13–18 h** |

（3 个已知 bug 修复另计 ≈3–4 h；改名/元数据/英文 README/CI 另计。）
