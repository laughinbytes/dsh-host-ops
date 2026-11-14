/**
 * dsh-host-ops —— 让 Agent 直接管理工作区（Workspace）与会话（Session）。
 *
 * 它只注册 Agent 可见的 Host 工具，**不碰任何磁盘上的 JSON**：
 * 所有写操作都走运行中 DSH 自己的服务，因此运行中的 App 立即知情，
 * 不会被内存状态覆盖。
 *
 * 事实来源（写代码前逐条核对过，不是凭记忆）：
 *   - `@deepseek-ai/dsh-workspace` README + `lib/index.js`
 *     服务名 `workspaceRegistry`；`WorkspaceRegistry.create/get/list/delete/
 *     insertBefore/pinSession/unpinSession/archiveSession/unarchiveSession/
 *     archivedSessionIds/pinnedSessionIds/resolveByPath`；
 *     实体 `WorkspaceEntity`：`path/title/createdAt/updatedAt/sessionIds/
 *     setTitle/attachSession/insertSessionBefore/detachSession/status`。
 *   - `@deepseek-ai/dsh-session-query` README + `lib/index.js`
 *     服务名 `sessionQuery`；`listSessions()` 返回
 *     `{ header: { id, createdAt, cwd?, parentSession?, origin?, isSeeded, … }, live, persisted }`，
 *     按“最新在前”排序；`readTitleSnapshots(ids)` 返回与入参等长的
 *     `PromiseSettledResult` 数组，兑现值 `{ session, title? }`。
 *   - `@deepseek-ai/dsh-session-title` README + `lib/index.js`
 *     服务名 `sessionTitle`；`rename(session, title)` 要求 session 是
 *     **本 store 内活着的那个实例**（`ctx.sessions.get(id) === session`），
 *     返回 `{ title, eventSeq, source, … }`。
 *   - `@deepseek-ai/dsh-session` README + `lib/types/index.js`
 *     服务名 `sessions`；`create(id, { meta: { cwd } })` 建一个**已发布但未物化**
 *     的活会话（无 turn、无 agent），`.js` 里 `meta.cwd` 直接进 header。
 *   - `@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop`
 *     服务名 `agents`；`resume({ resumeSessionId, agentOptions?, setup? })` 返回 handle
 *     （`agent` / `signal` / `publish` / `dispose`）。`handle.dispose()` 会 abort 生命周期、
 *     cancel + dispose machine scope、`handle.close()` 关持久化句柄，最后 `detachAgent()` +
 *     `detachSession()`——会话真正回到“未加载”。
 *   - `@deepseek-ai/dsh-session`
 *     服务名 `sessions`；`flush(session)` 等持久化回调结算，`create(id, { meta })` 发布未物化会话。
 *     `@deepseek-ai/dsh-acp` 的宿主 teardown 就是 `flush(session)` → `handle.dispose()` 这个顺序。
 *
 * `resume: true` 的实现就是这三条的组合：**临时** resume 一个 agent 作载体 → 改名 → flush → dispose。
 * 刻意不挂 preset 组合（`agentPresets.mount`），也不走 `sessionController.rename()`
 * （后者会把 handle 丢掉，会话常驻到 App 退出）。
 *
 * 刻意不用 `ctx.agents.create()`：那会真的拉起一个 agent loop，
 * “新建会话”只需要一条会话记录。
 *
 * @module dsh-host-ops
 */

import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis 插件名。 */
export const name = 'dsh-host-ops'

/**
 * 依赖的服务：工具注册表、工作区注册表、会话查询。
 * 在 desktop profile 里三者都由 dsh-base / dsh-web-app 挂载。
 * `sessionTitle` / `sessions` / `agents` / `workspaceController`
 * 只在需要时用 `ctx.get()` 取，这样某个部署少了它们也只是对应 action 报错，
 * 而不是整个插件挂不上。
 */
export const inject = ['tools', 'workspaceRegistry', 'sessionQuery']

/* ======================================================================== *
 * 运行期配置
 * ======================================================================== */

/**
 * 运行期配置。当前为空对象：2026-11-02 移除了合并进来的 session-router / 决策模型
 * （`session_router` 工具、`config.router` 的 21 个字段、Jev/OpenRouter 通道）——
 * agent 本身具备决策能力，`start` 要求显式 `workspaceId` / `cwd`，工具不再替它猜位置。
 * 保留空的 `Config` 是因为 bundle 行仍然按 schema 解析 config。
 */
export const Config = z.object({
  approval: z.union([z.const('ask'), z.const('never')]).default('ask')
    .description('Config-write approval policy: `ask` requests approval before every write; `never` makes config writes read-only. Writes fail closed when no approval channel is available.'),
  requirePreview: z.boolean().default(true)
    .description('Require the preview token before a config write is applied (recommended; prevents applying a value different from the previewed one).'),
  strictErrors: z.boolean().default(false)
    .description('Throw on every degradation path instead of degrading gracefully (development and testing only).'),
})

/** ID 列表里默认展示的字符数。 */
const ID_PREVIEW = 14

/**
 * `list` 的默认返回行数。
 *
 * 为什么必须有默认上限：本机有 520 条会话，`action: 'list'` 过去不带 `limit` 时会
 * 把全部会话都铺出来——模型看两行就迷失，还白烧上下文。50 行足够覆盖"最近/一个
 * 工作区"的常见用法；要更多就显式传 `limit`。
 */
const DEFAULT_LIST_LIMIT = 50

/** 不带 `workspaceId` 的 `list` 摘要里，默认最多列多少个工作区。 */
const DEFAULT_SUMMARY_WORKSPACES = 30

/** 摘要里最多列多少个工作区（防止 `limit` 被传得过大）。 */
const MAX_SUMMARY_WORKSPACES = 100

/** 摘要行里工作区标题 / 最近会话标题的展示上限。 */
const SUMMARY_TITLE_PREVIEW = 40

/**
 * 按工作区分组的摘要末尾的引导语。
 *
 * 这句话是这次修复的**核心产物**：模型拿到全量会话列表时不知道自己缺一个
 * `workspaceId`，于是一直在 bash 里翻 `~/.dsh/storages`。摘要必须把下一步
 * 动作直接写出来（`dsh-tool-discovery` 的 `dsh-host-ops` 组描述里也同步这句）。
 */
const LIST_SCOPE_HINT = '要列某个工作区的会话，传 workspaceId（可用 dsh_workspace_manage list 获取）或 cwd。'

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 把会话 id 截短，方便在列表里读。
 * @param id - 会话 id。
 * @param full - 为 true 时原样返回。
 * @returns 展示用短 id。
 */
function shortId(id, full) {
  if (full === true) return id
  return id.length > ID_PREVIEW + 2 ? `${id.slice(0, ID_PREVIEW)}…` : id
}

/**
 * 单行文本截断（摘要里用；标题可能很长，一行一条才叫"紧凑"）。
 * @param text - 原始文本。
 * @param max - 最多保留的字符数。
 * @returns 截断后的单行文本。
 */
function truncateInline(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * 毫秒时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。
 * @param ms - 毫秒时间戳。
 * @returns 本地时间字符串；非法输入返回 `'?'`。
 */
function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '?'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 从 `readTitleSnapshots()` 的 `title` 字段里取出**标题文本**。
 *
 * 真实服务返回的不是字符串：`sessionQuery.readTitleSnapshots()` 兑现
 * `{ session, title? }`，其中 `title = foldSessionTitle(events)`，也就是
 * `@deepseek-ai/dsh-session-title` 里 `titleSnapshotFromState()` 冻住的快照对象
 * `{ title, messageSeqs, source, eventSeq, updatedAt }`——标题文本在 `.title` 上。
 * 直接把它当字符串用会渲染成 `[object Object]`，`sort by title` 也会按同一个
 * 常量字符串比较。
 *
 * 同时接受字符串：万一上游改回字符串，不需要再改这里。
 *
 * @param value - 快照对象、字符串，或 undefined。
 * @returns 标题文本；取不到（或空串）返回 `undefined`。
 */
function titleTextOf(value) {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (value !== null && typeof value === 'object' && typeof value.title === 'string') {
    return value.title === '' ? undefined : value.title
  }
  return undefined
}

/**
 * `YYYY-MM-DD HH:mm` → 毫秒时间戳。
 * @param text - 用户/模型给的时间文本。
 * @returns 毫秒时间戳；解析不了时返回 `undefined`。
 */
function parseTime(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const normalized = text.trim().replace(' ', 'T')
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00` : normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 报错信息抽成一行，便于放进工具错误。
 * @param error - 任意抛出物。
 * @returns 单行消息。
 */
function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 编程错误（TypeError / RangeError / ReferenceError）永远重新抛出：
 * 兜底只允许接住"环境/依赖失败"，不能接住我们自己的 bug（否则就是掩盖问题）。
 * @param error - catch 到的错误。
 */
function rethrowIfProgrammerError(error) {
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error
}

/**
 * 降级策略（唯一入口）：编程错误 → 抛出；`strictErrors` 模式 → 抛出；否则允许调用方降级并告知用户。
 * @param error - catch 到的错误。
 * @param strict - 是否 strictErrors 模式。
 */
function degradeOrRethrow(error, strict) {
  rethrowIfProgrammerError(error)
  if (strict === true) throw error
}

/**
 * 读取某个上下文的严格模式标记（helper 函数用；Workbench 实例另有 this.strictErrors）。
 * @param ctx - 插件上下文。
 * @returns 是否 strictErrors。
 */
function strictOf(ctx) {
  return ctx?.__workbenchStrictErrors === true
}

/**
 * 描述工作区成员身份，用于在任何破坏性操作前让用户确认。
 * @param workspace - 工作区实体。
 * @returns 一行描述。
 */
function describeWorkspace(workspace) {
  return `工作区 "${workspace.title}" (${workspace.id}, ${workspace.path}, ${workspace.sessionIds.length} 个会话)`
}

/* ------------------------------------------------------------------ *
 * 操作模型：一次工具调用 = 一个 Operation，两端看到的是同一个对象
 * ------------------------------------------------------------------ */

/**
 * 把一条指令**投进某个会话**，让它（继续）干活。
 *
 * 只调官方 `sessionController.prompt({requestId, sessionId, mode, content:[{type:'text', text}]}, signal)`：
 * 官方 `prompt` **自己会 resolve/resume** 目标 Session（`dsh-api-session-controller/lib/types/commands.js:303`，
 * 2026-11-02 对安装版 0.2.1-rc.5 核对），所以这里**不再**预调 `resolveAgent`
 * （旧实现会因此多加载一次、提前拿 writer；失败错误由 prompt 自己抛，调用方统一翻译）。
 *
 * `mode: 'queue'`：进 `inbox.nextTurn`；空闲时 wake 一轮**立刻开工**，运行中则在当前 turn 结束后执行。
 * `mode: 'steer'`：进 `inbox.nextStep`，在当前 turn 的**下一步**被采纳、不中断当前 step；
 * 注意官方 `prompt` 在空闲目标上也接受 steer（会直接开一轮），`session/steer-unavailable`
 * 只由 `updateQueue` 产生 —— 所以"是否在跑"必须在调用前自己判断（见 {@link runningStateOf}）。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @param text - 指令正文。
 * @param mode - `'queue'` | `'steer'`（官方 prompt 模式）。
 * @returns Promise；失败时抛出（调用方决定是报错还是只记日志）。
 */
async function admitPrompt(ctx, sessionId, text, mode = 'queue') {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') {
    throw new Error('本部署没有 sessionController.prompt')
  }
  // 官方 `sessionController.prompt` **自己会 resolve/resume** 目标 Session
  // （`dsh-api-session-controller/lib/types/commands.js:303`，2026-11-02 对 0.2.1-rc.5 源码核对），
  // 先调 `resolveAgent` 只是为了提前拿错误、但会多加载一次并提前拿 writer，投递路径不需要它。
  // 错误（session/not-found、session/agent-busy 子会话栅栏等）由 prompt 自己抛，调用方统一翻译。
  await controller.prompt({
    requestId: `workbench-${globalThis.crypto.randomUUID()}`,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
  }, new AbortController().signal)
}

/**
 * 读一条会话**当前有没有在跑 turn**（不加载、不唤醒会话）。
 *
 * 这是 `send` / `steer` 判断"该用哪个"的唯一依据，也是 `list` / `get` 回报给模型的
 * 决策事实：官方 `agents` 服务对未加载的会话没有实例 → 必然没在跑；已加载会话的
 * `agent.status === 'running'` 表示有 turn 正在执行。
 *
 * 为什么由工具读、而不是让模型先猜：模型能看到的会话行只有"是否活动（已加载）"，
 * 那不是"是否正在跑"；而 steer 与 queue 的全部差别恰恰取决于它。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @returns true = 正在跑；false = 明确没在跑（含未加载）；undefined = 读不到（没有 agents 服务）。
 */
function runningStateOf(ctx, sessionId) {
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    return undefined
  }
  if (agents === undefined || typeof agents.get !== 'function') return undefined
  try {
    return agents.get(sessionId)?.status === 'running'
  } catch {
    return undefined
  }
}

/**
 * 读一条**已加载**会话的待处理队列条数（不 resolve、不唤醒）。
 *
 * 只读内存里的 agent：读不到就返回 undefined，不会为了"看一眼队列"把冷会话加载起来。
 * `send` 用它告诉模型"这条会排在已有 N 条之后"；`get` 用它让模型在决定 steer / send
 * 之前看到积压量。顺序语义（官方）：`nextTurn` 在当前 turn 结束后按序执行，
 * `nextStep` 在当前 turn 的下一步被采纳（QueueDock Steer 的效果）。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @returns `{ nextTurn, nextStep }`；读不到（未加载 / 没有 agents 服务）返回 undefined。
 */
function inboxStateOf(ctx, sessionId) {
  try {
    const agent = ctx.get('agents')?.get?.(sessionId)
    const inbox = agent?.inbox
    if (inbox === undefined) return undefined
    return {
      nextTurn: Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0,
      nextStep: Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * 读一条会话的 inbox **投影**（官方无加载路径；`queue` 的 list 用它）。
 *
 * 官方 `sessionController.projections({ sessionId }, signal)` 返回
 * `values.inbox = { nextTurn, nextStep }`（`dsh-api-session-controller/lib/index.js:3281-3309`，
 * live 与 current-format 冷会话都支持，2026-11-02 对 0.2.1-rc.5 核对）。
 * 用它替代「`agents.get` 未命中就 `resolveAgent`」——后者会为了看一眼空队列把冷会话**加载起来**，
 * 而未加载会话的 pending inbox 必然在内存里、重新加载后会从持久化恢复（queue 不在冷会话凭空出现）。
 *
 * 老部署没有 `projections` 时退回 live agent 的 `inbox`（同样不加载）；两者都没有 → undefined。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @returns `{ nextTurn, nextStep }`（完整 UserMessage 数组）或 undefined（冷会话/读不到）。
 */
async function inboxProjectionOf(ctx, sessionId) {
  const controller = ctx.get('sessionController')
  if (controller !== undefined && typeof controller.projections === 'function') {
    try {
      const projection = await controller.projections({ sessionId }, new AbortController().signal)
      const inbox = projection?.values?.inbox
      if (inbox !== undefined) {
        /*
         * 形状陷阱（2026-11-02 验证发现，0.2.1-rc.5）：`inbox` 投影给的是 **wire 形状**，
         * 键是 kebab-case `next-turn` / `next-step`（`InboxWireState`；
         * session-projection snapshot 直接返回 wire view），**不是** `Inbox` 类型上的
         * camelCase `nextTurn` / `nextStep`。只读 camelCase 会让 queue list 永远回"空"。
         * 这里两种都认；对象在但两个键都缺失时**不当成空**，继续回退 live agent（不然会假报空）。
         */
        const nextTurn = inbox.nextTurn ?? inbox['next-turn']
        const nextStep = inbox.nextStep ?? inbox['next-step']
        if (Array.isArray(nextTurn) || Array.isArray(nextStep)) {
          return {
            nextTurn: Array.isArray(nextTurn) ? nextTurn : [],
            nextStep: Array.isArray(nextStep) ? nextStep : [],
          }
        }
      }
    } catch {
      // 投影读不到（老部署 / 会话不存在由上游报错）→ 退回 live agent 路径。
    }
  }
  try {
    const inbox = ctx.get('agents')?.get?.(sessionId)?.inbox
    if (inbox !== undefined) {
      return {
        nextTurn: Array.isArray(inbox.nextTurn) ? inbox.nextTurn : [],
        nextStep: Array.isArray(inbox.nextStep) ? inbox.nextStep : [],
      }
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * 把投递失败翻译成模型能据此行动的错误。
 *
 * 官方错误码里有两类特别值得说清（2026-11-02 对 0.2.1-rc.5 核对）：
 * `session/agent-busy` 是**子会话栅栏**（要求走 subagents 域的交付通道）；
 * `session/not-found` 是会话不存在/已 dispose。其余原样带出 code + message。
 *
 * @param error - `prompt` 抛出的错误。
 * @returns 带可行动提示的 Error。
 */
function deliveryErrorOf(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  const message = messageOf(error)
  if (code === 'session/agent-busy') {
    return new Error(`投递被拒（${code}：${message}）。最常见原因是目标为**子会话**（subagent child）——`
      + '官方要求父会话走 subagents 域的交付通道，本工具的 send/steer 只适用于普通会话；'
      + '若目标确实是普通会话，说明它的 admission 正忙（例如另一条投递还在解析），稍后重试即可。')
  }
  return new Error(`投递失败${code === undefined ? '' : `（${code}）`}：${message}`)
}

/**
 * 判断一条事件是不是"新的完整助手回复"（`wait` until='reply'）。
 * @param event - Session 事件。
 * @returns 是否是一段非空助手正文。
 */
function isReplyEvent(event) {
  if (!event || event.type !== 'assistant/message') return false
  const content = event.data?.message?.content
  const text = (Array.isArray(content) ? content : [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
  return text !== ''
}

/**
 * `wait` until='step'：任何"完成了一步"的信号（工具结果、或一段助手回复）。
 * @param event - Session 事件。
 * @returns 是否算一步进展。
 */
function isStepEvent(event) {
  if (!event) return false
  return event.type === 'tool/result' || isReplyEvent(event)
}

/**
 * 把事件渲染成模型可读的行（`read` / `wait` 共用）。
 * @param events - Session 事件数组（按 seq 升序）。
 * @returns 文本行数组。
 */
function renderEventLines(events) {
  const lines = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event === undefined || event === null) continue
    const data = event.data ?? {}
    if (event.type === 'user/message') lines.push(`用户：${textOfMessage(data)}`)
    else if (event.type === 'assistant/message') lines.push(`助手：${textOfMessage(data.message ?? data)}`)
    else if (event.type === 'tool/call') lines.push(`工具调用：${String(data.name ?? '?')}`)
    else if (event.type === 'tool/result') {
      // 官方 tool/result 的 data 是 { message, turn, step }——没有 data.error。
      const failed = data.error !== undefined || data.message?.error !== undefined
      lines.push(`工具结果：${failed ? 'error' : 'ok'}`)
    } else if (event.type === 'session/title') lines.push(`（标题事件：${JSON.stringify(data.title ?? '')}）`)
  }
  return lines
}

/**
 * 读一条会话日志当前的末尾 seq（cursor 锚点）。
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @param signal - 取消信号。
 * @returns 末尾 seq；空日志 -1；读不到 undefined。
 */
async function logEndSeq(ctx, sessionId, signal) {
  try {
    const controller = ctx.get('sessionController')
    if (controller === undefined || typeof controller.events !== 'function') return undefined
    const page = await controller.events({ address: { kind: 'session', sessionId }, maxMessages: 1 }, signal)
    const records = Array.isArray(page?.records) ? page.records : []
    const last = records[records.length - 1]?.event
    return typeof last?.seq === 'number' ? last.seq : -1
  } catch (error) {
    degradeOrRethrow(error, strictOf(ctx))
    return undefined
  }
}

/**
 * 读 `after`（cursor）**之后**的事件（前向增量）。必要时向前翻页覆盖窗口，最多 40 页。
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @param after - 只要 seq 大于它的；缺省表示读最近一页。
 * @param limit - 一页的消息数预算。
 * @param signal - 取消信号。
 * @returns {{events: Array, cursor: number, hasMore: boolean}}
 */
async function readEventsAfter(ctx, sessionId, after, limit, signal) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.events !== 'function') {
    throw new Error('read 不可用：本部署没有 sessionController.events')
  }
  const maxMessages = Math.max(1, Math.min(200, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20))
  const collected = []
  let hasMore = false
  let guard = 0
  const absorb = (candidate) => {
    hasMore = candidate?.hasMore === true
    const pageRecords = Array.isArray(candidate?.records) ? candidate.records : []
    for (const record of pageRecords) {
      if (record?.event !== undefined && record.event !== null) collected.push(record.event)
    }
    return pageRecords
  }
  let records = absorb(await controller.events({ address: { kind: 'session', sessionId }, maxMessages }, signal))
  while (typeof after === 'number' && records.length > 0 && guard++ < 40) {
    const firstSeq = typeof records[0]?.event?.seq === 'number' ? records[0].event.seq : undefined
    if (firstSeq === undefined || firstSeq <= after + 1) break
    records = absorb(await controller.events({
      address: { kind: 'session', sessionId },
      maxMessages,
      beforeSeq: firstSeq,
    }, signal))
    if (records.length === 0) break
  }
  const seen = new Set()
  const events = collected
    .filter((event) => typeof event.seq === 'number' && (typeof after !== 'number' || event.seq > after))
    .sort((left, right) => left.seq - right.seq)
    .filter((event) => {
      if (seen.has(event.seq)) return false
      seen.add(event.seq)
      return true
    })
  const cursor = events.length > 0 ? events[events.length - 1].seq : (typeof after === 'number' ? after : -1)
  return { events, cursor, hasMore }
}

/**
 * 等 `after`（cursor）之后的新事件，直到满足 `until` / turn 结束 / 超时。
 *
 * until 的三种语义（全部基于官方 `session/event`，不轮询、不自造协议）：
 *  - `reply`：收到一段新的**完整助手回复**就返回；
 *  - `step`：完成**一步**（工具结果或一段助手回复）就返回，用来早点看到进展；
 *  - `done`（默认）：整个 turn 结束才返回（等价于旧行为）。
 *
 * 超时**不抛错**：返回已收到的事件 + cursor + idleForMs（多久没动静），让调用方自己决定。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @param options - `{ after?, until?, timeoutMs }`。
 * @returns `{state, events, cursor, status, reason?, idleForMs}`。
 */
async function waitForNewEvents(ctx, sessionId, options) {
  const { after, until = 'done', timeoutMs } = options
  const agents = ctx.get('agents')
  const statusOf = () => { try { return agents?.get?.(sessionId)?.status } catch { return undefined } }
  const initialStatus = statusOf()
  // 没有 `after` 时把"现在"当基线：等到的是**从现在起**的新事件，不把历史事件当新内容。
  // 注意：官方 Remote stub 的读方法要求真实 signal（undefined 会抛），baseline 也要给一个。
  const baseline = typeof after === 'number' ? after : await logEndSeq(ctx, sessionId, new AbortController().signal)
  const effectiveAfter = typeof baseline === 'number' ? baseline : undefined
  let collected = []
  let cursor = typeof effectiveAfter === 'number' ? effectiveAfter : -1
  let lastEventAt = Date.now()
  try {
    const catchUp = await readEventsAfter(ctx, sessionId, effectiveAfter, 50, new AbortController().signal)
    collected = catchUp.events
    cursor = catchUp.cursor
    const last = collected[collected.length - 1]
    if (last !== undefined && typeof last.time === 'number') lastEventAt = Math.max(lastEventAt, last.time)
  } catch {
    // 读不到已有事件就只靠订阅；不影响等待本身。
  }
  const already = until === 'reply'
    ? collected.some(isReplyEvent)
    : until === 'step' ? collected.some(isStepEvent) : false
  if (already) return { state: until, events: collected, cursor, status: initialStatus ?? 'unknown', idleForMs: 0 }
  if (initialStatus !== 'running') {
    return {
      state: 'idle',
      events: collected,
      cursor,
      status: initialStatus ?? 'unknown',
      idleForMs: Math.max(0, Date.now() - lastEventAt),
    }
  }
  return new Promise((resolve) => {
    let settled = false
    let dispose = null
    let timer = null
    const finish = (payload) => {
      if (settled) return
      settled = true
      try { clearTimeout(timer) } catch {}
      try { dispose?.() } catch {}
      resolve({ ...payload, events: collected, cursor, idleForMs: Math.max(0, Date.now() - lastEventAt) })
    }
    const onEvent = (session, event) => {
      if (!session || session.id !== sessionId || !event || typeof event.type !== 'string') return
      if (typeof event.seq === 'number' && typeof effectiveAfter === 'number' && event.seq <= effectiveAfter) return
      lastEventAt = Date.now()
      collected.push(event)
      if (typeof event.seq === 'number') cursor = event.seq
      if (until === 'reply' && isReplyEvent(event)) finish({ state: 'reply' })
      else if (until === 'step' && isStepEvent(event)) finish({ state: 'step' })
      else if (event.type === 'turn/end') finish({ state: 'ended', reason: event.data?.reason ?? null })
    }
    timer = setTimeout(() => finish({ state: 'timeout', status: statusOf() ?? 'unknown' }), timeoutMs)
    try { dispose = ctx.on('session/event', onEvent) } catch {}
    setTimeout(() => {
      if (settled) return
      const status = statusOf()
      if (status !== 'running') finish({ state: 'ended', reason: { kind: 'unknown' } })
    }, 50)
  })
}

/**
 * 读一个会话的**标题投影值**（就是客户端 `projectionValues.title` 那一格要的形状）。
 *
 * 为什么要自己补这一格：`summaryFor()` 对**活**会话走的是水位缓存
 * （`cachedSnapshot(session)`，不折叠历史），标题那一格常常还没物化，
 * 于是刚建好的会话在侧边栏先显示成「新会话」（2026-10-15 实测）。
 * 冷会话走 `controller.list()`（内部 summarizeCold → 持久化投影缓存），所以只有"刚建好"这一段会缺。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @returns 标题投影值；读不到就返回 undefined（那就不补，不编造）。
 */
function titleProjectionFor(ctx, sessionId) {
  try {
    const titles = ctx.get('sessionTitle')
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (titles === undefined || session === undefined) return undefined
    const snapshot = titles.get(session)
    if (snapshot === undefined || snapshot === null) return undefined
    if (typeof snapshot !== 'object') return undefined
    // 官方 title projection 的 wire 类型是 string | null；`titles.get()` 返回的是快照对象
    // ({ title, messageSeqs, source, eventSeq, updatedAt })，必须取 .title 再放进去。
    const title = snapshot.title
    if (typeof title === 'string' || title === null) return title
    return undefined
  } catch (error) {
    degradeOrRethrow(error, strictOf(ctx))
    return undefined
  }
}


/**
 * 把任意文本压成一行、并截断到上限。
 * @param text - 原始文本。
 * @returns 单行说明。
 */

/** 工作区与会话的读写门面，把 cordis 服务翻译成工具能用的普通数据。 */
class Workbench {
  /**
   * @param ctx - 带 `workspaceRegistry` 与 `sessionQuery` 的插件上下文。
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    /** strictErrors 模式：任何降级都抛错（开发/测试用）。 */
    this.strictErrors = strictOf(ctx)
    /** 最近一次 announce 的失败（warn 之外还要在工具文本里如实告知"界面可能没刷新"）。 */
    this.announceFailures = []
    /** 工作区摘要里标题读取是否失败（用于在输出里说明"标题可能是空的"）。 */
    this.summaryTitleFailure = false
    /** 写配置审批策略：'ask'（默认）| 'never'。 */
    this.approvalPolicy = config?.approval === 'never' ? 'never' : 'ask'
    /** 是否要求预览凭证。 */
    this.requirePreview = config?.requirePreview !== false
    /** 配置写入审计（内存环形，最多 100 条；插件重挂/重启后清空——用 docs 说明）。 */
    this.auditLog = []
    /**
     * 分支在被 dispose **之前**预抓的 summary（见 {@link Workbench#rememberSummary}）。
     * 只服务"改名临时加载后释放"这条路径：会话已经没了活实例，冷路径又要在
     * `sessionQuery` 里多读一次 header，而这一份是当时**最新**的（改名之后抓的）。
     */
    this.hints = new Map()
  }

  /**
   * 记下"这个会话现在长什么样"，供随后这一次播报使用（用完即删）。
   * @param sessionId - 会话 id。
   * @param summary - 官方 `controller.list()`（公开路径）返回的行快照。
   * @returns 无。
   */
  rememberSummary(sessionId, summary) {
    if (summary !== undefined) this.hints.set(sessionId, summary)
  }

  /**
   * 把"这条会话刚变过"播报给浏览器。
   *
   * 只做一件事：对该会话按官方语义补一条 `api-session/added`
   * （"A Session became visible or its Agent was created or disposed.
   *  Consumers upsert the summary and replace its current running and availability state."）
   * ——`ctx.emit` 出去的这条事件在白名单里，会被转发到每个已连接的浏览器。
   *
   * **为什么还需要它**（2026-10-15 定稿）：唯一目的是把 `values.title` 送出去。
   * 活会话的标题格走水位缓存（`cachedSnapshot(session)`，不折叠历史），常常还没物化，
   * 不补的话刚建好的会话在侧边栏会一直显示成「新会话」。
   *
   * 帧里**只带这一格**（`values.title`）——不再有插件自定义投影，因为没有任何消费者。
   *
   * **拿不到 summary 就不发**：不编造一条会让界面出现幽灵行的帧。
   *
   * @param sessionIds - 这次操作碰到的会话 id（通常是工具结果里的 `sessionId`）。
   * @returns 实际播报的会话 id 列表（Promise）。
   */
  async announce(sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return []
    const announced = []
    for (const sessionId of [...new Set(sessionIds)]) {
      const summary = await this.summaryFor(sessionId)
      if (summary === undefined) continue
      const values = { ...(summary.projections?.values ?? {}) }
      if (values.title === undefined) {
        const title = titleProjectionFor(this.ctx, sessionId)
        if (title !== undefined) values.title = title
      }
      const frame = {
        ...summary,
        projections: {
          kind: summary.projections?.kind ?? 'sequenced',
          asOfSeq: summary.projections?.asOfSeq ?? -1,
          values,
        },
      }
      try {
        this.ctx.emit('api-session/added', frame)
        announced.push(sessionId)
      } catch (error) {
        degradeOrRethrow(error, this.strictErrors)
        this.announceFailures.push(messageOf(error))
        this.ctx.logger?.warn?.(`dsh-host-ops: announce failed: ${messageOf(error)}`)
      }
    }
    for (const sessionId of sessionIds) this.hints.delete(sessionId)
    return announced
  }

  /**
   * 取某个会话当前的 list summary（客户端帧的载荷）。
   *
   * 三条路，按代价从低到高：
   *  1. **公开列表**：官方控制器的 `list({}, signal)`——返回活会话与冷会话的行快照；
   *     不再依赖私有的 `listState.summaryFor`。
   *  2. **分支预抓的快照**：会话已被 dispose、拿不到活实例时（rename 的临时 resume 路径）。
   *  3. **冷会话**：未加载但已持久化的会话（pin / archive 的常态）。公开 `list()` 已覆盖；
   *     仅在旧部署没有 `list()` 时才回落私有 `summarizeCold({ header })`（0.2.2 的签名）。
   *
   * @param sessionId - 会话 id。
   * @param op - 当前操作（携带 `summaryHints`）。
   * @returns summary，或 undefined（拿不到就不发帧）。
   */
  async summaryFor(sessionId) {
    const hint = this.hints.get(sessionId)
    // hint 只用在"临时加载后释放"那条路：会话已经被 dispose，界面上那一行也被
    // `api-session/removed` 删掉了——补回来的帧必须如实说"它没在跑"。
    if (hint !== undefined) return { ...hint, running: false, agentAvailable: false }
    const controller = this.ctx.get('sessionController')
    // 公开路径：0.2.2-rc.1 的 `controller.list({}, signal)` 返回 `{ items }`，活会话与冷会话
    // 都在里面。不再依赖私有的 `listState.summaryFor / summarizeCold`（0.2.2 已改过
    // summarizeCold 的签名，私有字段没有兼容承诺）。
    if (controller !== undefined && typeof controller.list === 'function') {
      try {
        const listed = await controller.list({}, undefined)
        const items = Array.isArray(listed?.items) ? listed.items : Array.isArray(listed) ? listed : []
        const summary = items.find((item) => item?.sessionId === sessionId)
        if (summary !== undefined) return summary
      } catch (error) {
        degradeOrRethrow(error, this.strictErrors)
        this.ctx.logger?.warn?.(`dsh-host-ops: list summary failed: ${messageOf(error)}`)
      }
    }
    // 旧部署兜底：私有路径仍在时用它，失败就当作拿不到（不发幽灵帧）。
    // 注意 0.2.2-rc.1 起官方把 `summarizeCold` 改成对象参数 ({ header, formatStatus })——
    // 这里按新签名调用；旧版本若仍是位置参数，catch 会兜住并降级。
    try {
      const session = this.ctx.get('sessions')?.get?.(sessionId)
      if (session !== undefined && typeof controller?.listState?.summaryFor === 'function') {
        const summary = controller.listState.summaryFor(session)
        if (summary !== undefined && typeof summary.sessionId === 'string') return summary
      } else if (typeof controller?.listState?.summarizeCold === 'function') {
        const records = await this.query.listSessions(undefined)
        const record = records.find((candidate) => candidate.header.id === sessionId)
        if (record !== undefined) {
          const cold = controller.listState.summarizeCold({ header: record.header, formatStatus: record.formatStatus })
          if (cold !== undefined && typeof cold.sessionId === 'string') return cold
        }
      }
    } catch (error) {
      degradeOrRethrow(error, this.strictErrors)
      this.ctx.logger?.warn?.(`dsh-host-ops: private summaryFor failed: ${messageOf(error)}`)
    }
    return undefined
  }

  /** @returns 工作区注册表服务。 */
  get registry() {
    return this.ctx.workspaceRegistry
  }

  /** @returns 会话查询服务。 */
  get query() {
    return this.ctx.sessionQuery
  }

  /**
   * 按 id 取工作区实体。
   * @param id - 工作区 id。
   * @returns 实体；不存在时抛错。
   */
  requireWorkspace(id) {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('需要 workspaceId')
    const workspace = this.registry.get(id)
    if (workspace === undefined) {
      const known = this.registry.list().map((entry) => `${entry.id} ("${entry.title}")`).join(', ')
      throw new Error(`找不到工作区 "${id}"。已注册的工作区：${known || '（无）'}`)
    }
    return workspace
  }

  /**
   * 读一批会话的标题与头部。
   *
   * `readTitleSnapshots` 的结果按“每个会话一个 settled 结果”返回：成功的读标题，
   * 失败的（例如日志损坏）隔离成 `titleError`，不让整次列表调用挂掉。
   * 头部的 `live` / `persisted` 以调用方掌握的记录为准，这里不猜。
   *
   * @param ids - 会话 id 列表。
   * @param options - `showIds` 是否给完整 id；`signal` 取消信号；`known` 已知元数据表。
   * @returns 展示行列表，顺序与入参一致。
   */
  async describeSessions(ids, options = {}) {
    if (ids.length === 0) return []
    const settled = await this.query.readTitleSnapshots([...ids], options.signal)
    const known = options.known
    return ids.map((id, index) => {
      const entry = settled[index]
      const base = known?.get(id)
      if (entry === undefined || entry.status === 'rejected') {
        return {
          sessionId: id,
          displayId: shortId(id, options.showIds),
          title: null,
          titleError: true,
          createdAt: base?.createdAtMs === undefined ? null : formatTime(base.createdAtMs),
          createdAtMs: base?.createdAtMs ?? null,
          cwd: base?.cwd ?? null,
          origin: base?.origin ?? null,
          kind: base?.kind ?? 'session',
          parentSession: base?.parentSession ?? null,
          live: base?.live ?? null,
          persisted: base?.persisted ?? null,
          workspaceId: base?.workspaceId ?? null,
          archived: this.archived.has(id),
          pinned: this.pinned.has(id),
        }
      }
      const header = entry.value.session
      return {
        sessionId: id,
        displayId: shortId(id, options.showIds),
        title: titleTextOf(entry.value.title) ?? null,
        titleError: false,
        createdAt: formatTime(header.createdAt),
        createdAtMs: header.createdAt,
        cwd: header.cwd ?? null,
        origin: header.origin ?? null,
        kind: header.origin === 'subagent' ? 'subagent' : 'session',
        parentSession: header.parentSession ?? null,
        live: base?.live ?? true,
        persisted: base?.persisted ?? false,
        workspaceId: base?.workspaceId ?? null,
        archived: this.archived.has(id),
        pinned: this.pinned.has(id),
      }
    })
  }

  /**
   * 会话 id → 它所属工作区的 id；未分组为 `undefined`。
   *
   * 归属的**唯一真相**是工作区记录里的 `sessionIds`（这些 id 写入前已通过
   * cwd/path 校验，所以某条会话不会被算进另一个目录的工作区）。
   * @returns 归属表。
   */
  ownership() {
    const owner = new Map()
    for (const workspace of this.registry.list()) {
      for (const id of workspace.sessionIds) owner.set(id, workspace.id)
    }
    return owner
  }

  /** @returns 当前归档集合。 */
  get archived() {
    return new Set(this.registry.archivedSessionIds ?? [])
  }

  /**
   * 给一个会话 id 拼一个"标题 (id)"形式的人类可读标签，用于写操作的回报。
   * 标题读不到就退回"（无标题）"，不因为标题问题挡住写操作。
   * @param sessionId - 会话 id。
   * @returns 展示标签。
   */
  async labelFor(sessionId) {
    try {
      const settled = await this.query.readTitleSnapshots([sessionId])
      const entry = settled[0]
      const title = entry !== undefined && entry.status === 'fulfilled'
        ? titleTextOf(entry.value.title)
        : undefined
      return `${title ?? '（无标题）'} (${sessionId})`
    } catch {
      return `（无标题） (${sessionId})`
    }
  }

  /** @returns 当前置顶集合（最近置顶在前）。 */
  get pinned() {
    return new Set(this.registry.pinnedSessionIds ?? [])
  }

  /**
   * 在**不读会话日志**的前提下列出全部会话元数据。
   *
   * 做法：会话头 + 标题来自 `sessionQuery`；工作区归属、置顶、归档来自
   * 工作区注册表。事件日志这里一次都不读——`listEvents()` 每次都要校验
   * 整条日志，批量调用太贵，所以列表用不到“最后活动时间”。
   *
   * @param options - 过滤、排序与展示选项。
   * @returns 归一化后的 `{ rows, workspaceById, listedCount }`。
   */
  async collect(options) {
    const listed = await this.query.listSessions(options.signal)
    const workspaceId = options.workspaceId
    const workspaces = this.registry.list()
    const workspaceById = new Map(workspaces.map((entry) => [entry.id, entry]))
    const ownerOf = this.ownership()
    const archived = this.archived
    const pinned = this.pinned

    let rows = listed.map((record) => ({
      sessionId: record.header.id,
      createdAt: formatTime(record.header.createdAt),
      createdAtMs: record.header.createdAt,
      cwd: record.header.cwd ?? null,
      parentSession: record.header.parentSession ?? null,
      origin: record.header.origin ?? null,
      isSeeded: record.header.isSeeded === true,
      // header.agentPreset 是**创建事实**（deep-frozen），不等于当前生效 preset；
      // 字段名改成 createdWithPreset，避免消费者把它当“当前值”。
      createdWithPreset: record.header.agentPreset ?? null,
      live: record.live === true,
      persisted: record.persisted === true,
      workspaceId: ownerOf.get(record.header.id),
      kind: record.header.origin === 'subagent' ? 'subagent' : 'session',
      archived: archived.has(record.header.id),
      pinned: pinned.has(record.header.id),
    }))

    // 过滤：工作区、未分组、归档状态、会话种类。
    if (workspaceId !== undefined) {
      const workspace = this.requireWorkspace(workspaceId)
      rows = rows.filter((row) => row.workspaceId === workspace.id)
    }
    if (options.ungrouped === true) rows = rows.filter((row) => row.workspaceId === undefined)
    if (options.archived === false) rows = rows.filter((row) => !row.archived)
    if (options.archived === true) rows = rows.filter((row) => row.archived)
    if (options.kind === 'session') rows = rows.filter((row) => row.kind === 'session')
    if (options.kind === 'subagent') rows = rows.filter((row) => row.kind === 'subagent')

    // 排序：指定工作区时用记录里登记的**人工顺序**（就是侧边栏看到的顺序），
    // 否则按创建时间最新在前。
    const manualRank = new Map()
    const target = workspaceId === undefined ? undefined : workspaceById.get(workspaceId)
    if (target !== undefined) {
      ;[...target.sessionIds].forEach((id, index) => manualRank.set(id, index))
    }
    rows.sort((left, right) => {
      if (target === undefined) return right.createdAtMs - left.createdAtMs
      const leftRank = manualRank.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER
      const rightRank = manualRank.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank
    })

    // 标题批量读；`fetchError` 表示整批读失败，行仍然返回但标题为空。
    let fetchError = false
    try {
      const infos = await this.describeSessions(rows.map((row) => row.sessionId), {
        showIds: options.showIds,
        signal: options.signal,
        known: new Map(rows.map((row) => [row.sessionId, row])),
      })
      for (const [index, row] of rows.entries()) {
        const info = infos[index]
        row.title = info?.title ?? null
        row.titleError = info?.titleError === true
        row.displayId = info?.displayId ?? shortId(row.sessionId, options.showIds)
      }
    } catch (error) {
      fetchError = true
      for (const row of rows) {
        row.title = null
        row.titleError = true
        row.displayId = shortId(row.sessionId, options.showIds)
      }
      degradeOrRethrow(error, this.strictErrors)
      this.ctx.logger?.warn?.(`dsh-host-ops: session titles unavailable: ${messageOf(error)}`)
    }

    // 运行状态：不影响排序/过滤，只作为"该 send 还是 steer"的决策事实回报给模型。
    // 未加载的会话 agents.get() 没有实例 → false（必然没在跑），不会因此加载会话。
    for (const row of rows) {
      row.running = runningStateOf(this.ctx, row.sessionId) ?? null
    }

    return { rows, workspaceById, listedCount: listed.length, fetchError }
  }

  /**
   * 按工作区分组的紧凑摘要（`list` 不带 `workspaceId`/`cwd`、也不带行级过滤时用）。
   *
   * 为什么不复用 {@link Workbench#collect}：`collect()` 会给**每一条**会话读标题快照。
   * 本机有 520 条会话，一次性读全部既慢又大；而"概览"只需要每个工作区**一条**最近会话。
   * 这里只读 `listSessions()` 的头部（不碰事件日志），算出会话数与最近一条，再按工作区
   * 批量读那一条的标题——标题读取次数 = 工作区数，与总会话数无关。
   *
   * "最近一条"按 `header.createdAt` 取最大值。会话头里没有"最后活动时间"（要读完整
   * 事件日志才能算，批量太贵，见 README 已知限制 #5），所以这是创建时间意义上的最近。
   *
   * @param options - `signal` 取消信号；`limit` 最多列多少个工作区（默认 30，上限 100）；
   *   `showIds` 是否给完整 workspace id。
   * @returns `{ listedCount, workspaceCount, workspaces, ungroupedCount, archivedCount, truncated }`。
   */
  async summarizeWorkspaces(options = {}) {
    this.summaryTitleFailure = false
    const listed = await this.query.listSessions(options.signal)
    const workspaces = this.registry.list()
    const archived = this.archived
    const ownerOf = this.ownership()
    const groups = new Map(workspaces.map((workspace) => [workspace.id, { workspace, sessions: [] }]))
    const ungrouped = []
    let archivedCount = 0
    for (const record of listed) {
      if (archived.has(record.header.id)) archivedCount++
      const group = groups.get(ownerOf.get(record.header.id))
      if (group === undefined) ungrouped.push(record)
      else group.sessions.push(record)
    }

    const summaries = []
    for (const { workspace, sessions } of groups.values()) {
      let latest
      for (const record of sessions) {
        if (latest === undefined || record.header.createdAt > latest.header.createdAt) latest = record
      }
      summaries.push({
        workspaceId: workspace.id,
        displayId: shortId(workspace.id, options.showIds),
        title: workspace.title,
        sessionCount: sessions.length,
        activeSessionCount: sessions.filter((record) => !archived.has(record.header.id)).length,
        latestSession: latest === undefined ? null : {
          sessionId: latest.header.id,
          displayId: shortId(latest.header.id, options.showIds),
          title: null,
          createdAt: formatTime(latest.header.createdAt),
        },
      })
    }

    // 只给"每个工作区的那一条最近会话"读标题；读取失败不让整次概览挂掉。
    const withLatest = summaries.filter((row) => row.latestSession !== null)
    if (withLatest.length > 0) {
      try {
        const infos = await this.describeSessions(withLatest.map((row) => row.latestSession.sessionId), {
          showIds: options.showIds,
          signal: options.signal,
        })
        for (const [index, row] of withLatest.entries()) {
          const info = infos[index]
          if (info === undefined) continue
          row.latestSession.title = info.title
          row.latestSession.displayId = info.displayId
        }
      } catch (error) {
        degradeOrRethrow(error, this.strictErrors)
        this.summaryTitleFailure = true
        this.ctx.logger?.warn?.(`dsh-host-ops: summary titles unavailable: ${messageOf(error)}`)
      }
    }

    const maxRows = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), MAX_SUMMARY_WORKSPACES)
      : DEFAULT_SUMMARY_WORKSPACES
    return {
      listedCount: listed.length,
      workspaceCount: summaries.length,
      workspaces: summaries.slice(0, maxRows),
      ungroupedCount: ungrouped.length,
      archivedCount,
      titleFailure: this.summaryTitleFailure,
      truncated: summaries.length > maxRows,
    }
  }

  /**
   * 渲染一行会话，供工具输出。
   *
   * 标记顺序按"决策相关性"排：`运行中`（正在跑 turn）放最前，因为 send / steer
   * 的选择取决于它；`已加载` 只表示进程里有 agent 实例（≠ 在跑），不要混用。
   *
   * @param row - `collect()` 产出的行。
   * @param withId - 是否附完整 id。
   * @returns 单行文本。
   */
  static renderRow(row, withId) {
    const marks = []
    if (row.running === true) marks.push('运行中')
    if (row.live) marks.push('已加载')
    if (row.pinned) marks.push('置顶')
    if (row.archived) marks.push('已归档')
    if (row.kind === 'subagent') marks.push('subagent')
    if (row.parentSession) marks.push(`fork自 ${row.parentSession.slice(0, 14)}…`)
    const title = row.title ?? (row.titleError ? '（标题不可读）' : '（无标题）')
    const id = withId ? row.sessionId : row.displayId
    return `- ${title} — ${id} — ${row.createdAt ?? '?'}`
      + `${marks.length > 0 ? ` [${marks.join(', ')}]` : ''}`
  }

  /**
   * 把一个期望顺序应用到某个移动方法上。
   *
   * 从**队尾往队首**依次落位：每个被移动的对象都插到"已经就位的下一个对象"
   * 之前，锚点永远存在，因此不依赖方法的内部实现细节。
   *
   * @param order - 期望的完整顺序。
   * @param move - `(id, beforeId) => Promise<void>`。
   * @returns 实际应用的位置移动次数。
   */
  static async applyOrder(order, move) {
    let moved = 0
    for (let index = order.length - 1; index >= 0; index--) {
      const id = order[index]
      const beforeId = order[index + 1]
      await move(id, beforeId)
      moved++
    }
    return moved
  }

  /**
   * 计算按标题或时间排序后的新顺序。
   * @param rows - `collect()` 产出的行。
   * @param request - `by` / `reverse` / `from` / `to`。
   * @returns 排序后的会话 id 列表。
   */
  static computeOrder(rows, request) {
    const by = request.by ?? 'title'
    const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' })
    const filtered = rows.filter((row) => {
      if (request.from === undefined && request.to === undefined) return true
      const created = row.createdAtMs
      if (typeof created !== 'number') return false
      if (request.from !== undefined && created < request.from) return false
      if (request.to !== undefined && created > request.to) return false
      return true
    })
    const sorted = [...filtered]
    sorted.sort((left, right) => {
      if (by === 'title') {
        const leftTitle = left.title ?? '\uFFFF'
        const rightTitle = right.title ?? '\uFFFF'
        const compared = collator.compare(leftTitle, rightTitle)
        return compared !== 0 ? compared : left.createdAtMs - right.createdAtMs
      }
      if (by === 'created-asc') return left.createdAtMs - right.createdAtMs
      return right.createdAtMs - left.createdAtMs
    })
    if (request.reverse === true) sorted.reverse()
    return sorted.map((row) => row.sessionId)
  }
}

/* ------------------------------------------------------------------ *
 * 参数 / 输出 schema
 * ------------------------------------------------------------------ */

/** 两个工具共用的输出声明：人读文本 + 机器可读载荷。 */
/**
 * 把一条消息事件的正文压成一行（`read` 用）。
 * @param data - 事件 data（形状不拘，取不到就返回空串）。
 * @returns 一行文本。
 */
function textOfMessage(data) {
  const parts = Array.isArray(data?.content) ? data.content : []
  const text = parts
    .map((part) => (part?.type === 'text' ? String(part.text ?? '') : part?.type === 'tool-call' ? `<工具调用 ${String(part.name ?? '')}>` : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? '（无文本）' : text.slice(0, 400)
}

/**
 * 读一条会话**当前生效**的 agent preset。
 *
 * 为什么不能直接读 `header.agentPreset`：header 是**创建事实**（deep-frozen）。空白会话在
 * 首条消息前可以换 preset（GUI 的 preset chip / `agentPresets.select`），迁移脚本也会往日志
 * 追加 `agent-preset/selected` —— 本机 549 条会话里约 15% 的 header 与当前值不同
 * （含一批被迁移脚本改过 projection 的会话）。当前值的权威来源是 `agentPreset`
 * Session projection（init = header.agentPreset，apply = `agent-preset/selected` 事件）。
 *
 * 活会话走公开的 `sessionProjections.snapshot(session, ['agentPreset'])`（0 I/O；
 * `stateOf` 在 0.2.2-rc.1 已弃用）；冷会话用 `sessionQuery.observeSession` 折一次日志
 * （单条会话可接受；列表不要用它）。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 会话 id。
 * @returns `{value, source}`；当前值读不到时返回 undefined（调用方回落 header 并标注）。
 */
async function readCurrentPreset(ctx, sessionId) {
  try {
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (session !== undefined) {
      // 0.2.2-rc.1：`stateOf` 已弃用；读 client-view 用公开的 `snapshot(session, keys)`。
      const projections = ctx.get('sessionProjections')
      const snapshot = projections?.snapshot?.(session, ['agentPreset'])
      const value = snapshot?.values?.agentPreset
      if (typeof value === 'string' || value === null) return { value, source: 'live' }
    }
  } catch (error) {
    degradeOrRethrow(error, strictOf(ctx))
    /* projection 不可用就继续走冷读 */
  }
  try {
    // `sessionQuery` 在 inject 里是必需依赖（缺它整行不激活），这里直接用 ctx 上的服务；
    // 只对 `observeSession` 这个读方法做版本守卫——本函数仍是"读不到就回落 header"的附加信息路径。
    const query = ctx.sessionQuery
    if (typeof query.observeSession !== 'function') return undefined
    const observation = await query.observeSession(sessionId, { projectionMode: 'all' })
    try {
      const value = observation?.projections?.values?.agentPreset
      if (typeof value === 'string' || value === null) return { value, source: 'prepared' }
      return undefined
    } finally {
      try {
        observation?.[Symbol.dispose]?.()
      } catch {
        /* 释放失败不影响结果 */
      }
    }
  } catch (error) {
    degradeOrRethrow(error, strictOf(ctx))
    return undefined
  }
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      message: { type: 'string' },
      data: { type: 'json' },
    },
  },
  /**
   * @param _args - 模型给的参数（渲染不需要）。
   * @param value - `execute` 返回的声明值。
   * @returns 一个文本块。
   */
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

/**
 * 统一产出工具结果。
 * @param action - 本次动作名。
 * @param message - 给模型读的文本。
 * @param data - 结构化载荷（可选）。
 * @returns 输出值。
 */
function result(action, message, data) {
  return { ok: true, action, message, ...(data === undefined ? {} : { data: JSON.stringify(data) }) }
}

/**
 * 渲染"按工作区分组"的 list 摘要。
 *
 * 模型只读 `message`（`data` 是给人/未来消费者用的，不进模型上下文），所以
 * 「下一步该传 workspaceId」这句提示必须出现在文本里。行里同时给完整 id：
 * `requireWorkspace()` 只认精确 id，只给截断形式的话模型拿到也传不回去。
 *
 * @param summary - {@link Workbench#summarizeWorkspaces} 的产物。
 * @returns 多行文本。
 */
function renderWorkspaceSummary(summary) {
  const shown = summary.workspaces.length
  const tail = summary.truncated ? `（只显示前 ${shown} 个工作区，可用 limit 调大）` : ''
  const lines = [
    `共 ${summary.workspaceCount} 个工作区、${summary.listedCount} 条会话`
    + `（未分组 ${summary.ungroupedCount} 条；归档 ${summary.archivedCount} 条），`
    + `顺序即侧边栏顺序${tail}：`,
  ]
  if (shown === 0) lines.push('（还没有注册任何工作区——用 dsh_workspace_manage 的 create 注册一个目录。）')
  for (const [index, row] of summary.workspaces.entries()) {
    const id = row.displayId === row.workspaceId ? row.workspaceId : `${row.displayId}（${row.workspaceId}）`
    const latest = row.latestSession === null
      ? '（无）'
      : `「${truncateInline(row.latestSession.title ?? '（无标题）', SUMMARY_TITLE_PREVIEW)}」`
        + `${row.latestSession.createdAt ?? '?'}`
    lines.push(`${index + 1}. ${truncateInline(row.title, SUMMARY_TITLE_PREVIEW)} — ${id}`
      + ` — ${row.sessionCount} 个会话（${row.activeSessionCount} 未归档）— 最近：${latest}`)
  }
  if (summary.ungroupedCount > 0) {
    lines.push(`未分组会话：${summary.ungroupedCount} 条（用 { action: 'list', ungrouped: true } 查看）。`)
  }
  if (summary.titleFailure === true) {
    lines.push('⚠️ 部分标题读取失败：摘要里的标题可能为空/未知（列表仍可用，刷新可重试）。')
  }
  lines.push(LIST_SCOPE_HINT)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

/**
 * 给工具包一层"成功后播报"。
 *
 * 播报对象直接从**工具结果**里取（`result()` 的 `data.sessionId`）。
 * 注意 `result()` 把 `data` 序列化成了字符串（输出声明是 `json`），所以要解析回来。
 * 失败路径不在这里播报：见 `rename + resume` 分支里的显式调用。
 *
 * @param definition - `defineTool()` 的产物。
 * @param workbench - 播报入口。
 * @returns 包装后的工具定义。
 */
function withAnnounce(definition, workbench) {
  const inner = definition.execute
  return {
    ...definition,
    /**
     * @param args - 已校验的模型参数。
     * @param exec - 工具执行上下文。
     * @returns 内层 execute 的返回值。
     */
    async execute(args, exec) {
      workbench.announceFailures.length = 0
      /** 播报（失败路径也要，见下）。 */
      const announce = async (sessionIds) => {
        try {
          // announce 对冷会话要读一次 header（见 Workbench#summaryFor），所以是异步的。
          await workbench.announce(sessionIds)
        } catch (error) {
          degradeOrRethrow(error, workbench.strictErrors)
          workbench.announceFailures.push(messageOf(error))
          workbench.ctx.logger?.warn?.(`dsh-host-ops: announce failed: ${messageOf(error)}`)
        }
      }
      const outcome = await inner(args, exec)
      /** 这次操作碰到的会话（工具结果里自报的）。 */
      const sessionIds = []
      // `result()` 把 data 序列化成了字符串（见 OUTPUT.schema 声明为 json）。
      let data = outcome?.data
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch {
          data = undefined
        }
      }
      if (typeof data?.sessionId === 'string') sessionIds.push(data.sessionId)
      if (Array.isArray(data?.sessionIds)) for (const id of data.sessionIds) if (typeof id === 'string') sessionIds.push(id)
      await announce(sessionIds)
      if (workbench.announceFailures.length > 0) {
        const first = workbench.announceFailures[0]
        workbench.announceFailures.length = 0
        const note = `⚠️ 界面行可能未刷新（刷新页面可恢复）：${first}`
        if (typeof outcome?.message === 'string' && outcome.message !== '') outcome.message = `${outcome.message}\n${note}`
      }
      return outcome
    },
  }
}

/* ------------------------------------------------------------------ *
 * 配置工具（dsh_config_manage）用到的辅助
 * ------------------------------------------------------------------ */

/**
 * 取官方配置编辑服务。
 *
 * 它就是**设置界面那些表单用的同一条通道**（`@deepseek-ai/dsh-config-editor`）：
 * 校验完整候选 → 拿 profile 文件锁 → 原子替换覆盖 → 通过 Loader 只重组那一行 →
 * 失败则恢复原文档并重载原 patch。**不是**手改 `cordis.patch.yml`。
 *
 * @param ctx - Host 上下文。
 * @returns 官方服务。
 */
function requireConfigEditor(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new Error('本部署没有 configEditor 服务（由 config-editor 行提供；桌面 App 默认启用，其他组合可能没有）')
  }
  return editor
}

/**
 * 一行 + 一行可读标签。
 * @param entry - Loader 条目。
 * @returns 例如 `session-query-sqlite (@deepseek-ai/dsh-session-query-sqlite)`。
 */
function entryLabel(entry) {
  return `${String(entry?.options?.id ?? '?')} (${String(entry?.options?.name ?? '?')})`
}

/** 两个值是否不同（用 JSON 比，够用且不依赖引用）。 */
function differs(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/**
 * 稳定 JSON 序列化（键排序）：用于比较/哈希配置值，避免对象键顺序造成假差异。
 * @param value - 任意 JSON 值。
 * @returns 稳定序列化文本。
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  // JSON.stringify(undefined) is undefined; normalize so hashing/comparing stays total.
  const text = JSON.stringify(value)
  return text === undefined ? 'undefined' : text
}

/** 两个配置值是否等价（JSON 语义）。 */
function sameConfigValue(left, right) {
  return stableJson(left) === stableJson(right)
}

/**
 * 预览凭证：`入口 + 当前覆盖快照 + 目标覆盖` 的哈希。
 * 写入时用**当前**状态重算一次；对不上说明预览之后有人改过 → 拒绝写入（TOCTOU 防护）。
 * @param entryId - 行 patch id。
 * @param baseOverride - 预览时的覆盖值。
 * @param nextOverride - 预览时的目标覆盖值。
 * @returns 16 位十六进制凭证。
 */
function previewTokenFor(entryId, baseOverride, nextOverride) {
  return createHash('sha256')
    .update(stableJson({ entry: entryId, base: baseOverride, next: nextOverride }))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 审计里对敏感字段做掩码（key/token/secret/password/credential/env）。
 * @param field - 字段名。
 * @param value - 字段值。
 * @returns 可展示的值。
 */
function maskSensitive(field, value) {
  if (typeof field === 'string' && /key|token|secret|password|credential|env/i.test(field)) return '***'
  // 字段名不明显但值里含敏感键（如 providers: [{ apiKey }]）时同样整体掩码。
  if (containsSensitiveKey(value)) return '***'
  const text = JSON.stringify(value)
  return typeof text === 'string' && text.length > 120 ? `${text.slice(0, 117)}…` : value
}

/**
 * 值里是否嵌套了敏感键名（最多看 4 层，防循环/深对象）。
 * @param value - 任意 JSON 值。
 * @param depth - 当前深度。
 * @returns 是否含敏感键。
 */
function containsSensitiveKey(value, depth = 0) {
  if (depth > 4) return false
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).some((key) => /key|token|secret|password|credential|env/i.test(key)
      || containsSensitiveKey(value[key], depth + 1))
  }
  return false
}

/**
 * 把覆盖值里的敏感字段掩码后用于展示（收据/预览/审批文案）。
 * @param override - 覆盖值对象。
 * @returns 掩码后的对象。
 */
function maskOverrideForDisplay(override = {}) {
  const masked = {}
  for (const [field, value] of Object.entries(override)) masked[field] = maskSensitive(field, value)
  return masked
}

/**
 * 启动必需行（官方 `dsh-app-boot` 的 required list）：这些行起不来会**中止启动**。
 * 改它们时预览要给出"可能让 App 打不开"的强提示与应急恢复步骤。
 */
const REQUIRED_STARTUP_ROWS = new Set([
  'agent-loop',
  'tool-executor-native',
  'tool-executor-ptc',
  'webserver',
  'web-runtime',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
])

/**
 * 这一行是不是启动必需行。
 * @param entry - Loader 条目。
 * @returns 是否需要强提示。
 */
function isRequiredStartupRow(entry) {
  return REQUIRED_STARTUP_ROWS.has(String(entry?.options?.id ?? ''))
}

/**
 * 启动必需行的预警文本（预览与收据共用）。
 * @param rowId - 行 id。
 * @returns 文本行数组。
 */
function requiredStartupWarning(rowId) {
  return [
    `⚠️ 启动必需行：${rowId} 属于官方 required list——这一行起不来会**中止 DSH 启动**（不是"某个插件不可用"，是整个 App 打不开）。`,
    '改之前建议先备份 profile 补丁文件；万一改后启动失败：退出 App → 把 `~/.dsh/profiles/desktop/cordis.patch.yml` 改名成 `.bak-<时间>` → 重新启动（官方 Desktop 也有致命恢复机制兜底）。',
  ]
}

/**
 * 请求用户批准一次配置写入（fail closed）。
 * @param ctx - 插件上下文。
 * @param exec - 工具执行上下文（需要 agent 与 callId）。
 * @param details - `{ reason, displayReason }`。
 * @returns `'allowed-once'`；其余情况抛出。
 */
async function requestConfigApproval(ctx, exec, details) {
  const approval = ctx.get('approval')
  if (approval === undefined || typeof approval.request !== 'function') {
    throw new Error('没有审批通道（approval 服务不可用）：写配置被拒绝（fail closed，未做任何修改）。')
  }
  const agent = exec?.agent
  const callId = exec?.callId
  if (agent === undefined || typeof callId !== 'string' || callId === '') {
    throw new Error('审批需要 agent 与 callId（当前执行上下文缺少）：写配置被拒绝（fail closed，未做任何修改）。')
  }
  const outcome = await approval.request({
    agent,
    toolName: 'dsh_config_manage',
    callId,
    reason: details.reason,
    displayReason: details.displayReason,
    signal: exec?.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`未获批准（outcome: ${String(outcome)}）：写配置被拒绝，未做任何修改。`)
  }
  return outcome
}

/**
 * 追加一条配置写入审计（内存环形，最多 100 条）。
 * @param workbench - Workbench 实例。
 * @param record - 审计记录。
 * @returns 记录 id。
 */
function appendConfigAudit(workbench, record) {
  const id = `audit-${Date.now().toString(36)}-${(workbench.auditSeq = (workbench.auditSeq ?? 0) + 1)}`
  workbench.auditLog.unshift({ id, at: new Date().toISOString(), ...record })
  if (workbench.auditLog.length > 100) workbench.auditLog.length = 100
  return id
}


/**
 * 逐字段求差（顶层）。
 * @param before - 改前。
 * @param after - 改后。
 * @returns `[{ field, from, to }]`。
 */
function fieldChanges(before, after) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()
  const changes = []
  for (const field of keys) {
    if (differs(before?.[field], after?.[field])) changes.push({ field, from: before?.[field], to: after?.[field] })
  }
  return changes
}

/**
 * 覆盖值层面的逐字段差异（带回滚所需的"改前/改后是否有该字段"事实）。
 * @param before - 写入前的覆盖值。
 * @param after - 写入后的覆盖值。
 * @returns `[{ field, from, to, beforeHad, afterHad }]`。
 */
function overrideDiff(before = {}, after = {}) {
  return fieldChanges(before, after).map((change) => ({
    ...change,
    beforeHad: Object.prototype.hasOwnProperty.call(before, change.field),
    afterHad: Object.prototype.hasOwnProperty.call(after, change.field),
  }))
}

/**
 * 预判"这次改动会不会重建这一行"。
 *
 * 依据是 Loader 自己的语义（`cordis-plugin-loader` 的 `equalExceptVolatile` /
 * `Entry.update()`）：只有 **volatile** 字段变化时，它走
 * `this.fiber._config = this.options.config` + `_commitVolatile()`——**就地更新运行中的引用，不重启这一行**；
 * 一旦有非 volatile 字段变化，就 `fiber.update()` → dispose 再重建。
 *
 * 所以对"后果"这句话，我们能给出**针对这次改动**的判断，而不是笼统的"看生命周期"。
 *
 * @param entry - Loader 条目。
 * @param changes - 逐字段改动（`[{ field, from, to }]`）。
 * @returns `{ verdict, volatileFields, hotFields, reason }`；拿不到 schema 时 `verdict: 'unknown'`。
 */
function predictReconcile(entry, changes) {
  const schema = entry?.fiber?.runtime?.Config
  const dict = schema?.dict
  if (dict === undefined || typeof dict !== 'object') {
    return { verdict: 'unknown', volatileFields: [], hotFields: changes.map((change) => change.field) }
  }
  const volatileFields = []
  const hotFields = []
  for (const change of changes) {
    const node = dict[change.field]
    if (node?.meta?.volatile === true) volatileFields.push(change.field)
    else hotFields.push(change.field)
  }
  return {
    verdict: hotFields.length === 0 ? 'volatile-only' : 'rebuild',
    volatileFields,
    hotFields,
    active: entry?.fiber?.state === 2,
  }
}

/**
 * 把字段名翻译成**用户看得懂的话**（只覆盖常见的几行；不知道就原样返回）。
 * @param rowId - 行的 patch id。
 * @param field - 字段名。
 * @returns 中文说法或原字段名。
 */
function plainField(rowId, field) {
  const known = {
    'ui-theme': { fontSize: '界面字号', preference: '明暗主题' },
    'agent-default-model': { model: '新会话的默认模型', provider: '模型提供方', reasoningEffort: '思考强度' },
    'session-query-sqlite': { openAt: '搜索索引的建立时机', path: '索引的存放位置' },
    'ui-chat': { transcriptView: '对话显示密度', performanceUsage: '性能用量显示' },
    'session-log-deepseek': { enabled: '会话日志开关' },
  }
  return known[rowId]?.[field] ?? field
}

/** 把常见的取值也翻译成人话（不知道就用 JSON 原样）。 */
function plainValue(rowId, field, value) {
  const known = {
    'session-query-sqlite|openAt': { startup: '启动时建（启动慢一点，搜索最快）', 'first-search': '第一次搜索时才建（启动不受影响）', never: '不建（搜索不可用）' },
    'agent-default-model|reasoningEffort': { max: '最高', high: '较高', medium: '中等', low: '较低' },
    'ui-theme|preference': { system: '跟随系统', light: '浅色', dark: '深色' },
  }
  const table = known[`${rowId}|${field}`]
  if (table !== undefined && table[value] !== undefined) return table[value]
  if (typeof field === 'string' && /key|token|secret|password|credential|env/i.test(field)) return '***'
  if (containsSensitiveKey(value)) return '***'
  return value === undefined ? '（默认值）' : JSON.stringify(value)
}

/**
 * 生成**给用户看的那几行**：短、通俗、按优先级排。
 *
 * 优先级（这是刻意的）：① 改什么 → ② 会不会打断你正在做的事 → ③ 要不要重启/何时生效
 * → ④ 能不能改回来 → ⑤ 影响范围。**其余一律不进这一段**（放进技术依据，避免认知负担）。
 *
 * @param params - 见调用处。
 * @returns 文本行数组。
 */
function userFacingSummary(params) {
  const { entry, changes, isReset, prediction, liveSessions } = params
  const rowId = String(entry?.options?.id ?? '?')
  const rowName = String(entry?.options?.name ?? '?')
  const lines = []
  if (isReset) {
    lines.push(`改什么：把「${rowId}」的配置复位（删掉你之前设过的值，回到出厂默认）`)
  } else {
    const what = changes.map((change) => `「${plainField(rowId, change.field)}」从 ${plainValue(rowId, change.field, change.from)} 改成 ${plainValue(rowId, change.field, change.to)}`).join('；')
    lines.push(`改什么：${what}`)
  }
  // ② 最关心的问题：会不会打断你正在做的事
  if (prediction.verdict === 'volatile-only') {
    lines.push(liveSessions === 0 || liveSessions === undefined
      ? '会不会打断你正在做的事：不会（这类设置可以热更新，不用重启这一项）'
      : `会不会打断你正在做的事：不会（这类设置可以热更新；此刻有 ${liveSessions} 条会话在跑，它们不受影响）`)
  } else if (prediction.verdict === 'rebuild') {
    lines.push(liveSessions === 0
      ? '会不会打断你正在做的事：不会（现在没有会话在跑；这一项会被重新加载，但它内部的状态会重置）'
      : `⚠️ 会不会打断你正在做的事：有可能 —— 这一项需要重新加载，而此刻有 ${liveSessions} 条会话正在跑`)
  } else {
    lines.push('会不会打断你正在做的事：不确定（拿不到这一项的内部信息；保守估计：可能影响正在跑的会话）')
  }
  // ③ 生效时机
  lines.push(prediction.verdict === 'volatile-only'
    ? '要不要重启：不用，改完当场生效'
    : prediction.verdict === 'rebuild'
      ? '要不要重启：一般不用（会重新加载这一行）；若没生效，先查该行是否被更高优先级覆盖、改动是否已被系统拾取（约 2 秒），或做一次关→开该 bundle 触发重组合复验；不要用重启兜底'
      : '要不要重启：不确定；先确认该行是否被更高优先级覆盖、改动是否已被系统拾取，不要用重启兜底')
  // ④ 回滚
  lines.push(isReset
    ? '能不能改回来：能（重新设一个值即可，同样先给你看预览）'
    : '能不能改回来：能（说一句"改回去"，或整项复位即可；改动只记在 DSH 的设置里，不动 DSH 本体）')
  // ⑤ 影响范围
  lines.push(rowName.includes('client') ? '影响范围：所有界面（界面会自动更新，无需刷新/重启；仅新增客户端半边时才需重启 App）' : '影响范围：所有会话（包括以后新建的）')
  return lines
}

/**
 * 生成**技术依据**（给 Agent 自己看，用户不需要读）。
 *
 * 这里保留完整的官方语义与边界，用于回答追问、排查失败；**不再倒给用户**。
 *
 * @param params - 见调用处。
 * @returns 文本行数组。
 */
function technicalDetails(params) {
  const { entry, override, next, changes, isReset, prediction, liveSessions } = params
  const rowId = String(entry?.options?.id ?? '?')
  const lines = []
  lines.push('写的是当前 profile 的 patch 层（用户层）：bundle 默认值不动，升级 DSH 不会丢。')
  lines.push(`volatile 判定：${prediction.verdict === 'volatile-only'
    ? `全部改动字段都是 volatile（${prediction.volatileFields.join(', ')}）→ Loader 走 fiber._config 就地更新，不 dispose`
    : prediction.verdict === 'rebuild'
      ? `含非 volatile 字段（${prediction.hotFields.join(', ')}）→ fiber.update() → dispose + 重新创建${prediction.active === true ? '（该行当前 active）' : ''}`
      : '拿不到 schema，无法预判'}。`)
  lines.push(`此刻活动会话数：${liveSessions === undefined ? '查不到' : liveSessions}。`)
  if (isReset) {
    lines.push('reset 语义：next 等于继承值时，官方 edit() 会删除该行的覆盖条目。')
  } else {
    const pinned = Object.keys(next).filter((field) => !(field in override) && !changes.some((change) => change.field === field))
    lines.push(pinned.length > 0
      ? `完整覆盖：以下未改字段会被钉在 profile 层（不再跟随 bundle 默认值）：${pinned.map((field) => `${field}=${JSON.stringify(maskSensitive(field, next[field]))}`).join(', ')}`
      : '完整覆盖：本次没有未改字段被钉在 profile 层。')
  }
  lines.push('官方通道：原子写入 + 失败自动回滚；保留 YAML 注释与 !!js 表达式；非法值在写入前被 schema 校验拒绝。')
  lines.push('并发：写入拿 profile 文件锁并与 HMR 串行；与其它 profile 操作（装卸插件等）互斥。')
  const nested = changes.some((change) => change.to !== null && typeof change.to === 'object' && !Array.isArray(change.to))
  if (nested) lines.push('注意：本工具只合并顶层字段；嵌套结构请整体给出那一层。')
  lines.push('本工具只能改已经存在的行；要新增一行（patch 的 insert，例如加一个 MCP server）不支持。新增需写 patch 层：profile/home patch 被 HMR watch，写入后约 2 秒自动重组合，技术上无需重启；若按本机安全规则选择先退出 App 再改，那是流程取舍，不是热生效能力限制。')
  lines.push(`只读行 / 嵌套 Include 行、home patch 或命令行 overlay 有更高优先级时会被官方拒绝（报错信息原样带回）。当前行：${rowId}。`)
  return lines
}

/**
 * 生成完整预览文本：**先给用户看的那几行**，再是技术依据。
 * @param params - 见调用处。
 * @returns 文本行数组。
 */
function configConsequences(params) {
  const user = userFacingSummary(params)
  const technical = technicalDetails(params)
  return [
    '———— 给用户看（照这个说，不要把下面的技术依据念给用户）————',
    ...user,
    '',
    '———— 技术依据（Agent 自己看，用户不需要）————',
    ...technical,
  ]
}

/**
 * 创建会话的**唯一内核**（只被 `dsh_session_manage start` 使用；2026-11-02 起没有第二条创建路径）。
 *
 * 步骤：解析工作区 → sessionController.create → title(+flush) → 补登记/回读 → 投递第一条指令。
 *
 * @param ctx - Host 上下文。
 * @param workbench - Workbench 实例（复用 requireWorkspace / registry）。
 * @param request - { workspaceId?, cwd?, agentPreset?, title?, prompt? }。
 * @returns { sessionId, cwd, workspaceId, workspaceTitle, createdThrough, accounted,
 *   attachFailed, applied, notes, preset }。
 */
async function createSessionViaController(ctx, workbench, request) {
  const workspaceId = request.workspaceId
  const cwdArg = request.cwd
  const agentPreset = typeof request.agentPreset === 'string' && request.agentPreset.trim() !== ''
    ? request.agentPreset.trim()
    : undefined
  const title = typeof request.title === 'string' ? request.title.trim() : ''
  const promptText = typeof request.prompt === 'string' ? request.prompt.trim() : ''
  const workspace = workspaceId !== undefined
    ? workbench.requireWorkspace(workspaceId)
    : await workbench.registry.resolveByPath(cwdArg).catch(() => undefined)
  const cwd = workspace?.path ?? cwdArg
  if (cwd === undefined) throw new Error('没有确定的工作区或目录，无法创建会话')

  const notes = []
  const applied = []
  const sessionId = `session-${globalThis.crypto.randomUUID()}`
  const controller = ctx.get('sessionController')
  const sessions = ctx.get('sessions')
  let session
  let created
  /** 这次建会话走的哪条路：`session-controller`（官方，会落盘）或 `session-store`（退化）。 */
  let createdThrough = 'session-store'
  if (typeof controller?.create === 'function') {
    created = await controller.create({
      sessionId,
      ...(workspace === undefined ? { cwd } : { workspaceId: workspace.id }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    createdThrough = 'session-controller'
    session = sessions?.get?.(created?.sessionId ?? sessionId)
  } else {
    if (sessions === undefined) {
      throw new Error('create 不可用：本部署既没有 sessionController.create，也没有 session store 服务')
    }
    session = sessions.create(sessionId, { meta: { cwd } })
    notes.push('⚠️ 本部署没有 sessionController.create，会话只发布未落盘：App 重启后会消失。')
  }
  const actualSessionId = created?.sessionId ?? sessionId
  const actualPreset = created?.agentPreset ?? agentPreset
  if (agentPreset !== undefined) applied.push(`preset=${actualPreset ?? agentPreset}`)

  if (title !== '') {
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) {
      notes.push('本部署没有挂载 session-title 服务，标题未写入，稍后可在侧边栏改名。')
    } else if (session === undefined) {
      notes.push(`标题未写入：拿不到刚建好的会话实例（会话 ${actualSessionId} 已创建）。`)
    } else {
      try {
        titles.rename(session, title)
        // 改名后 flush：否则冷会话投影缓存为空，侧边栏会显示成「新会话」（2026-10-14 实测）。
        await sessions?.flush?.(session)
      } catch (error) {
        degradeOrRethrow(error, strictOf(ctx))
        notes.push(`标题写入失败（会话已建好）：${messageOf(error)}`)
      }
    }
  }

  // 归组：官方 create 在带 workspaceId 时自己 attach；只给 cwd 时不会，需要这里补。
  const attachedByController = createdThrough === 'session-controller' && workspace !== undefined
  let attachFailed = false
  let accounted = attachedByController
  if (workspace !== undefined && !attachedByController) {
    try {
      await workspace.attachSession(actualSessionId)
      accounted = true
    } catch (error) {
      attachFailed = true
      degradeOrRethrow(error, strictOf(ctx))
      notes.push(`会话已建好，但登记到工作区失败：${messageOf(error)}`)
    }
  }
  if (workspace !== undefined && attachedByController) {
    accounted = [...workbench.registry.list()]
      .find((entry) => entry.id === workspace.id)?.sessionIds.includes(actualSessionId) === true
    if (!accounted) notes.push('⚠️ 官方 create 未把会话登记进该工作区（成员表核验未通过）。')
  }

  if (promptText !== '') {
    if (createdThrough === 'session-controller') {
      // 立刻投第一条指令：新会话那一行被画出来时就已经在干活了。
      await admitPrompt(ctx, actualSessionId, promptText)
      applied.push('prompt=queued')
    } else {
      notes.push('本部署没有官方创建路径，无法自动开工：请在界面里发第一句话。')
    }
  }

  return {
    sessionId: actualSessionId,
    cwd,
    workspaceId: workspace?.id ?? null,
    workspaceTitle: workspace?.title ?? null,
    createdThrough,
    accounted,
    attachFailed,
    applied,
    notes,
    preset: actualPreset ?? null,
  }
}

/**
 * 注册 `dsh_workspace_manage`、`dsh_session_manage` 与 `dsh_config_manage` 三个工具。
 * @param ctx - 带 `tools` / `workspaceRegistry` / `sessionQuery` 的上下文。
 */
export function apply(ctx, config = {}) {
  // 供 helper 函数读取的严格模式标记（Workbench 实例另有 this.strictErrors）。
  ctx.__workbenchStrictErrors = config?.strictErrors === true
  const workbench = new Workbench(ctx, config)

  /* -------------------------- 工作区工具 -------------------------- */

  ctx.tools.register(withAnnounce(defineTool({
    name: 'dsh_workspace_manage',
    description:
      'List, inspect, create, rename, reorder, or remove DSH workspace registrations (sidebar groups). '
      + 'remove only unregisters: directory and session history stay on disk. '
      + 'For session order use dsh_session_manage reorder. '
      + 'A workspace is a named project directory plus the sessions that ran in it; it is what the sidebar groups by. '
      + 'Scope split: this tool manages WORKSPACES; dsh_session_manage manages the SESSIONS inside them — to hide '
      + 'one conversation, archive that session, do not remove its workspace. '
      + '`reorder` here is WORKSPACE order (sidebar group order); session order inside a workspace is '
      + 'dsh_session_manage reorder. '
      + 'All writes go through the running Harness itself, so the change is live in the GUI immediately. '
      + 'Before remove or reorder, tell the user which workspace you are about to touch and confirm. '
      + 'The create action only accepts a directory that already exists; it never creates one, '
      + 'so if the directory is missing, ask the user how to proceed.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'create', 'rename', 'reorder', 'remove'],
        description: 'Which workspace operation to run. `reorder` = workspace order in the sidebar (session order '
          + 'is dsh_session_manage reorder). `remove` = unregister only — files and session history stay; it is not '
          + 'a delete and requires user confirmation.',
        required: true,
      },
      workspaceId: {
        type: 'string',
        description: 'Target workspace id. Required by get, rename, reorder, and remove.',
      },
      path: {
        type: 'string',
        description: 'Absolute path of an existing directory. Required by create (it never creates the directory). '
          + 'Ignored by get — get takes workspaceId.',
      },
      title: {
        type: 'string',
        description: 'New display title. Required by rename. Titles are not unique in the registry, but a blank one is rejected.',
      },
      order: {
        type: 'array',
        items: { type: 'string' },
        description: 'Complete desired workspace id order for reorder, exactly matching the current set.',
      },
      showIds: {
        type: 'boolean',
        description: 'Return full workspace ids instead of shortened previews. Defaults to false.',
      },
    },
    output: OUTPUT,
    /**
     * @param args - 已校验的模型参数。
     * @param exec - 工具执行上下文，`exec.signal` 是调用方取消信号。
     * @returns 声明过的输出值。
     */
    async execute(args, exec) {
      const action = args.action
      const showIds = args.showIds === true

      if (action === 'list') {
        const workspaces = workbench.registry.list()
        const archived = workbench.archived
        const pinned = workbench.pinned
        const rows = []
        for (const workspace of workspaces) {
          const members = [...workspace.sessionIds]
          rows.push({
            workspaceId: workspace.id,
            displayId: shortId(workspace.id, showIds),
            title: workspace.title,
            path: workspace.path,
            sessionCount: members.length,
            activeSessionCount: members.filter((id) => !archived.has(id)).length,
            pinnedSessionCount: members.filter((id) => pinned.has(id)).length,
            directory: await workspace.status(),
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          })
        }
        const owner = workbench.ownership()
        const allIds = new Set((await workbench.query.listSessions(exec.signal)).map((record) => record.header.id))
        const ungroupedCount = [...allIds].filter((id) => !owner.has(id)).length
        const lines = rows.map((row, index) => `${index + 1}. ${row.title} — ${row.displayId} — ${row.path}`
          + ` — ${row.sessionCount} 个会话（${row.activeSessionCount} 未归档）`
          + `${row.directory === 'missing-dir' ? ' — ⚠ 目录不存在' : ''}`)
        return result('list', [
          `共 ${rows.length} 个工作区（顺序即侧边栏顺序）：`,
          ...lines,
          `未分组会话：${ungroupedCount} 个`,
          `归档会话：${archived.size} 个；置顶会话：${pinned.size} 个`,
        ].join('\n'), { workspaces: rows, ungroupedCount, archivedCount: archived.size, pinnedCount: pinned.size })
      }

      if (action === 'get') {
        const workspace = workbench.requireWorkspace(args.workspaceId)
        const members = [...workspace.sessionIds]
        // 归属是确定的：这些 id 就登记在这个工作区下，直接写进 known 表，
        // 免得 describeSessions 猜不出归属。
        const known = new Map(members.map((id) => [id, { workspaceId: workspace.id }]))
        const infos = await workbench.describeSessions(members, { showIds, signal: exec.signal, known })
        const pinned = workbench.pinned
        const archived = workbench.archived
        const lines = infos.map((info, index) => `${index + 1}. ${info.title ?? '（无标题）'} — ${info.displayId}`
          + ` — ${info.createdAt ?? '?'}`
          + `${archived.has(info.sessionId) ? ' [已归档]' : ''}${pinned.has(info.sessionId) ? ' [置顶]' : ''}`)
        const directory = await workspace.status()
        return result('get', [
          `${workspace.title} — ${workspace.id}`,
          `路径：${workspace.path}${directory === 'missing-dir' ? '（⚠ 目录不存在）' : ''}`,
          `创建：${workspace.createdAt}；最后更新：${workspace.updatedAt}`,
          `会话（${infos.length}，顺序即侧边栏顺序）：`,
          ...(lines.length > 0 ? lines : ['（无）']),
        ].join('\n'), {
          workspace: {
            workspaceId: workspace.id,
            title: workspace.title,
            path: workspace.path,
            directory,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          },
          sessions: infos,
        })
      }

      if (action === 'create') {
        const path = typeof args.path === 'string' ? args.path.trim() : ''
        if (path === '') throw new Error('create 需要 path')
        const existing = await workbench.registry.resolveByPath(path)
        if (existing !== undefined) {
          return result('create', `该目录已经注册过了，未改动：${existing.title} — ${existing.id} — ${existing.path}`, {
            workspace: { workspaceId: existing.id, title: existing.title, path: existing.path },
            created: false,
          })
        }
        const workspace = await workbench.registry.create(path)
        return result('create', `已注册工作区：${workspace.title} — ${workspace.id} — ${workspace.path}`, {
          workspace: { workspaceId: workspace.id, title: workspace.title, path: workspace.path },
          created: true,
        })
      }

      if (action === 'rename') {
        const workspace = workbench.requireWorkspace(args.workspaceId)
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        if (title === '') throw new Error('rename 需要非空的 title')
        const before = workspace.title
        if (before === title) {
          return result('rename', `${describeWorkspace(workspace)}：标题已经是 "${title}"，未改动。`)
        }
        await workspace.setTitle(title)
        return result('rename', `已重命名：${describeWorkspace(workspace)}（原名 "${before}"）`)
      }

      if (action === 'reorder') {
        const order = Array.isArray(args.order) ? args.order : []
        const current = workbench.registry.list().map((entry) => entry.id)
        if (order.length === 0) throw new Error('reorder 需要 order（工作区 id 的完整新顺序）')
        const wanted = new Set(order)
        if (wanted.size !== order.length) throw new Error('order 里有重复的工作区 id')
        if (wanted.size !== current.length || current.some((id) => !wanted.has(id))) {
          throw new Error(`order 必须恰好覆盖当前全部 ${current.length} 个工作区（用 action: list 取最新列表后重试）`)
        }
        for (const id of order) workbench.requireWorkspace(id)
        const moved = await Workbench.applyOrder(order, async (id, beforeId) => {
          await workbench.registry.insertBefore(id, beforeId)
        })
        const applied = workbench.registry.list().map((entry) => entry.id)
        return result('reorder', `已按新顺序排列 ${moved} 个工作区：\n`
          + applied.map((id, index) => `${index + 1}. ${workbench.registry.get(id)?.title ?? id} — ${shortId(id, showIds)}`).join('\n'), {
          workspaceIds: applied,
        })
      }

      if (action === 'remove') {
        const workspace = workbench.requireWorkspace(args.workspaceId)
        const description = describeWorkspace(workspace)
        const ok = await workbench.registry.delete(workspace.id)
        if (!ok) throw new Error(`删除失败：找不到工作区 "${workspace.id}"`)
        return result('remove', `已移除工作区注册（目录与全部会话历史均保留）：${description}`)
      }

      throw new Error(`未知 action "${action}"`)
    },
  }), workbench))

  /* --------------------------- 会话工具 --------------------------- */

  ctx.tools.register(withAnnounce(defineTool({
    name: 'dsh_session_manage',
    timeoutMs: 35 * 60 * 1000,
    description:
      'Send a message to an existing DSH session, or manage sessions: steer vs queue, wait/notify, read, start, '
      + 'cancel, archive. send = next turn; steer = redirect the turn running NOW; queue = inspect pending only, '
      + 'never sends. '
      + 'MESSAGING: `send` delivers an instruction for the session\'s NEXT turn (idle: starts working now; running: '
      + 'queues behind the current turn, non-disruptive). `steer` injects into the turn the target is running '
      + 'RIGHT NOW, adopted at its next step — only to redirect / correct / stop work in flight; when the target '
      + 'is idle (or its state cannot be read) the tool resolves it to queue instead and says so. `queue` '
      + 'inspects/edits/removes messages that are ALREADY pending — it never sends new text, so never pass a '
      + 'prompt to it. `list` and `get` report whether a turn is running (mark 运行中 vs 已加载). If the target is '
      + 'running and you are unsure which the user wants, use `send` — it is non-disruptive; the result reports '
      + 'the state and, if the intent was to redirect, how to promote the queued message with `queueAction: steer` '
      + '(never re-send). '
      + '`list`: without `workspaceId`/`cwd` it returns a compact per-workspace summary and tells you to pass a '
      + '`workspaceId` (ids from dsh_workspace_manage list) — it does NOT dump every session; `workspaceId`/`cwd` '
      + 'lists one workspace (default 50); `ungrouped`/`archived`/`kind` return the flat list. `start` creates a '
      + 'real, durable session and sends its first instruction (`prompt`, required); it requires an explicit '
      + '`workspaceId` or `cwd` (the tool never guesses where a session belongs); optional `agentPreset` picks the '
      + 'preset at creation — choose it deliberately per task (rules in the agentPreset parameter) or omit it to '
      + 'use the user\'s configured default. There is deliberately no blank-session action: a session that never starts working has '
      + 'no activity frames, so its sidebar row only appears after the next page load (use the GUI New Session). '
      + '`wait` blocks this turn until the target turn ends (default 90s; keep it short); for long background work '
      + 'use `notify` (register once, end this turn, get woken when the worker finishes); `cancel` stops the running '
      + 'turn and keeps the pending inbox. `read` reads recent messages (beforeSeq pages older); `search` finds '
      + 'sessions by literal content (needs the session-query index). '
      + '`fork` copies a session cold (send to make it work). `attach` is the only repair path for workspace '
      + 'accounting (registers an existing session in a matching workspace; never moves one). `rename` is the ONLY '
      + 'action that needs a live session: unloaded sessions are refused unless resume:true (loads, renames, '
      + 'and releases in one call; the session does not stay live; tell the user first); '
      + '`pin`/`unpin`/`archive`/`unarchive` need no live session, and '
      + 'archive refuses a session with running work. `reorder`/`sort` change session order inside a workspace '
      + '(workspace order is dsh_workspace_manage reorder); `openPath` opens a directory. Child sessions (origin: '
      + 'subagent) accept no send/steer (fenced with session/agent-busy: use the subagents domain); only their '
      + 'pending queue can be inspected/edited. Before any write action, tell the user which sessions are affected '
      + 'and confirm. '
      + 'CURSOR: send/steer/read/wait return `cursor` (an event seq); pass it to read/wait as `after` to see only '
      + 'what happened after that point. `wait` takes until: reply (a new complete assistant reply) | step (one '
      + 'completed step: tool result or reply) | done (turn end, default); a timeout returns the partial content '
      + 'collected plus `idleForMs`, never an error.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'start', 'send', 'steer', 'cancel', 'wait', 'notify', 'queue', 'search', 'read', 'fork', 'attach', 'rename', 'reorder', 'sort', 'pin', 'unpin', 'archive', 'unarchive', 'openPath', 'model'],
        description: 'Which session operation to run. '
          + 'MESSAGE DELIVERY — `send` = next turn (idle starts now; running target queues behind the current turn, '
          + 'non-disruptive); `steer` = inject into the turn running NOW at its next step (only to redirect/correct/'
          + 'stop work in flight; idle target resolves to queue); `queue` = inspect/edit/remove messages ALREADY '
          + 'pending, never sends. Check running state with list/get; if the intent is unclear on a running target, '
          + 'prefer send (if you meant to redirect, promote the queued message with queueAction: steer — do not '
          + 're-send). '
          + 'CREATION — `start` = new session + first instruction; explicit workspaceId or cwd required (never '
          + 'guessed); no blank-session action. '
          + 'WAITING — `wait` blocks until the target finishes (keep short); `notify` wakes you later; `cancel` '
          + 'stops the turn but keeps the inbox. '
          + 'Naming traps: `reorder` here is SESSION order inside a workspace (workspace order is '
          + 'dsh_workspace_manage reorder); there is no `remove` here — archive sessions.',
        required: true,
      },
      sessionId: {
        type: 'string',
        description: 'Target session id. Required by get/send/steer/cancel/wait/notify/queue/read/fork/attach/'
          + 'rename/pin/unpin/archive/unarchive/model.',
      },
      workspaceId: {
        type: 'string',
        description: 'Workspace id. Required by start/attach (both also accept cwd); lists that workspace\'s '
          + 'sessions; required by reorder/sort; openPath accepts it instead of path.',
      },
      title: {
        type: 'string',
        description: 'New session title (start) or new title (rename). Required by rename.',
      },
      prompt: {
        type: 'string',
        description: 'start: first instruction (required — makes the session start working). send: text for the '
          + 'NEXT turn (queued behind a running turn; starts immediately when idle). steer: injected into the '
          + 'running turn at its next step.',
      },
      query: {
        type: 'string',
        description: 'search: literal message-content query (needs the deployment session-query index; a closed '
          + 'index returns the official error).',
      },
      path: {
        type: 'string',
        description: 'openPath: absolute directory to open in the Host file manager. Alternative to workspaceId.',
      },
      reveal: {
        type: 'boolean',
        description: 'openPath: reveal (select) instead of opening. Defaults to false.',
      },
      provider: {
        type: 'string',
        description: 'model: provider id, e.g. "deepseek-account".',
      },
      model: {
        type: 'string',
        description: 'model: model id for this session.',
      },
      agentPreset: {
        type: 'string',
        description: 'start: preset for the new session. Omit to use the user\'s configured default. Pick per task: '
          + '`cordis` (Creator) for DSH plugin/preset/config work — the only preset that registers plugin_manager, '
          + 'cordis_inspect and the official DSH dev skills; `ptc` for code-mode orchestration (the model gets '
          + 'run_code + a generated SDK instead of tool schemas; many tool calls or large data); `minimal` for '
          + 'shell-only / harness-debug tasks (smallest context, persistent shell); `standard` for a clean '
          + 'baseline without plugin-install ability. The preset is fixed at creation, so a wrong pick means '
          + 'starting another session.',
      },
      resume: {
        type: 'boolean',
        description: 'rename: load an unloaded session, rename it, release it again in one call (ends unloaded). '
          + 'Ask the user first. Defaults to false.',
      },
      cwd: {
        type: 'string',
        description: 'Absolute directory. start: build here. attach: resolve the target workspace from here. list: '
          + 'alternative to workspaceId (must be a registered workspace).',
      },
      ungrouped: {
        type: 'boolean',
        description: 'list: only sessions in no workspace; returns the flat list. Defaults to false.',
      },
      archived: {
        type: 'boolean',
        description: 'list: true = archived only, false = unarchived only; returns the flat list.',
      },
      kind: {
        type: 'string',
        enum: ['session', 'subagent'],
        description: 'list: filter by session kind; returns the flat list.',
      },
      limit: {
        type: 'number',
        description: 'list: max rows (50; the grouped summary caps 30 workspaces). read: max messages. search: max '
          + 'hits (8 — the official search cannot cap its own count).',
      },
      showIds: {
        type: 'boolean',
        description: 'Return full session / workspace ids instead of shortened previews. Defaults to false.',
      },
      order: {
        type: 'array',
        items: { type: 'string' },
        description: 'reorder: complete desired session id order inside the workspace.',
      },
      by: {
        type: 'string',
        enum: ['title', 'created-desc', 'created-asc'],
        description: 'sort: ordering key. Defaults to title.',
      },
      reverse: {
        type: 'boolean',
        description: 'sort: reverse the computed order. Defaults to false.',
      },
      from: {
        type: 'string',
        description: 'sort: only sessions created at or after this local time.',
      },
      to: {
        type: 'string',
        description: 'sort: only sessions created at or before this local time.',
      },
      timeoutMs: {
        type: 'number',
        description: 'wait: maximum time to block in milliseconds (default 90000 = 90s; capped at 1800000 = 30 min). '
          + 'Keep it short — it occupies this tool call and this turn.',
      },
      beforeSeq: {
        type: 'number',
        description: 'read: page messages before this event seq.',
      },
      after: {
        type: 'number',
        description: 'read/wait: only consider events with seq greater than this cursor (returned by send/steer/read/wait).',
      },
      until: {
        type: 'string',
        enum: ['reply', 'step', 'done'],
        description: 'wait: stop condition — reply = a new complete assistant reply; step = one completed step '
          + '(tool result or reply); done = the whole turn ends (default).',
      },
      queueAction: {
        type: 'string',
        enum: ['list', 'edit', 'remove', 'steer'],
        description: 'queue: manages messages that are ALREADY pending (next-turn / next-step inbox) — it never '
          + 'adds a new message; use send for that. list shows the inbox; edit/remove/steer one item by itemId '
          + '(steer moves a queued next-turn item into the running turn\'s next step, like QueueDock Steer).',
      },
      itemId: {
        type: 'string',
        description: 'queue: id of the queued message to edit/remove/steer (from queueAction: list).',
      },
      content: {
        type: 'string',
        description: 'queue edit: replacement text for the queued message.',
      },
    },
    output: OUTPUT,
    /**
     * @param args - 已校验的模型参数。
     * @param exec - 工具执行上下文，`exec.signal` 是调用方取消信号。
     * @returns 声明过的输出值。
     */
    async execute(args, exec) {
      const action = args.action
      const showIds = args.showIds === true

      /* ---------------- 读 ---------------- */

      if (action === 'list') {
        const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.trim() !== ''
          ? args.workspaceId.trim()
          : undefined
        const cwdArg = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : undefined
        if (workspaceId !== undefined && cwdArg !== undefined) {
          throw new Error('list 只能给 workspaceId 或 cwd 其中之一')
        }
        // `cwd` 是 `workspaceId` 的另一种写法：按目录反查已注册的工作区（与 create / attach 同一套语义）。
        const scope = workspaceId ?? (cwdArg === undefined
          ? undefined
          : (await workbench.registry.resolveByPath(cwdArg).catch(() => undefined))?.id)
        if (scope === undefined && cwdArg !== undefined) {
          const known = workbench.registry.list().map((entry) => `"${entry.title}" (${entry.path})`).join('、')
          throw new Error(`目录 "${cwdArg}" 还没有注册为工作区，无法按目录列会话。`
            + `已注册的工作区：${known || '（无）'}。`
            + '先用 dsh_workspace_manage 的 create 注册该目录，或直接传 workspaceId。')
        }

        // 显式行级过滤（ungrouped / archived / kind）仍然返回扁平列表——那是调用方
        // **明确要的行**，不是"随便列一下"。没有这些过滤、也没有 workspaceId/cwd 时
        // 才走摘要：本机 520 条全量会话铺出来只会把模型带偏（见 LIST_SCOPE_HINT）。
        const rowFiltered = args.ungrouped === true || args.archived !== undefined || args.kind !== undefined
        if (scope === undefined && !rowFiltered) {
          const summary = await workbench.summarizeWorkspaces({
            signal: exec.signal,
            limit: args.limit,
            showIds,
          })
          return result('list', renderWorkspaceSummary(summary), {
            grouped: true,
            hint: LIST_SCOPE_HINT,
            ...summary,
          })
        }

        const { rows, fetchError } = await workbench.collect({
          workspaceId: scope,
          ungrouped: args.ungrouped === true,
          archived: args.archived,
          kind: args.kind,
          showIds,
          signal: exec.signal,
        })
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
          ? Math.floor(args.limit)
          : DEFAULT_LIST_LIMIT
        const visible = rows.slice(0, limit)
        const scopeTitle = scope === undefined ? undefined : workbench.registry.get(scope)?.title
        const scopeLabel = scope === undefined ? '' : `工作区："${scopeTitle ?? scope}" —— `
        const shownNote = rows.length > visible.length ? `，显示前 ${visible.length} 个（用 limit 调大）` : ''
        const header = `${scopeLabel}共 ${rows.length} 个会话${shownNote}：`
        const body = visible.map((row) => {
          const name = row.workspaceId === undefined
            ? '未分组'
            : `"${workbench.registry.get(row.workspaceId)?.title ?? row.workspaceId}"`
          return `${Workbench.renderRow(row, showIds)} — ${name}`
        })
        const titleNote = fetchError === true
          ? ['⚠️ 部分标题读取失败：列表仍可用，标题显示为空/未知（刷新可重试）。']
          : []
        return result('list', [header, ...(body.length > 0 ? body : ['（无）']), ...titleNote].join('\n'), {
          total: rows.length,
          titleFetchFailed: fetchError === true,
          sessions: visible,
          ...(scope === undefined ? {} : { workspaceId: scope, workspaceTitle: scopeTitle ?? null }),
        })
      }

      if (action === 'get') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('get 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const all = await workbench.query.listSessions(exec.signal)
        const listed = all.find((record) => record.header.id === sessionId)
        if (listed === undefined) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        const workspace = [...workbench.registry.list()].find((entry) => entry.sessionIds.includes(sessionId))
        // 把查到的真实状态喂给 describeSessions，免得它把冷会话当成活动会话。
        const known = new Map([[sessionId, {
          createdAtMs: listed.header.createdAt,
          cwd: listed.header.cwd ?? null,
          origin: listed.header.origin ?? null,
          parentSession: listed.header.parentSession ?? null,
          live: listed.live === true,
          persisted: listed.persisted === true,
          workspaceId: workspace?.id ?? null,
          kind: listed.header.origin === 'subagent' ? 'subagent' : 'session',
        }]])
        const [info] = await workbench.describeSessions([sessionId], { showIds: true, signal: exec.signal, known })
        const archived = workbench.archived.has(sessionId)
        const pinned = workbench.pinned.has(sessionId)
        // header.agentPreset 是创建事实；当前值要从 `agentPreset` Session projection 读
        // （见 readCurrentPreset 的注释：迁移脚本改的是 projection 事件，不改 header）。
        const headerPreset = listed.header.agentPreset ?? null
        const current = await readCurrentPreset(ctx, sessionId)
        const currentPreset = current === undefined ? undefined : current.value
        const presetLine = current === undefined
          ? `${headerPreset ?? '（默认）'}（创建时；当前值读不到）`
          : `${currentPreset ?? '（默认）'}${currentPreset === headerPreset ? '' : `（创建时：${headerPreset ?? '（默认）'}）`}`
        // 运行状态 + 待处理队列：模型决定 send / steer 时需要的就是这两个事实，
        // 由工具一次读全，免得模型去猜或再调用一次 list。
        const running = runningStateOf(ctx, sessionId)
        const inbox = inboxStateOf(ctx, sessionId)
        const lines = [
          `会话：${info?.title ?? '（无标题）'}`,
          `id：${sessionId}`,
          `创建：${formatTime(listed.header.createdAt)}`,
          `工作区：${workspace === undefined ? '未分组' : `${workspace.title} (${workspace.id})`}`,
          `目录：${listed.header.cwd ?? '（无）'}`,
          `状态：${listed.live ? '已加载' : '未加载'}；${listed.persisted ? '已持久化' : '未持久化（内存中）'}`,
          `运行：${running === true ? '正在跑一个 turn' : running === false ? '空闲（没有在跑的 turn）' : '未知（本部署读不到运行状态）'}`,
          ...(inbox === undefined
            ? []
            : [`待处理队列：下一轮 ${inbox.nextTurn} 条 / 下一步 ${inbox.nextStep} 条（详情用 action: queue）`]),
          `置顶：${pinned ? '是' : '否'}；归档：${archived ? '是' : '否'}`,
          `来源：${listed.header.origin ?? '普通会话'}${listed.header.isSeeded ? '（来自 fork）' : ''}`,
          `父会话：${listed.header.parentSession ?? '（无）'}`,
          `Agent preset：${presetLine}`,
        ]
        return result('get', lines.join('\n'), {
          session: {
            sessionId,
            title: info?.title ?? null,
            createdAt: formatTime(listed.header.createdAt),
            workspaceId: workspace?.id ?? null,
            cwd: listed.header.cwd ?? null,
            live: listed.live === true,
            persisted: listed.persisted === true,
            running: running ?? null,
            ...(inbox === undefined ? {} : { nextTurn: inbox.nextTurn, nextStep: inbox.nextStep }),
            pinned,
            archived,
            parentSession: listed.header.parentSession ?? null,
            origin: listed.header.origin ?? null,
            isSeeded: listed.header.isSeeded === true,
            agentPreset: currentPreset ?? headerPreset,
            agentPresetReadable: current !== undefined,
            createdWithPreset: headerPreset,
          },
        })
      }

      /* ---------------- 新建（唯一创建入口：必须显式位置 + 首条指令） ---------------- */

      if (action === 'start') {
        const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.trim() !== ''
          ? args.workspaceId.trim()
          : undefined
        const cwdArg = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : undefined
        if (workspaceId !== undefined && cwdArg !== undefined) {
          throw new Error('start 只能给 workspaceId 或 cwd 其中之一')
        }
        if (workspaceId === undefined && cwdArg === undefined) {
          throw new Error('start 需要 workspaceId 或 cwd（本机没有默认目录回退，避免猜错位置）')
        }
        // 保持旧的校验顺序：先解析工作区（未知工作区/坏目录在这里报错或降级），再校验 prompt。
        const workspace = workspaceId === undefined
          ? await workbench.registry.resolveByPath(cwdArg).catch(() => undefined)
          : workbench.requireWorkspace(workspaceId)
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        /** 第一条指令：给了就让新会话当场开工（用户要的就是这个，而不是建一块空地）。 */
        const promptText = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        // `start` **一律要求 prompt**（用户 2026-10-15 的意见：这个动作的语义里就不含空会话）。
        //
        // 为什么这个动作里没有"建空会话"这回事：空会话没有 `api-session/status` / `activity` 这类
        // **活动帧**，客户端不会 upsert 它那一行——界面上要等下次页面加载才出现，很容易被
        // 当成"没建成功"。而"先建好、等下自己写第一句"这件事，界面自己的「新建会话」按钮
        // 以及 DSH 每个工作区本来就维持的"可复用空白会话"已经覆盖了，本工具不需要再做一遍。
        if (promptText === '') {
          // 兜底（正常调用不该走到这里）：`start` 的语义就是"建一条会话并让它开工"，prompt 是它的必需参数。
          throw new Error('start 需要 prompt：这个动作就是"新建一条会话并让它开始干活"，'
            + 'prompt 是它的第一条指令。需要一条空会话请在界面里用「新建会话」（空白会话没有 activity 帧，'
            + '工具建出来在侧边栏可能看不到，所以本工具不提供这个动作）。')
        }

        const created = await createSessionViaController(ctx, workbench, {
          workspaceId,
          cwd: cwdArg,
          agentPreset: typeof args.agentPreset === 'string' ? args.agentPreset : undefined,
          title,
          prompt: promptText,
        })
        const sessionId = created.sessionId
        const cwd = created.cwd
        const createdWorkspaceId = created.workspaceId
        const workspaceTitle = created.workspaceTitle
        const createdThrough = created.createdThrough
        const accounted = created.accounted
        const attachFailed = created.attachFailed
        const notes = created.notes
        const lines = [
          `已新建会话 ${sessionId}${title === '' ? '' : ` —— ${title}`}`,
          `目录：${cwd}`,
          `工作区：${createdWorkspaceId === null ? '未分组（该目录未注册为工作区；用 dsh_workspace_manage 的 create 注册后，新会话才会自动归组）' : workspaceTitle}${attachFailed ? '（注意：登记失败，实际仍未分组）' : ''}`,
          createdThrough === 'session-controller'
            ? '这条会话已经落盘，并且**已经开始干活**（第一条指令已投递，不需要用户再说什么）。'
            : '会话已发布但未开始任何 turn，用户在界面里输入第一句话即可。',
          ...notes,
          '这条会话从空日志开始：要读回它的回复，用 action: read（after: -1）或 action: wait（after: -1, until: reply|step|done）。',
        ]
        return result('start', lines.join('\n'), {
          sessionId,
          title: title === '' ? null : title,
          cwd,
          workspaceId: createdWorkspaceId,
          createdThrough,
          accounted,
          cursor: -1,
        })
      }

      /* ---------------- 补登记（attach） ---------------- */

      // 归属的**唯一**补救路径：把一条已存在的会话登记进工作区，不创建任何东西。
      // 为什么需要它：归属只在创建那一刻决定，而 `create` 过去在只给 cwd 时会静默落进
      // "未分组"（2026-10-11 修复）。没有这个动作，已经建错的会话就只能弃用重开。
      // 它**不是搬家**：已归属别处的会话直接拒绝；目录与目标工作区不符也拒绝。
      if (action === 'attach') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('attach 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.trim() !== ''
          ? args.workspaceId.trim()
          : undefined
        const cwdArg = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : undefined
        if (workspaceId !== undefined && cwdArg !== undefined) {
          throw new Error('attach 只能给 workspaceId 或 cwd 其中之一')
        }
        if (workspaceId === undefined && cwdArg === undefined) {
          throw new Error('attach 需要 workspaceId 或 cwd 指定目标工作区')
        }

        const all = await workbench.query.listSessions(exec.signal)
        const listed = all.find((record) => record.header.id === sessionId)
        if (listed === undefined) {
          throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        }

        // 工作区按目录认领会话，所以先算清"现在归谁"，再决定能不能补。
        const owner = [...workbench.registry.list()].find((entry) => entry.sessionIds.includes(sessionId))
        if (owner !== undefined) {
          if (workspaceId !== undefined && owner.id === workspaceId) {
            throw new Error(`该会话已经登记在工作区 "${owner.title}" (${owner.id}) 里，没有改动`)
          }
          throw new Error(`该会话已归属工作区 "${owner.title}" (${owner.id})；本工具不做跨工作区搬家`
            + `（归属跟随会话运行目录，换组只能换目录后新建）`)
        }

        const workspace = workspaceId !== undefined
          ? workbench.requireWorkspace(workspaceId)
          : await workbench.registry.resolveByPath(cwdArg).catch(() => undefined)
        if (workspace === undefined) {
          const known = workbench.registry.list().map((entry) => `${entry.title} (${entry.id})`).join('、')
          throw new Error(`目录 "${cwdArg}" 还没有注册为工作区，无法登记。已注册的工作区：${known || '（无）'}。`
            + `先用 dsh_workspace_manage 的 create 注册该目录，再重试 attach。`)
        }

        // 先把"目录是否相符"讲清楚，避免把不匹配的会话塞进组里、之后被注册表静默过滤掉。
        // 注意：注册表的目录比较走 `realpathNormalize`（唯一 canon：尾斜杠、`..`、符号链接都会解析），
        // 所以这里绝不能用字符串直接比——`create` 收的就是用户原始路径，`/x/y/` 与 `/x/y` 会误判。
        // 动态 import：本插件的静态裸包 import 会给"假 DSH"验证器添麻烦，且这条路径只在 attach 时用到。
        // 取不到时降级为字符串比较（宁可多拒一次，也不做静默的错误登记）。
        let sameCwd = (left, right) => left === right
        try {
          const { realpathNormalize } = await import('@deepseek-ai/dsh-workspace')
          sameCwd = (left, right) => realpathNormalize(left).then((canon) => canon === right, () => false)
        } catch { /* 非 dsh 环境（如假 DSH 验证）：保留字符串比较 */ }

        const sessionCwd = listed.header.cwd ?? null
        if (sessionCwd === null) {
          throw new Error(`会话 "${sessionId}" 的记录里没有目录，无法与工作区 "${workspace.title}" 比对，已拒绝`)
        }
        if (!await sameCwd(sessionCwd, workspace.path)) {
          throw new Error(`目录不匹配：会话运行在 "${sessionCwd}"，而工作区 "${workspace.title}" 的目录是 `
            + `"${workspace.path}"。归属跟随目录，所以不能把它登记进这个工作区。`)
        }

        try {
          await workspace.attachSession(sessionId)
        } catch (error) {
          throw new Error(`登记失败：${messageOf(error)}`)
        }

        const known = new Map([[sessionId, {
          createdAtMs: listed.header.createdAt,
          cwd: sessionCwd,
          origin: listed.header.origin ?? null,
          parentSession: listed.header.parentSession ?? null,
          live: listed.live === true,
          persisted: listed.persisted === true,
          workspaceId: workspace.id,
          kind: listed.header.origin === 'subagent' ? 'subagent' : 'session',
        }]])
        const [info] = await workbench.describeSessions([sessionId], { showIds: true, signal: exec.signal, known })

        // 回读成员表核验，而不是假定 attach 成功。
        const accounted = [...workbench.registry.list()]
          .find((entry) => entry.id === workspace.id)?.sessionIds.includes(sessionId) === true
        return result('attach', [
          `已把会话登记进工作区：${info?.title ?? '（无标题）'} (${sessionId})`,
          `工作区：${workspace.title} (${workspace.id})`,
          `目录：${sessionCwd}`,
          `成员表核验：${accounted ? `已出现"${workspace.title}"的 sessionIds 里` : '⚠️ 未在成员表里找到，可能被注册表过滤，请用 list 复查'}`,
          `位置：工作区队首（注册表的 attachSession 语义）`,
        ].join('\n'), {
          session: {
            sessionId,
            title: info?.title ?? null,
            workspaceId: workspace.id,
            cwd: sessionCwd,
            accounted,
            createdAt: formatTime(listed.header.createdAt),
          },
        })
      }

      /* ---------------- 写 ---------------- */

      if (action === 'rename') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('rename 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        if (title === '') throw new Error('rename 需要非空的 title')
        const titles = ctx.get('sessionTitle')
        if (titles === undefined) throw new Error('rename 不可用：本部署没有挂载 session-title 服务')
        const session = ctx.get('sessions')?.get(sessionId)

        // 会话本来就活着：直接改，代价最小。
        if (session !== undefined) {
          const before = titles.get(session)?.title ?? null
          const accepted = titles.rename(session, title)
          return result('rename', `已改名：${sessionId}\n${before === null ? '（原无标题）' : `原名：${before}`}\n新名：${accepted.title}`, {
            sessionId,
            title: accepted.title,
            previousTitle: before,
            resumed: false,
          })
        }

        // 会话没加载。默认**拒绝**——不为改名静默 resume 一个 agent（v1 取舍）。
        const previousTitle = await workbench.describeSessions([sessionId], {})
          .then((rows) => rows[0]?.title ?? null)
          .catch(() => null)
        if (args.resume !== true) {
          throw new Error(
            `会话 "${sessionId}" 当前没有加载，无法由工具改名（session-title 只接受活着的会话）。`
            + ' 三条出路：① 让用户在侧边栏双击标题改名；② 先在界面里打开该会话再重试；'
            + '③ 显式传 resume: true —— 由 Harness 按 GUI 的同一条路径把会话 resume 出来再改名'
            + '（代价：它会变成活会话并保持加载，直到 App 重启；若该会话上次是在 turn 中途退出的，'
            + ' resume 还会往日志追加 turn closers）。',
          )
        }
        // 会话没加载，但调用方显式要求：临时 resume 一个 agent 作"载体"，把 Session 发布到
        // `ctx.sessions`（session-title 只接受活着的那个实例），改完名**立刻释放**，
        // 让它回到"未加载"。依据（写前逐条核对 app.asar，不是凭记忆）：
        //   - `@deepseek-ai/dsh-agent`：`resume(options)` 返回 handle
        //     （JSDoc: "the handle after setup, rollback-covered publication, and loop start complete"）；
        //   - `@deepseek-ai/dsh-agent-loop` 的 `prepare()`：`handle.dispose()` 会 abort 生命周期、
        //     cancel + dispose machine scope、`handle.close()` 关闭持久化句柄，最后
        //     `detachAgent()` + `detachSession()` —— 会话真正回到未加载；
        //   - `@deepseek-ai/dsh-acp`：宿主自己 create/resume 的 agent 就是这样持有的
        //     （`this.disposeAgent = () => handle.dispose()`），且 **dispose 前先 `ctx.sessions.flush(session)`**。
        // 刻意不挂 preset 组合（不调 `agentPresets.mount`）：这里只要一个能承载改名的 Session，
        // 挂组合会为一次改名去装工具、拉 MCP 客户端；这个 agent 也绝不会跑 turn。
        // 也刻意不走 `sessionController.rename()`：它 resume 后**丢弃 handle**，
        // 会话会常驻到 App 退出（我们不要这个副作用）。
        const agents = ctx.get('agents')
        if (agents === undefined || typeof agents.resume !== 'function') {
          throw new Error('resume: true 不可用：本部署没有挂载可用的 agents 服务，无法按需加载会话；'
            + '请让用户在界面里打开该会话后重试。')
        }
        let handle
        try {
          handle = await agents.resume({ resumeSessionId: sessionId })
        } catch (error) {
          throw new Error(`加载会话失败（resume）：${messageOf(error)}`)
        }
        const sessions = ctx.get('sessions')
        let acceptedTitle = title
        let renameFailure
        try {
          const accepted = titles.rename(handle.agent.session, title)
          acceptedTitle = typeof accepted?.title === 'string' && accepted.title !== '' ? accepted.title : title
          // 先让标题事件落盘，再释放（顺序照 dsh-acp 的 teardown）。
          await sessions?.flush?.(handle.agent.session)
        } catch (error) {
          renameFailure = error
        }
        // 客户端列表行的快照必须在**改名之后、dispose 之前**取。
        // ⚠️ 曾经写在改名之前（2026-10-11 实机踩到）：那时快照里的 projections 块还是**旧标题**，
        // 补发回客户端后侧边栏的名字被按回旧的——表现就是"有的变了、有的没变"。
        let rowSummary
        if (renameFailure === undefined) {
          // 用公开路径（controller.list）拿改名后的行快照；不再直接读 controller 的私有
          // `listState`（0.2.2-rc.1 已在同一私有字段上改过 summarizeCold 的签名）。
          try {
            rowSummary = await workbench.summaryFor(sessionId)
          } catch {
            rowSummary = undefined
          }
          // 会话马上要被 dispose，活实例就没了——把这份"改名之后、释放之前"的快照登记给播报。
          workbench.rememberSummary(sessionId, rowSummary)
        }
        let releaseFailure
        try {
          await handle.dispose()
        } catch (error) {
          releaseFailure = error
        }
        // ⚠️ 客户端列表的坑（2026-10-11 实机踩到）：dispose 会走
        // `detachSession()` → emit `session/disposed` → `dsh-api-session-controller` 转成
        // `api-session/removed` → 客户端 `handleSessionRemoved()` 对普通会话执行
        // `recordMutation({kind:'remove'})`，**把这一行从侧边栏删掉**。
        // 而控制器**不会**补发 `api-session/added`：它的条件是
        // `ctx.sessions.get(agent.id) === agent.session`，detach 之后不成立。
        // 结果：每次"临时加载后释放"都会让界面上那一行消失（Host 数据是好的，刷新页面才回来）。
        // 补发由 `rememberSummary()` + 统一播报完成：把`改名后、dispose 前`抓到的同一份 summary
        // 登记给播报（内容与 Host 在 `agent/created` 时发的帧同源，只是把 running / agentAvailable
        // 置回 false）。顺序依旧是 removed → added。
        const restorePlanned = releaseFailure === undefined && rowSummary !== undefined
        if (renameFailure !== undefined) {
          // 失败也要补一帧：这条会话刚被我们加载过又（即将）被 dispose，客户端那一行
          // 已被 `api-session/removed` 删掉——不补回来，一次失败的改名会顺手抹掉界面上的一行。
          // 用刚抓到的 rowSummary（改名之后、释放之前那份）如实播报它**没在跑**。
          try {
            await workbench.announce([sessionId])
          } catch (error) {
            degradeOrRethrow(error, strictOf(ctx))
            ctx.logger?.warn?.(`dsh-host-ops: announce failed: ${messageOf(error)}`)
          }
          throw new Error(`resume 后改名失败：${messageOf(renameFailure)}`)
        }
        return result('rename', [
          `已改名：${sessionId}（原本未加载，已临时加载后释放）`,
          previousTitle === null ? '（原无标题）' : `原名：${previousTitle}`,
          `新名：${acceptedTitle}`,
          releaseFailure === undefined
            ? '已释放：该会话回到未加载状态，不会常驻内存。'
            : `⚠️ 释放失败：${messageOf(releaseFailure)}——该会话会保持加载到 App 重启。`,
          releaseFailure === undefined && !restorePlanned
            ? '⚠️ 侧边栏这一行可能被 Host 的 session/disposed 移除且没能补回，刷新页面即可恢复（会话本身没丢）。'
            : '',
        ].filter((line) => line !== '').join('\n'), {
          sessionId,
          title: acceptedTitle,
          previousTitle,
          resumed: true,
          released: releaseFailure === undefined,
          rowRestored: restorePlanned,
        })
      }

      if (action === 'pin' || action === 'unpin' || action === 'archive' || action === 'unarchive') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error(`${action} 需要 sessionId`)
        const sessionId = args.sessionId.trim()
        const known = await workbench.registry.sessionKnown(sessionId)
        if (!known) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        const label = await workbench.labelFor(sessionId)

        if (action === 'pin') {
          if (workbench.pinned.has(sessionId)) return result('pin', `会话已经置顶，未改动：${label}`)
          if (workbench.archived.has(sessionId)) {
            throw new Error(`会话 "${sessionId}" 已归档，归档会话不能置顶；先 unarchive 再 pin。`)
          }
          await workbench.registry.pinSession(sessionId)
          return result('pin', `已置顶：${label}`, { sessionId })
        }
        if (action === 'unpin') {
          if (!workbench.pinned.has(sessionId)) return result('unpin', `会话本来就没置顶，未改动：${label}`)
          await workbench.registry.unpinSession(sessionId)
          return result('unpin', `已取消置顶：${label}`, { sessionId })
        }
        if (action === 'unarchive') {
          if (!workbench.archived.has(sessionId)) return result('unarchive', `会话本来就没归档，未改动：${label}`)
          await workbench.registry.unarchiveSession(sessionId)
          return result('unarchive', `已从归档恢复：${label}`, { sessionId })
        }
        // archive
        if (workbench.archived.has(sessionId)) return result('archive', `会话已经归档，未改动：${label}`)
        // 先读运行状态，把官方注册表那句不透明的 "active" 错误翻译成可行动的提示。
        if (runningStateOf(ctx, sessionId) === true) {
          throw new Error(`会话 "${sessionId}" 正在跑 turn，不能归档（官方注册表会拒绝活动中的会话）。`
            + '先用 action: cancel 停掉，或等它结束再归档；队列不会被 cancel 丢弃。')
        }
        await workbench.registry.archiveSession(sessionId)
        return result('archive', `已归档（会话历史保留，可用 unarchive 恢复）：${label}`, { sessionId })
      }

      if (action === 'send') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('send 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const instruction = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (instruction === '') throw new Error('send 需要 prompt（要投进这条会话的指令正文）')
        const known = await workbench.registry.sessionKnown(sessionId)
        if (!known) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        // 官方陷阱（0.2.1-rc.5）：对已归档会话 prompt 会被接受，但 turn 在 archived 闸门被拒、
        // 被领取的消息会被丢弃（工作不会执行）。宁可在投递前拒绝，也不让消息白投。
        if (workbench.archived.has(sessionId)) {
          throw new Error(`会话 "${sessionId}" 已归档：官方会接受 prompt 但 turn 在归档闸门被拒、消息被丢弃（工作不会执行）。`
            + '先用 action: unarchive 恢复，再发送。')
        }
        // 必须在**投递前**读状态：投递本身会唤醒空闲会话，事后读到的不是决策依据。
        const runningBefore = runningStateOf(ctx, sessionId)
        const inboxBefore = inboxStateOf(ctx, sessionId)
        // 投递前记一个 cursor（日志末尾 seq）：之后 read/wait 传 after=<cursor> 就只看这条消息之后的。
        const cursorBefore = await logEndSeq(ctx, sessionId, exec?.signal)
        try {
          await admitPrompt(ctx, sessionId, instruction)
        } catch (error) {
          throw deliveryErrorOf(error)
        }
        const label = await workbench.labelFor(sessionId)
        const lines = [`已把指令投进会话：${label}`]
        if (runningBefore === true) {
          lines.push('目标投递前**正在跑一个 turn**：这条已排到当前 turn 之后（官方 queue 语义，不打断它现在做的事）。')
          lines.push('如果你其实想让它**当前这轮**就采纳这条（改方向 / 纠错 / 停手）：**不要重发**（会造成重复投递）；'
            + '用 action: queue 的 list 拿到这条的 itemId，再 queueAction: steer 把它提升到当前 turn 的下一步。')
        } else if (runningBefore === false) {
          lines.push('目标投递前没有在跑 turn：这条会让它**立刻开始新一轮**（官方 queue 语义：空闲时立即开工）。')
        } else {
          lines.push('（投递前读不到目标的运行状态；queue 语义：正在跑就排在下一轮，空闲就立刻开工。）')
        }
        const pending = inboxBefore === undefined ? 0 : inboxBefore.nextTurn + inboxBefore.nextStep
        if (pending > 0) {
          lines.push(`投递前它的待处理队列已有 ${pending} 条（下一轮 ${inboxBefore.nextTurn} / 下一步 ${inboxBefore.nextStep}），这条排在它们后面。`)
        }
        lines.push(`指令：${instruction.length > 120 ? `${instruction.slice(0, 119)}…` : instruction}`)
        if (typeof cursorBefore === 'number') {
          lines.push(`读回这条之后的回复：action: read（after: ${cursorBefore}）或 action: wait（after: ${cursorBefore}, until: reply|step|done）。`)
        }
        return result('send', lines.join('\n'), {
          sessionId,
          mode: 'queue',
          runningBefore: runningBefore ?? null,
          cursor: cursorBefore ?? null,
        })
      }

      if (action === 'steer') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('steer 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const instruction = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (instruction === '') throw new Error('steer 需要 prompt（要插进正在跑的那一轮的话）')
        const known = await workbench.registry.sessionKnown(sessionId)
        if (!known) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        if (workbench.archived.has(sessionId)) {
          throw new Error(`会话 "${sessionId}" 已归档：官方会接受 prompt 但 turn 在归档闸门被拒、消息被丢弃（工作不会执行）。`
            + '先用 action: unarchive 恢复，再发送。')
        }
        // 同 send：状态要在投递前读。steer 的语义只在"已经有 turn 在跑"时成立。
        const runningBefore = runningStateOf(ctx, sessionId)
        const inboxBefore = inboxStateOf(ctx, sessionId)
        const cursorBefore = await logEndSeq(ctx, sessionId, exec?.signal)
        const label = await workbench.labelFor(sessionId)
        const pendingLine = () => {
          const pending = inboxBefore === undefined ? 0 : inboxBefore.nextTurn + inboxBefore.nextStep
          return pending > 0
            ? `投递前它的待处理队列已有 ${pending} 条（下一轮 ${inboxBefore.nextTurn} / 下一步 ${inboxBefore.nextStep}），这条排在它们后面。`
            : undefined
        }
        const contentLine = `内容：${instruction.length > 120 ? `${instruction.slice(0, 119)}…` : instruction}`
        const cursorLine = typeof cursorBefore === 'number'
          ? `读回这条之后的回复：action: read（after: ${cursorBefore}）或 action: wait（after: ${cursorBefore}, until: reply|step|done）。`
          : undefined
        /*
         * 官方语义（0.2.1-rc.5，`prompt` 命令分发 `commands.js:325-328`）：
         * `mode:'steer'` 在**空闲**目标上也会被接受（进 inbox.nextStep 并立刻开一轮），
         * `session/steer-unavailable` 只由 `updateQueue` 产生，**不是** prompt 的错误。
         * 官方客户端规则是 `!running → queue`（`resolveSubmitMode`）。这里照抄：
         * 只有**确认目标在跑**才用 steer；空闲/未知都解析为 queue 并如实说明。
         */
        if (runningBefore !== true) {
          try {
            await admitPrompt(ctx, sessionId, instruction, 'queue')
          } catch (error) {
            throw deliveryErrorOf(error)
          }
          const lines = [
            `steer 没有使用：目标投递前${runningBefore === false ? '**没有在跑 turn**' : '的运行状态读不到'}。`,
            '按官方客户端同款规则（只有确认在跑才 steer），已改用 **queue** 投递：'
              + (runningBefore === false
                ? '空闲会话会**立刻开始新一轮**（与 send 等价，消息不会丢、也不会被排到下一轮）。'
                : '正在跑就排在下一轮，空闲则立刻开工（消息不会丢）。'),
            '这条**不需要重发**。等 `list` / `get` 显示 `[运行中]` 时再用 steer 才是"插进当前 turn 的下一步"。',
          ]
          if (runningBefore === false) lines.push('以后目标空闲时直接 `send`，语义更明确。')
          const pending = pendingLine()
          if (pending !== undefined) lines.push(pending)
          lines.push(contentLine)
          if (cursorLine !== undefined) lines.push(cursorLine)
          return result('steer', lines.join('\n'), { sessionId, mode: 'queue', runningBefore: runningBefore ?? null, cursor: cursorBefore ?? null })
        }
        try {
          await admitPrompt(ctx, sessionId, instruction, 'steer')
          return result('steer', [
            `已插话到 ${label} 当前正在跑的 turn（官方 steer 语义：在**下一步**被采纳；不中断当前正在执行的 step，只是改变它接下来的做法）。`,
            '如果它刚好在这一刻结束，这条按官方 best-effort 语义会落到下一轮在唤醒时执行——消息不会丢。',
            contentLine,
            ...(cursorLine === undefined ? [] : [cursorLine]),
          ].join('\n'), { sessionId, mode: 'steer', runningBefore: true, cursor: cursorBefore ?? null })
        } catch (error) {
          // 竞态：读时在跑、投递时已经结束/被拒 → 回退 queue，并如实说明（不重发同一句）。
          try {
            await admitPrompt(ctx, sessionId, instruction, 'queue')
          } catch (error2) {
            throw deliveryErrorOf(error2)
          }
          const lines = [
            `steer 没有生效：${label} 在投递时已经没有可插话的 turn（或运行时拒收），已改用 **queue** 投递，消息不会丢。`,
            `原因：${typeof error?.code === 'string' ? `${error.code}：` : ''}${messageOf(error)}`,
            '这条**不需要重发**——它会在下一轮/下一次唤醒时执行。',
          ]
          const pending = pendingLine()
          if (pending !== undefined) lines.push(pending)
          lines.push(contentLine)
          if (cursorLine !== undefined) lines.push(cursorLine)
          return result('steer', lines.join('\n'), { sessionId, mode: 'queue', runningBefore: true, cursor: cursorBefore ?? null })
        }
      }

      if (action === 'wait') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('wait 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const known = await workbench.registry.sessionKnown(sessionId)
        if (!known) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        const timeoutMs = Math.min(30 * 60 * 1000, Math.max(5000, Number.isFinite(args.timeoutMs) ? Math.floor(args.timeoutMs) : 90 * 1000))
        const until = args.until === 'reply' || args.until === 'step' ? args.until : 'done'
        const after = Number.isFinite(args.after) ? Math.floor(args.after) : undefined
        const label = await workbench.labelFor(sessionId)
        const outcome = await waitForNewEvents(ctx, sessionId, { after, until, timeoutMs })
        const allLines = renderEventLines(outcome.events)
        const shown = allLines.slice(-40)
        const cursor = typeof outcome.cursor === 'number' ? outcome.cursor : null
        const meta = {
          sessionId,
          state: outcome.state,
          until,
          cursor,
          after: after ?? null,
          newEvents: outcome.events.length,
          idleForMs: outcome.idleForMs ?? null,
          reason: outcome.reason?.kind ?? null,
        }
        if (outcome.state === 'idle') {
          const lines = [`${label} 当前没有在跑的 turn（status=${outcome.status ?? 'unknown'}），无需等待。`]
          if (shown.length > 0) {
            lines.push(`但 cursor=${after ?? -1} 之后已有 ${allLines.length} 条事件（新 cursor=${cursor}）：`)
            lines.push(...shown)
          }
          return result('wait', lines.join('\n'), meta)
        }
        if (outcome.state === 'timeout') {
          const lines = [
            `${label} 还没满足 until=${until}；已等 ${Math.round(timeoutMs / 1000)} 秒。`,
            `已收到 ${allLines.length} 条新事件（cursor=${cursor}），最近 ${Math.round((outcome.idleForMs ?? 0) / 1000)} 秒没有新动静。`,
          ]
          if (shown.length > 0) lines.push('这段时间的新内容：', ...shown)
          lines.push('没有内容丢失：短等可再 wait 一次；长任务建议 notify 登记（结束会唤醒），或稍后 read(after=cursor) 看增量。')
          return result('wait', lines.join('\n'), meta)
        }
        const stateText = outcome.state === 'reply'
          ? '收到新的完整助手回复'
          : outcome.state === 'step' ? '完成了一步（工具结果或一段回复）' : `turn 已结束（reason=${outcome.reason?.kind ?? 'unknown'}）`
        const lines = [`${label} ${stateText}；cursor=${cursor}，本次新增 ${allLines.length} 条事件。`]
        if (shown.length > 0) lines.push(...shown)
        lines.push('要看完整内容用 read（传 after=cursor 只看之后的增量，或 beforeSeq 翻更早）。')
        return result('wait', lines.join('\n'), meta)
      }

      if (action === 'notify') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('notify 需要 sessionId')
        const workerId = args.sessionId.trim()
        const known = await workbench.registry.sessionKnown(workerId)
        if (!known) throw new Error(`找不到会话 "${workerId}"（活会话与已持久化历史里都没有）`)
        const callerId = exec?.agent?.session?.id
        if (typeof callerId !== 'string' || callerId === '') throw new Error('notify 只能从一条会话的 turn 内调用（拿不到发起方会话）')
        if (callerId === workerId) throw new Error('notify 不能登记自己；请对另一条后台会话使用')
        const label = await workbench.labelFor(workerId)
        const agents = ctx.get('agents')
        const status = agents?.get?.(workerId)?.status
        if (status !== 'running') {
          return result('notify', `${label} 当前没有在跑的 turn（status=${status ?? 'unknown'}），无需登记提醒。`, { sessionId: workerId, state: 'idle' })
        }
        let disposed = false
        let timer = null
        const dispose = () => {
          if (disposed) return
          disposed = true
          clearTimeout(timer)
          try { off?.() } catch {}
        }
        const off = ctx.on('session/event', (session, event) => {
          if (!session || session.id !== workerId || !event || event.type !== 'turn/end') return
          dispose()
          const kind = event.data?.reason?.kind ?? 'unknown'
          const controller = ctx.get('sessionController')
          if (controller === undefined || typeof controller.prompt !== 'function') return
          controller.prompt({
            requestId: `workbench-notify-${globalThis.crypto.randomUUID()}`,
            sessionId: callerId,
            mode: 'queue',
            content: [{ type: 'text', text: `🔔 [workbench] ${label} 的 turn 已结束（reason=${kind}）。请用 dsh_session_manage read 查看它的结果并继续。` }],
          }, new AbortController().signal).catch(() => {})
        })
        timer = setTimeout(dispose, 24 * 60 * 60 * 1000)
        if (typeof timer.unref === 'function') timer.unref()
        return result('notify', [
          `已登记：${label} 结束时会给当前会话投一条提醒，我会被唤醒，不需要 wait 或轮询。`,
          '本轮可以直接结束；醒来的提示里会带上结束原因，随后用 read 看结果即可。',
        ].join('\n'), { sessionId: workerId, callerSessionId: callerId, state: 'registered' })
      }

      if (action === 'queue') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('queue 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const known = await workbench.registry.sessionKnown(sessionId)
        if (!known) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        const controller = ctx.get('sessionController')
        if (controller === undefined || typeof controller.updateQueue !== 'function') {
          throw new Error('queue 不可用：本部署没有 sessionController.updateQueue')
        }
        const queueAction = typeof args.queueAction === 'string' && args.queueAction !== '' ? args.queueAction : 'list'
        /*
         * P0 守卫（2026-11-02）：`queue` 这个名字来自官方 inbox/QueueDock，它**只管理已经排队**的消息。
         * 旧实现会把 `prompt` 静默忽略并返回成功形状的列表 → 模型以为发了消息。这里直接拒绝并指路。
         */
        if (typeof args.prompt === 'string' && args.prompt.trim() !== '') {
          throw new Error('queue 只管理**已排队**的消息，不投递新消息（你传的 prompt 会被忽略，本工具拒绝这种调用）。'
            + '要投递请用 action: "send"（排到下一轮；目标空闲则立刻开工）或 action: "steer"（插进正在跑的 turn 的下一步）。')
        }
        const label = await workbench.labelFor(sessionId)
        // 无加载读取 inbox：官方 `projections → values.inbox` 对 live / current-format 冷会话都可用；
        // 冷会话的 pending inbox 在内存里、加载后会从持久化恢复，所以"看不到"就等于"当前没有待处理消息"。
        const inbox = await inboxProjectionOf(ctx, sessionId)
        const summarize = (message) => {
          const text = (Array.isArray(message?.content) ? message.content : [])
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim()
          return { itemId: message?.id, text }
        }
        if (queueAction === 'list') {
          if (inbox === undefined) {
            return result('queue', [
              `${label} 当前未加载，读不到 inbox 投影。`,
              '未加载会话的待处理队列在内存里（重新加载后从持久化恢复），不会为了看一眼队列而加载会话。',
              '要投递新消息用 send / steer；要管理队列请在它加载后（或由 agent 提供 itemId）再操作。',
            ].join('\n'), { sessionId, nextTurn: [], nextStep: [], loaded: false })
          }
          const nextTurn = inbox.nextTurn.map(summarize)
          const nextStep = inbox.nextStep.map(summarize)
          if (nextTurn.length === 0 && nextStep.length === 0) {
            return result('queue', `${label} 的待处理队列是空的。`, { sessionId, nextTurn: [], nextStep: [] })
          }
          const lines = []
          nextTurn.forEach((item, index) => lines.push(`待下一轮 #${index + 1}（itemId=${item.itemId}）：${item.text.length > 120 ? `${item.text.slice(0, 119)}…` : item.text}`))
          nextStep.forEach((item, index) => lines.push(`待下一步 #${index + 1}（itemId=${item.itemId}）：${item.text.length > 120 ? `${item.text.slice(0, 119)}…` : item.text}`))
          return result('queue', [`${label} 的待处理队列：`, ...lines].join('\n'), { sessionId, nextTurn, nextStep })
        }
        const itemId = typeof args.itemId === 'string' ? args.itemId.trim() : ''
        if (itemId === '') throw new Error('queue 需要 itemId（先用 queueAction: list 查看）')
        if (queueAction === 'edit') {
          const content = typeof args.content === 'string' ? args.content.trim() : ''
          if (content === '') throw new Error('queue edit 需要 content（替换后的正文）')
          await controller.updateQueue({ sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text: content }] } })
          return result('queue', `已修改 ${label} 的队列项 ${itemId}。`, { sessionId, itemId })
        }
        if (queueAction === 'remove') {
          await controller.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })
          return result('queue', `已从 ${label} 的队列移除 ${itemId}。`, { sessionId, itemId })
        }
        if (queueAction === 'steer') {
          // 官方限制（`updateQueue`：`kind==='steer' && agent.status!=='running'` → `session/steer-unavailable`）：
          // 排队项 steer 本质是"把 nextTurn 项搬进当前 turn 的下一步"，目标不在跑就没有"下一步"。
          // 先读状态给出可行动的错误，而不是把官方错误码原样丢给模型。
          if (runningStateOf(ctx, sessionId) === false) {
            throw new Error(`queue steer 需要目标**正在跑 turn**（官方 updateQueue 限制）；"${label}" 当前空闲。`
              + '这条消息仍排在下一轮；可以 edit/remove，或等它开始跑之后再 steer。')
          }
          await controller.updateQueue({ sessionId, itemId, action: { kind: 'steer' } })
          return result('queue', `已把 ${label} 的排队消息 ${itemId} 转为即时插话（steer）：它会进入当前 turn 的下一步。`, { sessionId, itemId })
        }
        throw new Error('queueAction 必须是 list / edit / remove / steer')
      }

      if (action === 'cancel') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('cancel 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const known = await workbench.registry.sessionKnown(sessionId)
        if (!known) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        const controller = ctx.get('sessionController')
        if (controller === undefined || typeof controller.cancel !== 'function') {
          throw new Error('cancel 不可用：本部署没有 sessionController.cancel')
        }
        // 先读状态：空闲时 cancel 是无操作，不要让模型以为"正在跑的 turn 已停"。
        const runningBefore = runningStateOf(ctx, sessionId)
        // 官方 0.2.2-rc.1：`cancel` 对**未 attach** 的会话抛 `session/not-found`，不是 no-op。
        // 明确没有在跑时直接返回，不碰控制器（冷会话/空闲会话都不该收到错误）。
        if (runningBefore === false) {
          const idleLabel = await workbench.labelFor(sessionId)
          return result('cancel', [
            `${idleLabel} 当前**没有在跑的 turn**：cancel 无改动，待处理队列也未动。`,
            '要取消的是"排队中的消息"请用 action: queue（edit/remove）；要停止已结束的工作没有可停的东西。',
          ].join('\n'), { sessionId, runningBefore: false, accepted: false })
        }
        const outcome = await controller.cancel({ sessionId })
        const label = await workbench.labelFor(sessionId)
        const lines = []
        if (runningBefore === undefined) {
          lines.push(`已请求取消 ${label}（投递前读不到它的运行状态）。`)
          lines.push('若它确实在跑，这次取消会生效；待处理的队列不会被丢弃（官方语义）。')
        } else {
          lines.push(`已请求取消 ${label} 正在跑的 turn。`)
          lines.push('待处理的队列**不会**被丢弃（官方语义："Cancel one active Agent turn without dropping its pending inbox"）。')
        }
        lines.push(outcome?.accepted === true ? '控制器已接受这次取消。' : '控制器返回：' + JSON.stringify(outcome ?? null))
        return result('cancel', lines.join('\n'), { sessionId, runningBefore: runningBefore ?? null, accepted: outcome?.accepted === true })
      }

      if (action === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query === '') throw new Error('search 需要 query（按会话内容检索）')
        const controller = ctx.get('sessionController')
        if (controller === undefined || typeof controller.search !== 'function') {
          throw new Error('search 不可用：本部署没有 sessionController.search')
        }
        const found = await controller.search({ query }, new AbortController().signal)
        const items = Array.isArray(found?.items) ? found.items : []
        if (items.length === 0) return result('search', `没有会话内容匹配「${query}」。`, { items: [] })
        // ⚠️ 官方 `SessionSearchRequest` **只有 query**（条数上限由部署配置的 defaultLimit/maxLimit 决定），
        // 所以**限制显示条数是我们的责任**——实测不限制会把十几条命中连大段 snippet 全倒进上下文。
        const wanted = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 8
        const shown = Math.min(wanted, items.length)
        const lines = []
        for (const item of items.slice(0, shown)) {
          const label = await workbench.labelFor(item.sessionId)
          const snippet = String(item.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
          lines.push(`- ${label}${showIds ? ` — ${item.sessionId}` : ''}\n  ${snippet}`)
        }
        return result('search', [
          `匹配「${query}」：本次返回 ${items.length} 条${found?.hasMore === true ? '（官方说还有更多）' : ''}，`
            + `显示前 ${shown} 条（要更多就调大 limit，要更准就换关键词）：`,
          ...lines,
        ].join('\n'), { items: items.slice(0, shown).map((item) => item.sessionId) })
      }

      if (action === 'read') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('read 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const wanted = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20
        const label = await workbench.labelFor(sessionId)
        // cursor 增量读：`after` 来自 send/read/wait 返回的 cursor，只看它之后的。
        if (Number.isFinite(args.after)) {
          const after = Math.floor(args.after)
          const delta = await readEventsAfter(ctx, sessionId, after, wanted, new AbortController().signal)
          const lines = renderEventLines(delta.events)
          if (lines.length === 0) {
            return result('read', `自 cursor=${after} 之后没有新内容（${label}）；当前 cursor 仍是 ${after}。`, { sessionId, cursor: after, after, newEvents: 0 })
          }
          return result('read', [
            `${label} 在 cursor=${after} 之后有 ${delta.events.length} 条事件（新 cursor=${delta.cursor}）`
              + `${delta.hasMore ? '；更早的内容还有，可用 beforeSeq 翻页' : ''}：`,
            ...lines,
          ].join('\n'), { sessionId, cursor: delta.cursor, after, newEvents: delta.events.length })
        }
        const controller = ctx.get('sessionController')
        if (controller === undefined || typeof controller.events !== 'function') {
          throw new Error('read 不可用：本部署没有 sessionController.events')
        }
        // 官方 0.2.2-rc.1：`events(request, signal)` 取代旧的 `inspect`/`page`。
        // request = { address, maxMessages, beforeSeq?, throughSeq? }；
        // 省略 throughSeq 表示取日志末尾，正好是「读最近 N 条」；hasMore 表示还能往前翻。
        const request = { address: { kind: 'session', sessionId }, maxMessages: wanted }
        if (Number.isFinite(args.beforeSeq)) request.beforeSeq = Math.floor(args.beforeSeq)
        const page = await controller.events(request, new AbortController().signal)
        const records = Array.isArray(page?.records) ? page.records : []
        const events = records.map((record) => record?.event).filter((event) => event !== undefined && event !== null)
        const lines = renderEventLines(events)
        const cursor = events.length > 0 && typeof events[events.length - 1].seq === 'number'
          ? events[events.length - 1].seq
          : null
        if (lines.length === 0) return result('read', `${label} 最近没有可读的消息（最多取了 ${wanted} 条）。`, { sessionId, cursor })
        return result('read', [
          `${label} 的最近 ${lines.length} 条（按时间先后）`
            + `${page?.hasMore === true ? '；更早的内容还有，可用 beforeSeq 翻页' : ''}`
            + `${cursor === null ? '' : `；新 cursor=${cursor}（传 after 可只读增量）`}：`,
          ...lines,
        ].join('\n'), { sessionId, cursor, newEvents: lines.length })
      }

      if (action === 'fork') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('fork 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const known = await workbench.registry.sessionKnown(sessionId)
        if (!known) throw new Error(`找不到会话 "${sessionId}"（活会话与已持久化历史里都没有）`)
        const controller = ctx.get('sessionController')
        if (controller === undefined || typeof controller.fork !== 'function') {
          throw new Error('fork 不可用：本部署没有 sessionController.fork')
        }
        const forked = await controller.fork({ sessionId })
        const newId = forked?.sessionId
        if (typeof newId !== 'string' || newId === '') throw new Error('fork 没有返回新会话 id')
        // 官方 fork 只复制事件；归组要显式做（和 start 之后回读成员表的道理一样）。
        const source = [...workbench.registry.list()].find((entry) => entry.sessionIds.includes(sessionId))
        let grouped = false
        if (source !== undefined) {
          try {
            await source.attachSession(newId)
            grouped = true
          } catch (error) {
            degradeOrRethrow(error, strictOf(ctx))
            ctx.logger?.warn?.(`dsh-host-ops: fork 之后登记进工作区失败：${messageOf(error)}`)
          }
        }
        const label = await workbench.labelFor(newId)
        return result('fork', [
          `已从 ${await workbench.labelFor(sessionId)} 分叉出新会话：${label}`,
          grouped ? `已登记进工作区「${source.title}」。` : '注意：没能登记进工作区（它可能在"未分组"里）。',
          '新会话是**冷**的：要它干活请用 send 投一条指令（或直接 start 一条新的）。',
        ].join('\n'), { sessionId: newId })
      }

      if (action === 'openPath') {
        const controller = ctx.get('sessionController')
        if (controller === undefined || typeof controller.openWorkspacePath !== 'function') {
          throw new Error('openPath 不可用：本部署没有 sessionController.openWorkspacePath')
        }
        let target = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
        if (target === undefined && typeof args.workspaceId === 'string' && args.workspaceId.trim() !== '') {
          target = workbench.requireWorkspace(args.workspaceId).path
        }
        if (target === undefined) throw new Error('openPath 需要 path（绝对路径）或 workspaceId')
        await controller.openWorkspacePath({ path: target, ...(args.reveal === true ? { action: 'reveal' } : {}) }, new AbortController().signal)
        return result('openPath', `已在访达 / 资源管理器里打开：${target}`)
      }

      if (action === 'model') {
        if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('model 需要 sessionId')
        const sessionId = args.sessionId.trim()
        const provider = typeof args.provider === 'string' ? args.provider.trim() : ''
        const model = typeof args.model === 'string' ? args.model.trim() : ''
        if (provider === '' || model === '') throw new Error('model 需要 provider 与 model（provider/model id 以部署的模型列表为准，可在界面模型选择器里确认；本部署没有模型枚举工具）')
        const controller = ctx.get('sessionController')
        if (controller === undefined || typeof controller.selectModel !== 'function') {
          throw new Error('model 不可用：本部署没有 sessionController.selectModel')
        }
        const selected = await controller.selectModel({ sessionId, provider, model })
        const label = await workbench.labelFor(sessionId)
        return result('model', `已把 ${label} 的模型选为 ${JSON.stringify(selected?.selected ?? { provider, model })}。`, { sessionId })
      }

      if (action === 'reorder') {
        const workspace = workbench.requireWorkspace(args.workspaceId)
        const order = Array.isArray(args.order) ? args.order : []
        const current = [...workspace.sessionIds]
        if (order.length === 0) throw new Error('reorder 需要 order（工作区内会话 id 的完整新顺序）')
        const wanted = new Set(order)
        if (wanted.size !== order.length) throw new Error('order 里有重复的会话 id')
        if (wanted.size !== current.length || current.some((id) => !wanted.has(id))) {
          throw new Error(`order 必须恰好覆盖工作区 "${workspace.title}" 当前登记的 ${current.length} 个会话`
            + '（用 action: get 或 dsh_workspace_manage 的 get 取最新列表后重试）')
        }
        const moved = await Workbench.applyOrder(order, async (sessionId, beforeSessionId) => {
          await workspace.insertSessionBefore(sessionId, beforeSessionId)
        })
        const applied = [...workspace.sessionIds]
        const infos = await workbench.describeSessions(applied, { showIds, signal: exec.signal })
        // 只动工作区的成员顺序：客户端那一侧由 `remote.workspace.follow` 的
        // upsert 帧自带（WorkspaceView 里就有 sessionIds），不需要再补会话帧。
        return result('reorder', `已在工作区 "${workspace.title}" 内重排 ${moved} 个会话：\n`
          + infos.map((info, index) => `${index + 1}. ${info.title ?? '（无标题）'} — ${info.displayId}`).join('\n'), {
          workspaceId: workspace.id,
          sessionIds: applied,
        })
      }

      if (action === 'sort') {
        const workspace = workbench.requireWorkspace(args.workspaceId)
        const { rows } = await workbench.collect({ workspaceId: workspace.id, showIds, signal: exec.signal })
        const computed = Workbench.computeOrder(rows, {
          by: args.by,
          reverse: args.reverse === true,
          from: parseTime(args.from),
          to: parseTime(args.to),
        })
        const skipped = rows.length - computed.length
        if (computed.length === 0) throw new Error('筛选后没有会话可排序（检查 from / to）')

        // 未参与排序的会话保持原相对位置：把它们按原顺序插到"参与排序的队尾会话"之后。
        const untouched = new Set([...workspace.sessionIds].filter((id) => !computed.includes(id)))
        let desired
        if (untouched.size === 0) {
          desired = computed
        } else {
          const anchored = computed[computed.length - 1]
          const merged = []
          let inserted = false
          for (const id of workspace.sessionIds) {
            if (id === anchored) {
              merged.push(id)
              inserted = true
              continue
            }
            if (untouched.has(id)) continue
            merged.push(id)
          }
          if (!inserted) merged.push(anchored)
          desired = [...merged, ...workspace.sessionIds.filter((id) => untouched.has(id))]
        }
        await Workbench.applyOrder(desired, async (sessionId, beforeSessionId) => {
          await workspace.insertSessionBefore(sessionId, beforeSessionId)
        })
        const infos = await workbench.describeSessions([...workspace.sessionIds], { showIds, signal: exec.signal })
        return result('sort', [
          `已按 ${args.by ?? 'title'} 重排工作区 "${workspace.title}"：`,
          ...infos.map((info, index) => `${index + 1}. ${info.title ?? '（无标题）'} — ${info.displayId}`),
          ...(skipped > 0 ? [`（${skipped} 个会话不在 from/to 范围内，保持原相对位置）`] : []),
        ].join('\n'), {
          workspaceId: workspace.id,
          sessionIds: [...workspace.sessionIds],
          sortedCount: computed.length,
          skippedCount: skipped,
        })
      }

      throw new Error(`未知 action "${action}"`)
    },
  }), workbench))

  /* --------------------------- 配置工具 --------------------------- */

  /**
   * `dsh_config_manage`：读 / 改 DSH 自身的配置（profile 行）。
   *
   * **不套 `withAnnounce`**：它不产生会话行变化，没有可播报的东西。
   */
  ctx.tools.register(defineTool({
    name: 'dsh_config_manage',
    description:
      'Read and change DSH\'s own configuration: profile rows owning plugin config, same official path as the '
      + 'Settings forms (no patch-file edits, no App quit). '
      + 'Writes are TWO-STEP: preview without apply, get user agreement, then apply: true with the preview\'s '
      + '`previewToken`; every write also requires an interactive approval (fail-closed) and is recorded in an '
      + 'audit log with a revert path (action=revert). '
      + 'Mechanically that path is `configEditor.edit()`: it validates '
      + 'the complete next config, takes the profile file lock, replaces that row\'s override atomically, reconciles '
      + 'exactly that row through the Loader, and restores the previous file if reconciliation fails. It is NOT a hand '
      + 'edit of cordis.patch.yml, and it does not need the App to be quit. '
      + 'A WRITE IS A TWO-STEP FLOW, ALWAYS: call set/reset WITHOUT `apply` first, then relay the printed '
      + '「给用户看」section to the user IN PLAIN WORDS (it is already short, prioritised, and filtered: what changes, '
      + 'whether it interrupts anything running, whether a restart is needed, whether it can be reverted, and the '
      + 'scope). Do NOT dump the 「技术依据」section on the user — that is for you; mention it only if the user asks '
      + 'or a step fails. Keep the decision load small: one short paragraph, not a list of every boundary. '
      + 'Only call again with `apply: true` after the user explicitly agrees. Never write on your own initiative, and never pass `apply: true` in the same turn as the '
      + 'preview unless the user has already told you to change exactly that value. '
      + 'This tool edits EXISTING rows only: adding a new row (a patch `insert`, e.g. a new MCP server) is not '
      + 'supported and still needs the patch layer plus a restart. '
      + 'Limitations to state to the user: (a) only the active profile patch layer is writable — home patches and '
      + 'command-line overlays are read for precedence, and a row they override is refused; (b) only uniquely '
      + 'addressed rows owned by the profile root Include are editable, and some rows (agent preset rows) are '
      + 'read-only; (c) an override is COMPLETE — every field it does not change gets pinned at the profile layer to '
      + 'its current raw value and stops following bundle defaults; (d) this tool merges top-level fields only; '
      + '(e) applying a change reconciles that one row, so stateful resources (indexes, connections) are rebuilt and '
      + 'a running turn can be interrupted; (f) whether it takes effect immediately or needs a restart depends on '
      + 'that row\'s lifecycle.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'set', 'reset', 'revert', 'history'],
        description: 'list: every editable row with its package name and whether it has an override (a real profile '
          + 'has ~180 rows — raise `limit` when the row you need is not shown; rows with an override are always '
          + 'listed). get: one row\'s inherited / override / currently effective values — read it before proposing a '
          + 'write. set: change top-level fields of one row (two-step: preview first, apply only after the user '
          + 'agrees). reset: drop the override so the row falls back to inherited. revert: roll back one previous '
          + 'write by auditId (conflict-checked first; also two-step). history: recent config writes with their '
          + 'auditIds, field diffs and revert hints.',
        required: true,
      },
      entry: {
        type: 'string',
        description: 'Patch id of the profile row, e.g. "session-query-sqlite". Required by get, set, and reset.',
      },
      values: {
        type: 'object',
        additionalProperties: true,
        description: 'set: top-level fields to change, e.g. { "openAt": "first-search" }. Merged over the row\'s '
          + 'current values; other fields are preserved (and pinned — see the consequences). Required by set; '
          + 'ignored by reset (reset drops the whole override, so it takes no values).',
      },
      limit: {
        type: 'number',
        description: 'list: how many rows WITHOUT an override to print (rows that have an override are always '
          + 'listed). Defaults to 40 — a real profile has ~180 rows, so printing all of them wastes context.',
      },
      apply: {
        type: 'boolean',
        description: 'set/reset/revert: actually write. Omit it for a preview that prints the before/after and every '
          + 'consequence without touching the profile. Only pass true after the user has agreed.',
      },
      previewToken: {
        type: 'string',
        description: 'set/reset/revert + apply: the token returned by the preview. Required when the plugin config '
          + 'requiresPreview is true (default). Mismatch means the row changed since the preview — preview again.',
      },
      auditId: {
        type: 'string',
        description: 'revert: id of the config write to roll back (from action=history or the write result).',
      },
    },
    output: OUTPUT,
    /**
     * @param args - 已校验的模型参数。
     * @returns 工具结果。
     */
    execute: async (args, exec) => {
      const action = args.action
      const editor = requireConfigEditor(ctx)
      // "此刻有几条会话在跑"——用于回答"这次改动会不会打断什么"。查不到就如实说查不到。
      let liveSessions
      try {
        const records = await workbench.query.listSessions(exec?.signal)
        liveSessions = records.filter((record) => record.live === true).length
      } catch (error) {
        degradeOrRethrow(error, strictOf(ctx))
        ctx.logger?.warn?.(`dsh-host-ops: 配置工具查活动会话失败：${messageOf(error)}`)
        liveSessions = undefined
      }

      if (action === 'list') {
        const configuration = editor.configuration()
        const rows = configuration.map((row) => ({
          entry: String(row.entry?.options?.id ?? '?'),
          name: String(row.entry?.options?.name ?? '?'),
          hasOverride: Object.keys(row.override ?? {}).length > 0,
          overrideFields: Object.keys(row.override ?? {}),
        })).sort((left, right) => left.entry.localeCompare(right.entry))
        const withOverride = rows.filter((row) => row.hasOverride)
        const plain = rows.filter((row) => !row.hasOverride)
        // ⚠️ 实测这个 profile 有 184 行：全列出来会白烧几千 token。有覆盖的全列，其余受 limit 限制。
        const wanted = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 40
        const shownPlain = plain.slice(0, wanted)
        return result('list', [
          `本 profile 可编辑的行共 ${rows.length} 行，其中 **${withOverride.length} 行已有覆盖值**（✔）：`,
          ...withOverride.map((row) => `✔ ${row.entry} (${row.name}) — 覆盖字段：${row.overrideFields.join(', ')}`),
          withOverride.length > 0 ? '' : '（当前没有任何行带覆盖值）',
          plain.length === 0 ? '' : `其余 ${plain.length} 行没有覆盖，下面列前 ${shownPlain.length} 行`
            + `${plain.length > shownPlain.length ? `（要更多就调大 limit，最多 ${plain.length}）` : ''}：`,
          ...shownPlain.map((row) => `· ${row.entry} (${row.name})`),
        ].filter((line) => line !== '').join('\n'), {
          rows: [...withOverride, ...shownPlain],
          totalRows: rows.length,
          overrideCount: withOverride.length,
        })
      }

      // —— 审计历史：最近写入了什么、哪些可回滚 ——（不需要 entry）
      if (action === 'history') {
        const wantedLimit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 10
        const records = workbench.auditLog.slice(0, wantedLimit)
        if (records.length === 0) {
          return result('history', '还没有配置写入记录（审计只在插件运行期间保留；插件重挂/重启后清空）。', { records: [] })
        }
        const lines = records.map((record) => {
          const fields = (record.overrideChanges ?? []).map((change) =>
            `${change.field}: ${JSON.stringify(maskSensitive(change.field, change.from))} → ${JSON.stringify(maskSensitive(change.field, change.to))}`)
          return `${record.id} — ${record.at} — ${record.action} ${record.entry} — ${fields.join('；') || '（无字段变化）'}`
            + `${record.reverts === undefined ? '' : `（回滚 ${record.reverts}）`}`
        })
        return result('history', [
          `最近 ${records.length} 条配置写入（id — 时间 — 动作 行 — 字段变化）：`,
          ...lines,
          '回滚：action=revert entry=<行> auditId=<id>（先不带 apply 预览，写入同样要审批）。',
        ].join('\n'), { records })
      }

      if (typeof args.entry !== 'string' || args.entry.trim() === '') {
        throw new Error(`${action} 需要 entry（行的 patch id，可用 action=list 查）`)
      }
      const wanted = args.entry.trim()
      const entry = editor.entries().find((candidate) => candidate?.options?.id === wanted)
      if (entry === undefined) {
        const known = editor.entries().map((candidate) => String(candidate?.options?.id ?? '?')).sort()
        // 本机 profile 有 ~180 行可编辑行；全量 id 铺进错误信息是几 KB 的噪音（模型只会更迷茫）。
        const shown = known.slice(0, 20)
        const more = known.length > shown.length ? `…（还有 ${known.length - shown.length} 行，用 action: list 查看）` : ''
        throw new Error(`找不到可编辑的行 "${wanted}"。可编辑的行有：${shown.join(', ')}${more}`)
      }
      const state = editor.configuration().find((row) => row.entry === entry) ?? { inherited: {}, override: {} }
      const inherited = state.inherited ?? {}
      const override = state.override ?? {}
      const effective = { ...inherited, ...override }

      if (action === 'get') {
        return result('get', [
          `行：${entryLabel(entry)}`,
          `当前生效的值：${JSON.stringify(effective)}`,
          `覆盖值（profile 层）：${JSON.stringify(override)}`,
          `继承值（去掉本行覆盖后的下层结果）：${JSON.stringify(inherited)}`,
          '要改就调 action=set（先不带 apply 看预览）。',
        ].join('\n'), { entry: wanted, effective, override, inherited })
      }

      // —— 回滚：按审计记录把字段恢复成那次写入之前的值（冲突检测 + 审批 + 审计） ——
      if (action === 'revert') {
        if (typeof args.auditId !== 'string' || args.auditId.trim() === '') {
          throw new Error('revert 需要 auditId（用 action=history 查可回滚的记录）')
        }
        const auditId = args.auditId.trim()
        const record = workbench.auditLog.find((candidate) => candidate.id === auditId)
        if (record === undefined) {
          throw new Error(`找不到审计记录 "${auditId}"（审计只在插件运行期间保留；插件重挂/重启后清空，可先 action=history 查看现存记录）`)
        }
        if (record.entry !== wanted) {
          throw new Error(`审计记录 ${auditId} 属于行 "${record.entry}"，不是 "${wanted}"。回滚请用对应的 entry。`)
        }
        // 冲突检测：自那次写入之后，被改字段是否又被改过（被改过就不能盲目回滚）。
        const conflicts = []
        for (const change of record.overrideChanges ?? []) {
          const present = Object.prototype.hasOwnProperty.call(override, change.field)
          if (change.afterHad === true) {
            if (!present || !sameConfigValue(override[change.field], change.to)) {
              conflicts.push(`  - ${change.field}: 那次写入后是 ${JSON.stringify(maskSensitive(change.field, change.to))}`
                + `，现在是 ${present ? JSON.stringify(maskSensitive(change.field, override[change.field])) : '（未覆盖）'}`)
            }
          } else if (present) {
            conflicts.push(`  - ${change.field}: 那次写入后是"未覆盖"，现在被设成了 ${JSON.stringify(maskSensitive(change.field, override[change.field]))}`)
          }
        }
        if (conflicts.length > 0) {
          throw new Error(['拒绝回滚：检测到冲突——自那次写入后，这些字段又被改过：', ...conflicts,
            '请先用 action=get 看清现状；确认要覆盖现状的话，用 action=set 显式改，不要盲目回滚。'].join('\n'))
        }
        const reverted = { ...override }
        for (const change of record.overrideChanges ?? []) {
          if (change.beforeHad === true) reverted[change.field] = change.from
          else delete reverted[change.field]
        }
        const revertChanges = fieldChanges(override, reverted)
        const revertToken = previewTokenFor(wanted, override, reverted)
        const headRevert = `回滚 ${auditId}（${record.action} ${record.entry}）`
        if (args.apply !== true) {
          return result('revert', [
            `【预览·未写入】${headRevert}：把字段恢复成那次写入之前的值`,
            '',
            ...(isRequiredStartupRow(entry) ? [...requiredStartupWarning(wanted), ''] : []),
            '字段改动（技术名）：',
            ...revertChanges.map((change) => `  - ${change.field}: ${JSON.stringify(maskSensitive(change.field, change.from))} → ${JSON.stringify(maskSensitive(change.field, change.to))}`),
            '',
            `预览凭证：${revertToken}`,
            '确认无误后，请**再调用一次**同样的动作并带 `apply: true` + `previewToken`；写入前会请求你批准。',
          ].join('\n'), { entry: wanted, auditId, changes: revertChanges, preview: true, previewToken: revertToken })
        }
        if (workbench.requirePreview !== false) {
          if (typeof args.previewToken !== 'string' || args.previewToken === '') {
            throw new Error('缺少 previewToken：先不带 apply 调一次回滚预览（写入前需要凭证，防止预览后配置被别人改动）。')
          }
          if (args.previewToken !== revertToken) {
            throw new Error('预览凭证不匹配：该行在你预览之后被改动过（或凭证不属于这次回滚）。请重新预览，确认最新值后再写入。')
          }
        }
        if (workbench.approvalPolicy === 'never') {
          throw new Error('本插件的 approval 配置为 never：拒绝一切配置写入（只读模式）。')
        }
        await requestConfigApproval(ctx, exec, {
          reason: `revert config row ${wanted} (audit ${auditId})`,
          displayReason: `回滚 DSH 配置行 ${wanted}：` + revertChanges
            .map((change) => `${change.field} ${JSON.stringify(maskSensitive(change.field, change.from))} → ${JSON.stringify(maskSensitive(change.field, change.to))}`).join('；'),
        })
        await editor.edit(entry, () => reverted)
        const afterRevert = editor.configuration().find((row) => row.entry?.options?.id === wanted)
        const afterRevertOverride = afterRevert?.override ?? reverted
        const revertAuditId = appendConfigAudit(workbench, {
          action: 'revert',
          entry: wanted,
          reverts: auditId,
          overrideBefore: { ...override },
          overrideAfter: afterRevertOverride,
          overrideChanges: overrideDiff(override, afterRevertOverride),
          sessionId: exec?.agent?.session?.id ?? null,
          callId: exec?.callId ?? null,
        })
        return result('revert', [
          `【已回滚】${headRevert}`,
          `写入后的覆盖值（敏感字段已掩码）：${JSON.stringify(maskOverrideForDisplay(afterRevertOverride))}`,
          `审计记录：${revertAuditId}`,
          ...(isRequiredStartupRow(entry) ? requiredStartupWarning(wanted) : []),
        ].join('\n'), { entry: wanted, reverts: auditId, applied: true, override: afterRevertOverride, auditId: revertAuditId })
      }

      if (action === 'set' && (args.values === undefined || args.values === null || typeof args.values !== 'object'
        || Array.isArray(args.values))) {
        throw new Error('set 需要 values（要改的顶层字段对象，例如 {"openAt":"first-search"}）')
      }

      const isReset = action === 'reset'
      const next = isReset ? { ...inherited } : { ...effective, ...args.values }
      const changes = fieldChanges(effective, next)
      if (!isReset && changes.length === 0) {
        return result('set', `没有变化：${entryLabel(entry)} 的这些字段已经是目标值了。`, { entry: wanted, changes: [] })
      }
      // 读该行的 schema，预判"这次是就地热更新还是重建"——预览里"会不会打断什么"就靠它。
      const prediction = predictReconcile(entry, changes)
      const consequences = configConsequences({ entry, override, next, changes, isReset, liveSessions, prediction })
      const head = isReset
        ? `把 ${entryLabel(entry)} 的覆盖值删掉（回到继承值）`
        : `把 ${entryLabel(entry)} 改成新值`
      // 预览凭证：绑定"行 + 预览时的当前覆盖 + 目标覆盖"，写入时用当前状态重算校验（TOCTOU 防护）。
      const previewToken = previewTokenFor(wanted, override, next)

      if (args.apply !== true) {
        return result(action, [
          `【预览·未写入】${head}`,
          '',
          ...(isRequiredStartupRow(entry) ? [...requiredStartupWarning(wanted), ''] : []),
          '字段改动（技术名）：',
          ...changes.map((change) => `  - ${change.field}: ${JSON.stringify(maskSensitive(change.field, change.from))} → ${JSON.stringify(maskSensitive(change.field, change.to))}`),
          '',
          ...consequences,
          '',
          `预览凭证：${previewToken}`,
          '确认无误后，请**再调用一次**同样的动作并带 `apply: true` + `previewToken`；写入前会请求你批准。',
        ].join('\n'), { entry: wanted, changes, preview: true, previewToken, approvalPolicy: workbench.approvalPolicy })
      }

      // —— 写入前治理：预览凭证校验 → 审批（fail closed）→ 写入 → 审计 ——
      if (workbench.requirePreview !== false) {
        if (typeof args.previewToken !== 'string' || args.previewToken === '') {
          throw new Error('缺少 previewToken：先不带 apply 调一次预览（写入前需要凭证，防止预览后配置被别人改动）。')
        }
        if (args.previewToken !== previewToken) {
          throw new Error('预览凭证不匹配：该行在你预览之后被改动过（或凭证不属于这次改动）。请重新预览，确认最新值后再写入。')
        }
      }
      if (workbench.approvalPolicy === 'never') {
        throw new Error('本插件的 approval 配置为 never：拒绝一切配置写入（只读模式）。')
      }
      const overrideBefore = { ...override }
      await requestConfigApproval(ctx, exec, {
        reason: `${isReset ? 'reset' : 'set'} config row ${wanted}: ${changes.map((change) => change.field).join(',')}`,
        displayReason: `修改 DSH 配置行 ${wanted}：` + changes
          .map((change) => `${change.field} ${JSON.stringify(maskSensitive(change.field, change.from))} → ${JSON.stringify(maskSensitive(change.field, change.to))}`).join('；'),
      })
      await editor.edit(entry, () => next)
      const after = editor.configuration().find((row) => row.entry?.options?.id === wanted)
      const afterOverride = after?.override ?? next
      const auditId = appendConfigAudit(workbench, {
        action: isReset ? 'reset' : 'set',
        entry: wanted,
        overrideBefore,
        overrideAfter: afterOverride,
        overrideChanges: overrideDiff(overrideBefore, afterOverride),
        sessionId: exec?.agent?.session?.id ?? null,
        callId: exec?.callId ?? null,
      })
      const sensitiveTouched = changes.some((change) => /key|token|secret|password|credential|env/i.test(change.field))
      return result(action, [
        `【已写入】${head}`,
        '官方 `edit()` 已完成：校验完整候选 → 拿 profile 文件锁 → 原子替换覆盖 → 通过 Loader 协调该行。',
        `写入后的覆盖值（敏感字段已掩码）：${JSON.stringify(maskOverrideForDisplay(afterOverride))}`,
        `写入后的生效值（敏感字段已掩码）：${JSON.stringify(maskOverrideForDisplay({ ...(after?.inherited ?? {}), ...afterOverride }))}`,
        `审计记录：${auditId}（action=history 可查；回滚：action=revert entry=${wanted} auditId=${auditId}，先不带 apply 预览）`,
        `收据·原始覆盖值（改之前，敏感字段已掩码）：${JSON.stringify(maskOverrideForDisplay(overrideBefore))}`,
        `收据·恢复：action=reset entry=${wanted}（回到继承值）；审计还在时用 action=revert auditId=${auditId} 可精确撤销。`
          + (sensitiveTouched ? '（本次改了敏感字段：收据已掩码，手工恢复请以 revert 或自己的备份为准。）' : ''),
        ...(isRequiredStartupRow(entry) ? requiredStartupWarning(wanted) : []),
        '若这是有状态的行（索引/连接），重建已经发生；看不出效果时先查：该行是否被 home patch / 命令行 overlay 覆盖、写入是否被 HMR watch 捕获（约 2 秒），并用 cordis_inspect_query 看行/服务状态；不要据此推断需要重启。',
      ].join('\n'), { entry: wanted, changes, applied: true, override: afterOverride, auditId })
    },
  }))

}
