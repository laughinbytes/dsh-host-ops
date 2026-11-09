#!/usr/bin/env node
/**
 * verify-dsh-host-ops.mjs —— 在**不装进 profile** 的前提下验证 dsh-host-ops 的逻辑。
 *
 * 为什么不直接跑真实 DSH：`desktop` profile 是 App 独占的，CLI 起不来；
 * 而工具注册只需要 `ctx.tools.register(definition)`，所以这里用假的
 * `workspaceRegistry` / `sessionQuery` / `sessions` / `sessionTitle` 把
 * `lib/index.js` 加载起来，拿到两个 `ToolDefinition` 的 `execute` 直接调用。
 *
 * 覆盖的**是**：过滤/排序/归属计算、参数校验、写操作的前置检查与幂等、
 * 批量排序的落位算法、错误信息。
 * 覆盖的**不是**：真实 dsh 服务的行为、真实 store 的会话创建、
 * `defineTool` 的参数 schema 编译（那部分由 `node` 加载真实 dsh-tools 覆盖，
 * 见本脚本末尾的 "schema 编译" 一节）。
 *
 * 用法：node scripts/verify-dsh-host-ops.mjs
 *
 * @module verify-dsh-host-ops
 */

import { createHash as nodeCreateHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = path.join(ROOT)

let failures = 0
let checks = 0

/**
 * 断言并记账。
 * @param condition - 断言条件。
 * @param label - 断言语义。
 * @param detail - 失败时附带的细节。
 */
function check(condition, label, detail) {
  checks++
  if (condition) {
    console.log(`   ✓ ${label}`)
    return
  }
  failures++
  console.log(`   ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 断言调用抛出，且消息含给定片段。
 * @param label - 断言语义。
 * @param fragment - 期望出现在错误消息里的片段。
 * @param run - 被调用的异步函数。
 */
async function checkThrows(label, fragment, run) {
  checks++
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(fragment)) {
      console.log(`   ✓ ${label}`)
      return
    }
    failures++
    console.log(`   ✗ ${label} — 抛了错但消息不含 "${fragment}"：${message}`)
    return
  }
  failures++
  console.log(`   ✗ ${label} — 没有抛错`)
}

/* ------------------------------------------------------------------ *
 * 假 DSH：数据形状逐条照抄调研到的真实实现
 * ------------------------------------------------------------------ */

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0) // 2026-10-11T03:00:00Z
const HOUR = 3_600_000

/**
 * 造一个会话头。
 * @param id - 会话 id。
 * @param options - `createdAt` / `cwd` / `origin` / `parentSession`。
 * @returns 真实 `SessionHeader` 形状的对象。
 */
function header(id, options = {}) {
  return {
    version: 4,
    id,
    createdAt: options.createdAt ?? NOW,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    isSeeded: options.parentSession !== undefined,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  }
}

/**
 * 造一个工作区实体（含本插件用到的全部成员）。
 * @param id - 工作区 id。
 * @param title - 标题。
 * @param dir - 目录。
 * @param sessionIds - 登记的会话 id（顺序即侧边栏顺序）。
 * @param recent - 最近添加的会话 id 列表（`attachSession` 会 unshift 进来）。
 * @returns 工作区实体。
 */
function entity(id, title, dir, sessionIds, recent = []) {
  const record = { sessionIds: [...sessionIds], path: dir, title }
  return {
    id,
    get path() {
      return record.path
    },
    get title() {
      return record.title
    },
    get sessionIds() {
      return [...recent, ...record.sessionIds]
    },
    get createdAt() {
      return '2026-10-01T00:00:00.000Z'
    },
    get updatedAt() {
      return '2026-10-10T00:00:00.000Z'
    },
    async setTitle(next) {
      record.title = next
    },
    async attachSession(sessionId) {
      if (!record.sessionIds.includes(sessionId) && !recent.includes(sessionId)) recent.unshift(sessionId)
    },
    // 真实注册表只有一个有序数组；这个假实体把"新建即入队首"单独放在 recent，
    // 所以视图要按 recent → 登记顺序拼接，才能反映真实队首语义。
    __ids: () => [...recent, ...record.sessionIds],
    async insertSessionBefore(sessionId, beforeSessionId) {
      const all = [...record.sessionIds, ...recent]
      if (!all.includes(sessionId)) throw new Error(`cannot move session '${sessionId}': not accounted`)
      if (beforeSessionId !== undefined && !all.includes(beforeSessionId)) {
        throw new Error(`cannot move session '${sessionId}' before '${beforeSessionId}': anchor not accounted`)
      }
      const without = all.filter((id2) => id2 !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const next = [...without.slice(0, at), sessionId, ...without.slice(at)]
      record.sessionIds = next
      recent.length = 0
    },
    async detachSession(sessionId) {
      record.sessionIds = record.sessionIds.filter((id2) => id2 !== sessionId)
    },
    async status() {
      return record.missingDir === true ? 'missing-dir' : 'ok'
    },
    markMissing() {
      record.missingDir = true
    },
  }
}

/** 构造一套假上下文与三个工作区。 */
function makeWorld() {
  const wA = entity('w-aaa', 'default-workspace', '/proj/a', ['s-a1', 's-a2', 's-a3'])
  const wB = entity('w-bbb', 'cloudflare-ops', '/proj/b', ['s-b1', 's-b2'])
  const wC = entity('w-ccc', 'dsh-dev', '/proj/c', [])
  wC.markMissing()
  const workspaces = [wA, wB, wC]

  const headers = new Map([
    ['s-a1', header('s-a1', { createdAt: NOW - 30 * HOUR, cwd: '/proj/a' })],
    ['s-a2', header('s-a2', { createdAt: NOW - 20 * HOUR, cwd: '/proj/a' })],
    ['s-a3', header('s-a3', { createdAt: NOW - 10 * HOUR, cwd: '/proj/a' })],
    ['s-b1', header('s-b1', { createdAt: NOW - 40 * HOUR, cwd: '/proj/b' })],
    ['s-b2', header('s-b2', { createdAt: NOW - 5 * HOUR, cwd: '/proj/b', origin: 'subagent' })],
    ['s-u1', header('s-u1', { createdAt: NOW - 2 * HOUR, cwd: '/elsewhere' })],
    ['s-u2', header('s-u2', { createdAt: NOW - 1 * HOUR, cwd: '/elsewhere' })],
  ])
  const titles = new Map([
    ['s-a1', '写插件骨架'],
    ['s-a2', 'Zeta 排序实验'],
    ['s-a3', 'alpha 收尾'],
    ['s-b1', 'Cloudflare 权限'],
    ['s-u1', '未分组的一条'],
  ])
  // s-u2、s-b2 刻意没有标题，覆盖“无标题”分支。
  // 当前生效 preset（`agentPreset` Session projection）的假数据：header 是创建事实，
  // projection 才可能被 `agent-preset/selected` 改过（例如 2026-10-29 的 repair 脚本）。
  const currentPresets = new Map()

  const state = {
    archivedIds: new Set(),
    pinnedIds: [],
    activity: new Map(),
    detached: [],
  }
  /** 故障注入开关（caveat 2：把"静默降级"变成可断言的测试）。 */
  const faults = {}

  const registry = {
    list: () => [...workspaces],
    get: (id) => workspaces.find((workspace) => workspace.id === id),
    create: async (dir, title) => {
      const created = entity(`w-${dir.split('/').pop()}`, title ?? dir.split('/').pop(), dir, [])
      workspaces.push(created)
      return created
    },
    resolveByPath: async (dir) => workspaces.find((workspace) => workspace.path === dir),
    delete: async (id) => {
      const index = workspaces.findIndex((workspace) => workspace.id === id)
      if (index < 0) return false
      workspaces.splice(index, 1)
      return true
    },
    insertBefore: async (id, beforeId) => {
      const ids = workspaces.map((workspace) => workspace.id)
      if (!ids.includes(id)) throw new Error(`cannot reorder unknown workspace '${id}'`)
      if (beforeId !== undefined && !ids.includes(beforeId)) throw new Error(`cannot reorder before unknown '${beforeId}'`)
      const moved = workspaces.find((workspace) => workspace.id === id)
      const without = workspaces.filter((workspace) => workspace.id !== id)
      const at = beforeId === undefined ? without.length : without.findIndex((workspace) => workspace.id === beforeId)
      without.splice(at, 0, moved)
      workspaces.splice(0, workspaces.length, ...without)
      return workspaces.map((workspace) => workspace.id)
    },
    sessionKnown: async (id) => headers.has(id),
    archiveSession: async (id, options = {}) => {
      if (!headers.has(id)) throw new Error(`cannot archive session '${id}': unknown`)
      const activity = state.activity.get(id)
      if (activity !== undefined && options.stopActivity !== true) {
        const error = new Error(`cannot archive session '${id}': the session is active (${activity.join(', ')})`)
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
      state.archivedIds.add(id)
      state.pinnedIds = state.pinnedIds.filter((pinned) => pinned !== id)
    },
    unarchiveSession: async (id) => {
      state.archivedIds.delete(id)
    },
    pinSession: async (id) => {
      if (!headers.has(id)) throw new Error(`cannot pin session '${id}': unknown`)
      if (state.archivedIds.has(id)) {
        const error = new Error(`cannot pin session '${id}': the session is archived`)
        error.name = 'WorkspaceArchivedSessionPinError'
        throw error
      }
      state.pinnedIds = [id, ...state.pinnedIds.filter((pinned) => pinned !== id)]
    },
    unpinSession: async (id) => {
      state.pinnedIds = state.pinnedIds.filter((pinned) => pinned !== id)
    },
    get archivedSessionIds() {
      return [...state.archivedIds]
    },
    get pinnedSessionIds() {
      return [...state.pinnedIds]
    },
  }

  const sessionQuery = {
    /**
     * 每次 `readTitleSnapshots()` 收到的 id 列表。
     * `list` 的分组摘要只该读"每个工作区一条最近会话"的标题——本机有 520 条会话，
     * 如果摘要也像 `collect()` 那样全量读标题，这次修复就等于白做。断言靠它守住。
     */
    titleReads: [],
    listSessions: async () => {
      if (faults.querySessions === true) throw new Error('query boom')
      return [...headers.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((entry) => ({ header: { ...entry }, live: false, persisted: true }))
    },
    readTitleSnapshots: async (ids) => {
      sessionQuery.titleReads.push([...ids])
      return ids.map((id) => {
        if (!headers.has(id)) return { status: 'rejected', reason: new Error(`not found: ${id}`) }
        const title = titles.get(id)
        return {
          status: 'fulfilled',
          value: {
            session: { ...headers.get(id) },
            /*
             * 真实服务给的是**快照对象**，不是字符串：
             * `readTitleSnapshots()` 兑现 `{ session, title? }`，`title` 来自
             * `foldSessionTitle(events)` → `titleSnapshotFromState()`
             * （`@deepseek-ai/dsh-session-title`），形状是
             * `{ title, messageSeqs, source, eventSeq, updatedAt }`。
             * 这里必须照真实形状造，否则「标题渲染成 [object Object]」这类
             * 缺陷会被假 DSH 掩盖（实际发生过一次）。
             */
            ...(title === undefined ? {} : {
              title: {
                title,
                messageSeqs: [],
                source: { kind: 'fallback' },
                eventSeq: 1,
                updatedAt: headers.get(id).createdAt,
              },
            }),
          },
        }
      })
    },
    /**
     * 冷会话的一次性观察（真实实现见 `dsh-session-query/lib/index.js` 的 `observeSession`）：
     * 返回 `{header, projections: {asOfSeq, values}, [Symbol.dispose]}`；`values.agentPreset`
     * 是当前有效 preset（`agentPreset` Session projection）。
     */
    observeSession: async (id) => {
      if (!headers.has(id)) {
        const error = new Error(`session "${id}" not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      const source = headers.get(id)
      return {
        source: 'prepared',
        header: { ...source },
        projections: {
          asOfSeq: 3,
          values: { agentPreset: currentPresets.get(id) ?? source.agentPreset ?? null },
        },
        [Symbol.dispose]: () => {},
      }
    },
  }

  const liveSessions = new Map()
  const sessions = {
    create: (id, options) => {
      const session = { id, header: header(id, { cwd: options?.meta?.cwd }) }
      liveSessions.set(id, session)
      headers.set(id, session.header)
      return session
    },
    get: (id) => liveSessions.get(id),
    list: () => [...liveSessions.values()],
    /** 真实 `sessions.flush(session)`：把持久化回调结算干净；这里只记录调用顺序。 */
    flush: async (session) => {
      resumeLog.push(['flush', session.id])
    },
  }

  const sessionTitle = {
    get: (session) => {
      if (faults.titles === true) throw new Error('titles boom')
      return titles.has(session.id) ? { title: titles.get(session.id) } : undefined
    },
    rename: (session, title) => {
      if (liveSessions.get(session.id) !== session) throw new Error(`session "${session.id}" is not live in this store`)
      const normalized = title.trim()
      if (normalized === '') throw new Error('session title must contain visible characters')
      if (normalized === 'BOOM') throw new Error('title rejected (test marker)')
      resumeLog.push(['rename', session.id, normalized])
      titles.set(session.id, normalized)
      return { title: normalized, eventSeq: 7, source: { kind: 'user' } }
    },
  }

  /** `resume` / `flush` / `dispose` 的调用顺序，用来断言 teardown 真的发生了。 */
  const resumeLog = []
  /** host 发给客户端的会话列表事件（`api-session/*`），用来断言"移除后补回"。 */
  const emitLog = []
  /**
   * 假 `agents` 服务：形状照 `@deepseek-ai/dsh-agent` + `dsh-agent-loop` 造——
   * `resume({ resumeSessionId })` 返回 handle（`agent.session` + `dispose`），
   * `dispose()` 把会话从活表里摘掉（等价于真实的 detachAgent + detachSession）。
   * `s-u2` 是 dispose 失败用例的标记。
   */
  const agents = {
    /** 已加载的 agent（`preset` 动作要求会话在内存里；真实服务里空白会话打开即加载）。 */
    get: (sessionId) => liveSessions.get(sessionId),
    list: () => [...liveSessions.values()],
    resume: async ({ resumeSessionId }) => {
      if (!headers.has(resumeSessionId)) throw new Error(`session "${resumeSessionId}" not found`)
      resumeLog.push(['resume', resumeSessionId])
      const session = liveSessions.get(resumeSessionId) ?? { id: resumeSessionId, header: headers.get(resumeSessionId) }
      liveSessions.set(resumeSessionId, session)
      return {
        agent: { session },
        dispose: async () => {
          resumeLog.push(['dispose', resumeSessionId])
          if (resumeSessionId === 's-u2') throw new Error('dispose failed (test marker)')
          if (liveSessions.get(resumeSessionId) === session) liveSessions.delete(resumeSessionId)
          // 真实链路：detachSession() → `session/disposed` → 控制器 emit `api-session/removed`，
          // 客户端据此把这一行从列表里删掉。
          emitLog.push(['api-session/removed', resumeSessionId])
        },
      }
    },
  }

  /** 假 `sessionController`：客户端列表行快照 `listState.summaryFor(session)` + 冷会话的 `summarizeCold(header)`。 */
  const sessionController = {
    /** 新增动作用到的官方方法的调用记录（断言形状用）。 */
    cancelCalls: [],
    selectModelCalls: [],
    openPathCalls: [],
    /** `search` 的返回（用例里改）。 */
    searchResult: { items: [], hasMore: false },
    /** `events` 的返回（用例里改）：数组元素是原始 event，包成官方 records 形状。 */
    eventRecords: [],
    hasMoreEvents: false,
    /** 最近一次 `events` 请求（断言 address/maxMessages/beforeSeq）。 */
    lastEventsRequest: null,
    /** `updateQueue`（queue 动作的 edit/remove/steer）收到的请求。 */
    queueUpdates: [],
    /**
     * `projections({ sessionId })` 的假返回（官方 no-load 读 inbox 的路径）。
     *
     * **形状必须照真实 wire 形状造**（2026-11-02 修复）：真实 `inbox` 投影是
     * `InboxWireState`，键是 kebab-case `next-turn` / `next-step`（不是 `Inbox` 类型上的
     * `nextTurn` / `nextStep`）。假桩用 camelCase 曾让"永远读成空队列"的 P1 缺陷在 359 项
     * 断言里全绿溜过去——不要再改回 camelCase。
     */
    inboxProjection: { 'next-turn': [], 'next-step': [] },
    projectionsCalls: [],
    projections: async (request) => {
      sessionController.projectionsCalls.push(request.sessionId)
      return {
        sessionId: request.sessionId,
        projections: { kind: 'sequenced', asOfSeq: 1, values: { inbox: sessionController.inboxProjection } },
        values: { inbox: sessionController.inboxProjection },
      }
    },
    cancel: async (request) => {
      sessionController.cancelCalls.push(request.sessionId)
      return { accepted: true }
    },
    updateQueue: async (request) => {
      sessionController.queueUpdates.push(request)
      return {}
    },
    search: async (request) => {
      sessionController.lastSearchRequest = request
      return sessionController.searchResult
    },
    events: async (request) => {
      sessionController.lastEventsRequest = request
      return {
        records: sessionController.eventRecords.map((event) => ({ type: 'event', event })),
        hasMore: sessionController.hasMoreEvents === true,
      }
    },
    fork: async () => ({ sessionId: 'session-forked' }),
    openWorkspacePath: async (request) => {
      sessionController.openPathCalls.push(request)
      return { opened: true }
    },
    selectModel: async (request) => {
      sessionController.selectModelCalls.push(request)
      return { selected: { provider: request.provider, model: request.model } }
    },
    /** `resolveAgent` 收到的会话（官方要求先 resume 再投递）。 */
    resolved: [],
    /** `prompt` 收到的请求（断言投递形状用）。 */
    promptCalls: [],
    resolveAgent: async (sessionId) => {
      sessionController.resolved.push(sessionId)
      return { agent: { id: sessionId } }
    },
    prompt: async (request) => {
      sessionController.promptCalls.push(request)
      return { accepted: true }
    },
    list: async () => {
      if (faults.controllerList === true) throw new Error('list boom')
      return { items: [] }
    },
    listState: {
      summaryFor: (session) => {
        if (faults.privateSummary === true) throw new Error('private summary boom')
        // 真实实现会把 projections（含 title 单元）打进这份快照；这里用当前标题代表它。
        const current = titles.get(session.id) ?? null
        resumeLog.push(['summary', session.id, current])
        return {
          sessionId: session.id,
          updatedAt: 1,
          running: true,
          agentAvailable: true,
          title: current,
        }
      },
      /**
       * 官方对"未加载但已持久化"的会话就是这么造 summary 的
       * （`dsh-api-session-controller/lib/index.js` 的 `summarizeCold`）：
       * 只有 header、恒为不运行。这里照抄形状，供 pin / archive 这类冷会话路径断言。
       */
      summarizeCold: ({ header, formatStatus } = {}) => {
        if (faults.privateSummary === true) throw new Error('private summary boom')
        return ({
        sessionId: header.id,
        updatedAt: header.createdAt,
        running: false,
        agentAvailable: false,
        blank: false,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      })
      },
    },
  }

  return { registry, sessionQuery, sessions, sessionTitle, agents, sessionController, resumeLog, emitLog, state, workspaces, headers, titles, currentPresets, faults, warnings: [] }
}

/* ------------------------------------------------------------------ *
 * 加载插件：把三个 import 换成本地桩，其余代码原样执行
 * ------------------------------------------------------------------ */

/**
 * 读取插件源码并把 import 换成注入的桩，返回 `apply`。
 * @param ctx - 假 cordis 上下文。
 * @returns 插件模块的具名导出。
 */
async function loadPlugin(ctx, config = {}) {
  const source = fs.readFileSync(path.join(PLUGIN, 'lib', 'index.js'), 'utf8')
  const withStubs = source
    .replace(
      "import z from '@deepseek-ai/schemastery'",
      'const z = {'
        + ' object: (shape) => ({ __shape: shape }),'
        + ' string: () => ({ default: (value) => ({ __default: value }) }),'
        + ' number: () => ({ default: (value) => ({ __default: value }) }),'
        + ' boolean: () => ({ default: (value) => ({ __default: value }) }),'
        + ' array: (item) => ({ default: (value) => ({ __array: item, __default: value }) }),'
        + ' }',
    )
    .replace(
      "import { createHash } from 'node:crypto'",
      'const createHash = __CREATE_HASH',
    )
    .replace(
      "import { defineTool } from '@deepseek-ai/dsh-tools'",
      'const defineTool = (options) => options',
    )
    .replace(/\bexport const\b/g, 'const')
    .replace(/\bexport function apply\b/g, 'function apply')
  const factory = new Function(
    'CONFIG_INJECT',
    '__CREATE_HASH',
    `${withStubs}\nreturn { name, inject, Config, apply, __ctx: CONFIG_INJECT }\n`,
  )
  const module = factory(ctx, nodeCreateHash)
  // 让插件真正跑一遍注册，拿到工具定义。
  module.apply(ctx, config)
  return module
}

/**
 * 造一个"能注册工具"的假 cordis 上下文。
 * @param world - `makeWorld()` 的产物。
 * @param services - 额外服务，如 `sessions` / `sessionTitle`。
 * @returns 捕获已注册工具的上下文。
 */
function makeCtx(world, services = {}) {
  const tools = new Map()
  /**
   * 假 `configEditor`（官方 `@deepseek-ai/dsh-config-editor` 的形状）：
   * `entries()` → 行；`configuration()` → {entry, inherited, override}；`edit(entry, change)` → 应用并记录。
   * 只实现被工具用到的部分。
   */
  const configRows = world.configRows ?? (world.configRows = [
    { id: 'fake-row', name: '@local/fake-row', inherited: { alpha: 1, beta: 'kept' }, override: { alpha: 2 } },
    { id: 'plain-row', name: '@local/plain-row', inherited: { gamma: true }, override: {} },
    { id: 'pinned-row', name: '@local/pinned-row', inherited: { alpha: 1 }, override: { alpha: 1, beta: 2 } },
  ])
  /** Schemastery 形状的 Config：`dict[field].meta.volatile` 就是 Loader 判"就地更新"的依据。 */
  const schemas = {
    'fake-row': { type: 'object', dict: { alpha: { meta: { volatile: true } }, beta: {} } },
    'plain-row': { type: 'object', dict: { gamma: {} } },
    'pinned-row': { type: 'object', dict: { alpha: { meta: { volatile: true } }, beta: { meta: { volatile: true } } } },
  }
  for (const row of configRows) {
    if (row.entry === undefined) {
      row.entry = {
        options: { id: row.id, name: row.name },
        fiber: { state: 2, runtime: { Config: schemas[row.id] ?? { type: 'object', dict: {} } } },
      }
    }
  }
  const configEditor = {
    entries: () => configRows.map((row) => row.entry),
    configuration: () => configRows.map((row) => ({ entry: row.entry, inherited: { ...row.inherited }, override: { ...row.override } })),
    edit: async (entry, change) => {
      configEditor.edits.push({ id: entry?.options?.id, next: change({ ...entry?.options?.config }, {}) })
      const row = configRows.find((candidate) => candidate.id === entry?.options?.id)
      const next = change({ ...row?.override }, { ...row?.inherited })
      if (row !== undefined) row.override = next
    },
    edits: [],
  }

  const emitLog = world.emitLog ?? []
  /** 假审批服务：记录请求，按 `world.approvalOutcome` 返回（默认 allowed-once）。 */
  world.approval = world.approval ?? {
    calls: [],
    async request(request) {
      this.calls.push(request)
      return world.approvalOutcome ?? 'allowed-once'
    },
  }
  /** `ctx.on(...)` 注册的监听器（新原语测试要触发 session/event）。 */
  const listeners = []
  /** 这个上下文里排下的定时器。 */
  const timers = []
  return {
    workspaceRegistry: world.registry,
    sessionQuery: world.sessionQuery,
    tools: {
      register: (definition) => tools.set(definition.name, definition),
    },
    get: (id) => (id === 'configEditor'
      ? configEditor
      : id === 'approval' ? (world.approval ?? services.approval) : services[id]),
    emit: (name, payload) => {
      emitLog.push([name, payload])
    },
    on: (name, listener) => {
      listeners.push({ name, listener })
      return () => {
        const index = listeners.findIndex((entry) => entry.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    /** 测试用：触发某个事件，模拟 Host 的 `session/event`。 */
    __fire: (name, ...args) => {
      for (const entry of [...listeners]) {
        if (entry.name === name) entry.listener(...args)
      }
    },
    logger: { warn: (message) => { world.warnings.push(String(message)) } },
    /** 可控定时器：延后投递第一条指令用它，测试里直接 flush。 */
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    __tools: tools,
    __timers: timers,
  }
}

/* ------------------------------------------------------------------ *
 * 跑测
 * ------------------------------------------------------------------ */

/**
 * 接管 `globalThis.setTimeout`：插件**现在一个定时器都不排**（第一条指令是立刻投递的），
 * 这条接管是用来**守住这个结论**的——一旦有人再把投递改成"延时"，下面那条
 * "不排任何定时器"的断言会立刻失败。顺带记住那个坑：延时要用 `globalThis.setTimeout`，
 * `ctx.setTimeout` 绑在工具调用的作用域上、调用结束就被回收（2026-10-15 实测踩到）。
 * 测试里**接管它**：既不用真等 2.5 秒，也能让"建会话"的用例安心带上 prompt。
 */
const realSetTimeout = globalThis.setTimeout
const pendingTimers = []
globalThis.setTimeout = (fn, ms) => {
  pendingTimers.push({ fn, ms })
  return pendingTimers.length
}
/** 跑掉所有排下的定时器（含其中再排的，有限次）。 */
async function flushTimers() {
  for (let round = 0; round < 5 && pendingTimers.length > 0; round += 1) {
    const batch = pendingTimers.splice(0)
    for (const timer of batch) await timer.fn()
  }
}

const world = makeWorld()
/**
 * 插件运行期要用的服务集合。
 *
 * - `sessionProjections.stateOf(session, 'agentPreset')`：**当前**生效 preset 的权威来源
 *   （真实实现是 `agentPreset` Session projection；header 只是创建事实）。
 */
const services = {
  workspaceRegistry: world.registry,
  sessions: world.sessions,
  sessionTitle: world.sessionTitle,
  agents: world.agents,
  sessionController: world.sessionController,
  sessionProjections: {
    stateOf: (session, key) => (key === 'agentPreset'
      ? (world.currentPresets.get(session.id) ?? session.header.agentPreset ?? null)
      : undefined),
  },
}
const ctx = makeCtx(world, services)

/**
 * 读一个工作区**当前**的成员顺序。
 * 假实体每次 get 都返回新数组，直接比较属性会拿到过期快照，所以统一走 __ids()。
 * @param id - 工作区 id。
 * @returns 会话 id 数组。
 */
function idsOf(id) {
  return world.registry.get(id).__ids()
}
const plugin = await loadPlugin(ctx)
const workspaceTool = ctx.__tools.get('dsh_workspace_manage')
const sessionTool = ctx.__tools.get('dsh_session_manage')

console.log('dsh-host-ops 逻辑验证\n')
check(plugin.name === 'dsh-host-ops', '插件名导出正确')
check(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), 'inject 声明了 tools')
check(workspaceTool !== undefined && sessionTool !== undefined, '工作区与会话工具都已注册到 ctx.tools')

/** 调一次工具，解出 JSON 载荷。 */
const TEST_EXEC = { signal: undefined, agent: { session: { id: 'caller-session' } }, callId: 'call-1' }
async function call(tool, args, exec = TEST_EXEC) {
  const value = await tool.execute(args, exec)
  return { text: value.message, data: value.data === undefined ? undefined : JSON.parse(value.data), raw: value }
}

/* ---- 工作区：list / get ---- */
console.log('\n[工作区] list / get')
const listed = await call(workspaceTool, { action: 'list' })
check(listed.data.workspaces.length === 3, 'list 返回 3 个工作区', String(listed.data.workspaces.length))
check(listed.data.workspaces[0].workspaceId === 'w-aaa', 'list 保持注册表顺序')
check(listed.data.workspaces[2].directory === 'missing-dir', '目录缺失被标出')
check(listed.data.ungroupedCount === 2, 'ungrouped 计数为 2', String(listed.data.ungroupedCount))
check(listed.text.includes('未分组会话：2 个'), 'list 文本带未分组计数')

const gotA = await call(workspaceTool, { action: 'get', workspaceId: 'w-aaa' })
check(gotA.data.sessions.map((row) => row.sessionId).join(',') === 's-a1,s-a2,s-a3', 'get 保持工作区内人工顺序')
check(gotA.data.sessions[0].title === '写插件骨架', 'get 带出标题')
check(gotA.data.sessions[0].workspaceId === 'w-aaa', 'get 带出归属')

await checkThrows('get 未知工作区报错并列出已知工作区', '找不到工作区', () => call(workspaceTool, { action: 'get', workspaceId: 'nope' }))

/* ---- 工作区：create ---- */
console.log('\n[工作区] create / rename / remove')
const created = await call(workspaceTool, { action: 'create', path: '/proj/b' })
check(created.data.created === false && created.data.workspace.workspaceId === 'w-bbb', 'create 幂等：已注册目录直接返回原记录')

const createdNew = await call(workspaceTool, { action: 'create', path: '/proj/new' })
check(createdNew.data.created === true && createdNew.data.workspace.workspaceId === 'w-new', 'create 新目录返回 created:true')
check(world.workspaces.length === 4, '新工作区进入注册表')

const renamed = await call(workspaceTool, { action: 'rename', workspaceId: 'w-new', title: '新项目' })
check(renamed.text.includes('已重命名'), 'rename 生效')
check(world.registry.get('w-new').title === '新项目', '标题真的写进了实体')
const renamedAgain = await call(workspaceTool, { action: 'rename', workspaceId: 'w-new', title: '新项目' })
check(renamedAgain.text.includes('未改动'), 'rename 同值幂等')
await checkThrows('rename 拒绝空标题', '非空的 title', () => call(workspaceTool, { action: 'rename', workspaceId: 'w-new', title: '   ' }))

/* ---- 工作区：reorder ---- */
console.log('\n[工作区] reorder')
const reordered = await call(workspaceTool, { action: 'reorder', order: ['w-ccc', 'w-aaa', 'w-new', 'w-bbb'] })
check(
  world.workspaces.map((workspace) => workspace.id).join(',') === 'w-ccc,w-aaa,w-new,w-bbb',
  'reorder 精确落位',
  world.workspaces.map((workspace) => workspace.id).join(','),
)
check(reordered.data.workspaceIds.join(',') === 'w-ccc,w-aaa,w-new,w-bbb', 'reorder 回报最终顺序')
await checkThrows('reorder 拒绝缺项', 'order 必须恰好覆盖', () => call(workspaceTool, { action: 'reorder', order: ['w-ccc'] }))
await checkThrows('reorder 拒绝重复项', '重复', () => call(workspaceTool, { action: 'reorder', order: ['w-aaa', 'w-aaa', 'w-bbb', 'w-ccc'] }))

/* ---- 工作区：remove ---- */
console.log('\n[工作区] remove')
const removed = await call(workspaceTool, { action: 'remove', workspaceId: 'w-new' })
check(removed.text.includes('目录与全部会话历史均保留'), 'remove 明确说明不删数据')
check(world.registry.get('w-new') === undefined, 'remove 真的移除了注册')
await checkThrows('remove 未知工作区报错', '找不到工作区', () => call(workspaceTool, { action: 'remove', workspaceId: 'w-new' }))

/* ---- 会话：list 的两种语义 ---- */
console.log('\n[会话] list：分组摘要 / 按工作区 / 过滤')

/*
 * 没有 workspaceId / cwd：返回按工作区分组的摘要，而不是把本机 520 条全量会话铺开。
 * 这条分支是 2026-10-29 的易用性修复：模型明明要"dsh-dev 最近 5 条"，拿到全量后
 * 不知道要补 workspaceId，最后去 bash 翻 ~/.dsh/storages（22 步没收敛）。
 */
const titleReadsBefore = world.sessionQuery.titleReads.length
const summary = await call(sessionTool, { action: 'list' })
check(summary.data.grouped === true, '无 workspaceId 的 list 走分组摘要（data.grouped）')
check(summary.data.sessions === undefined && summary.data.total === undefined, '分组摘要不再返回扁平会话数组')
check(summary.data.listedCount === 7, '摘要统计全部 7 条会话', String(summary.data.listedCount))
check(summary.data.workspaceCount === 3, '摘要按工作区分组：3 个工作区', String(summary.data.workspaceCount))
check(summary.data.workspaces.map((row) => row.workspaceId).join(',') === 'w-ccc,w-aaa,w-bbb', '摘要保持侧边栏工作区顺序')
check(
  summary.data.workspaces[1].title === 'default-workspace'
    && summary.data.workspaces[1].sessionCount === 3
    && summary.data.workspaces[1].activeSessionCount === 3,
  '每个工作区带标题 / 会话数 / 未归档数',
)
check(
  summary.data.workspaces[1].latestSession?.title === 'alpha 收尾',
  '摘要带最近一条会话的标题',
  String(summary.data.workspaces[1].latestSession?.title),
)
check(
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(summary.data.workspaces[1].latestSession?.createdAt ?? ''),
  '最近会话时间是 YYYY-MM-DD HH:mm 文本',
  String(summary.data.workspaces[1].latestSession?.createdAt),
)
check(summary.data.workspaces[2].latestSession?.title === null, '无标题的最近会话按 null 回传')
check(summary.data.workspaces[0].sessionCount === 0 && summary.data.workspaces[0].latestSession === null, '空工作区 sessionCount=0、latestSession=null')
check(summary.data.ungroupedCount === 2 && summary.data.archivedCount === 0, '摘要带未分组 / 归档计数')
check(summary.text.split('\n').filter((line) => /^\d+\. /.test(line)).length === 3, '摘要每个工作区恰好一行')
check(summary.text.includes('最近：「alpha 收尾」'), '摘要行里带最近会话标题')
check(!/s-[a-z]\d/.test(summary.text), '摘要不再铺开会话行（文本里没有会话 id）')
check(summary.text.includes('未分组会话：2 条'), '摘要提示未分组会话怎么看')
check(
  summary.text.includes('要列某个工作区的会话，传 workspaceId（可用 dsh_workspace_manage list 获取）或 cwd。'),
  '摘要最后给出明确提示：传 workspaceId 或 cwd',
)
// 性能守卫：摘要只读"每个工作区一条最近会话"的标题（2 个非空工作区），不是全部 7 条。
const summaryTitleReads = world.sessionQuery.titleReads.slice(titleReadsBefore)
check(
  summaryTitleReads.length === 1 && summaryTitleReads[0].length === 2,
  '摘要只批量读 2 条标题（= 有会话的工作区数，不是 7 条全量）',
  JSON.stringify(summaryTitleReads),
)

// 传 workspaceId：保持旧的扁平列表语义，并在表头带工作区标题。
const inA = await call(sessionTool, { action: 'list', workspaceId: 'w-aaa' })
check(inA.data.grouped === undefined && inA.data.total === 3, '按工作区过滤仍返回扁平列表，命中 3 条', String(inA.data.total))
check(inA.data.sessions.map((row) => row.sessionId).join(',') === 's-a1,s-a2,s-a3', '工作区内按人工顺序')
check(inA.data.workspaceTitle === 'default-workspace', 'data 里回报 workspaceTitle')
check(inA.text.startsWith('工作区："default-workspace"'), '表头带工作区标题')
check(inA.text.includes('— "default-workspace"'), '行上带工作区标题')

// cwd 是 workspaceId 的另一种写法，同样只列该工作区的会话。
const inAByCwd = await call(sessionTool, { action: 'list', cwd: '/proj/a' })
check(inAByCwd.data.workspaceId === 'w-aaa' && inAByCwd.data.total === 3, 'cwd 能反查工作区并列出其会话')
check(inAByCwd.text.includes('"default-workspace"'), 'cwd 方式同样在表头带工作区标题')
await checkThrows('list 未注册的 cwd 报错并给指引', '还没有注册为工作区', () => call(sessionTool, { action: 'list', cwd: '/nope' }))
await checkThrows(
  'list 同时给 workspaceId 与 cwd 报错',
  '只能给 workspaceId 或 cwd 其中之一',
  () => call(sessionTool, { action: 'list', workspaceId: 'w-aaa', cwd: '/proj/a' }),
)

// 显式行级过滤仍然返回扁平列表（否则 ungrouped:true 的提示会绕回摘要）。
const ungrouped = await call(sessionTool, { action: 'list', ungrouped: true })
check(ungrouped.data.total === 2 && ungrouped.data.grouped === undefined, 'ungrouped 显式过滤命中的是扁平列表')

const subs = await call(sessionTool, { action: 'list', kind: 'subagent' })
check(subs.data.total === 1 && subs.data.sessions[0].sessionId === 's-b2', 'kind=subagent 过滤正确')

const limited = await call(sessionTool, { action: 'list', workspaceId: 'w-aaa', limit: 2 })
check(limited.data.sessions.length === 2 && limited.data.total === 3, '按工作区列表：limit 只截断展示不改总数')
check(limited.text.includes('显示前 2 个（用 limit 调大）'), '截断时明确说明怎么取更多')

const summaryLimited = await call(sessionTool, { action: 'list', limit: 2 })
check(summaryLimited.data.workspaces.length === 2 && summaryLimited.data.truncated === true, '摘要的 limit 限制工作区行数并标注 truncated')
check(summaryLimited.text.includes('只显示前 2 个工作区'), '摘要截断时在文本里说明')

/*
 * 默认 limit 必须是"有界"的：本机 520 条会话如果一次全铺出来，等于把这次修复做回去。
 * 临时造一个 60 条会话的工作区验证默认值 = 50；用完立刻从假世界移除，不污染后续断言。
 */
const bulk = entity('w-bulk', 'bulk', '/proj/bulk', [])
const bulkIds = []
for (let index = 0; index < 60; index++) {
  const id = `s-bulk-${String(index).padStart(2, '0')}`
  bulkIds.push(id)
  world.headers.set(id, header(id, { createdAt: NOW - index * 60_000, cwd: '/proj/bulk' }))
  world.titles.set(id, `批量会话 ${index}`)
  await bulk.attachSession(id)
}
world.workspaces.push(bulk)
const bulkList = await call(sessionTool, { action: 'list', workspaceId: 'w-bulk' })
check(
  bulkList.data.total === 60 && bulkList.data.sessions.length === 50,
  '不带 limit 的按工作区列表默认截到 50 行',
  `${bulkList.data.sessions.length}/${bulkList.data.total}`,
)
check(bulkList.text.includes('显示前 50 个（用 limit 调大）'), '默认截断时文本说明如何取更多')
world.workspaces.pop()
for (const id of bulkIds) {
  world.headers.delete(id)
  world.titles.delete(id)
}

const untitled = await call(sessionTool, { action: 'list', workspaceId: 'w-bbb' })
check(untitled.text.includes('（无标题）'), '无标题会话显示占位符')

/*
 * 以下三条来自**真实安装后实测到的缺陷**（假 DSH 之前把 title 当字符串，掩盖了它们）：
 * 1. 真服务返回的快照对象被直接当字符串用 → 渲染成 `[object Object]`；
 * 2. `collect()` 把 `createdAt` 存成裸毫秒 → 行里显示 `1791693683532` 而不是时间文本。
 */
const titledRow = inA.data.sessions.find((row) => row.sessionId === 's-a1')
check(titledRow?.title === '写插件骨架', '标题从快照对象里取出文本（不是 [object Object]）', JSON.stringify(titledRow?.title))
check(!inA.text.includes('[object Object]') && !summary.text.includes('[object Object]'), '列表输出里不出现 [object Object]')
check(
  /— \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(inA.text) && !/\b\d{13}\b/.test(inA.text) && !/\b\d{13}\b/.test(summary.text),
  '行里的创建时间是 YYYY-MM-DD HH:mm 文本，不是裸毫秒',
)

/* ---- 补帧的 wire 形状：活会话播报时 values.title 必须是字符串 ---- */
console.log('\n[会话] announce 补帧的 wire 形状')
world.sessions.create('s-announce', { meta: { cwd: '/proj/a' } })
world.titles.set('s-announce', '活会话标题')
world.emitLog.length = 0
await call(sessionTool, { action: 'pin', sessionId: 's-announce' })
const liveFrame = world.emitLog.filter((entry) => entry[0] === 'api-session/added').map((entry) => entry[1]).find((frame) => frame.sessionId === 's-announce')
check(liveFrame !== undefined, '活会话 pin 会补发一行（announce）')
const liveTitle = liveFrame?.projections?.values?.title
check(typeof liveTitle === 'string' && liveTitle === '活会话标题',
  '活会话补帧 values.title 是字符串（客户端只认 string|null）', JSON.stringify(liveTitle))
await call(sessionTool, { action: 'unpin', sessionId: 's-announce' })

/* ---- 会话：get ---- */
console.log('\n[会话] get')
const gotSession = await call(sessionTool, { action: 'get', sessionId: 's-a1' })
check(gotSession.data.session !== undefined, 'get 把会话放在 data.session 下')
check(gotSession.data.session.title === '写插件骨架', 'get 带出标题')
check(gotSession.data.session.workspaceId === 'w-aaa', 'get 带出工作区')
check(gotSession.data.session.cwd === '/proj/a', 'get 带出目录')
check(gotSession.data.session.live === false && gotSession.data.session.persisted === true, 'get 如实反映"未加载 / 已持久化"')
check(gotSession.text.includes('状态：未加载'), 'get 文本写"未加载"而不是"活动中"')
check(gotSession.text.includes('置顶：否；归档：否'), 'get 带出置顶/归档状态')
await checkThrows('get 未知会话报错', '找不到会话', () => call(sessionTool, { action: 'get', sessionId: 's-nope' }))

/* ---- 会话：pin / archive 及其幂等与互斥 ---- */
console.log('\n[会话] pin / archive / 幂等 / 互斥')
// s-a1 刻意不在 liveSessions 里：pin / archive 只走 registry，不要求会话是活的。
// （这条曾经只在描述里写错——"pin and archive need the session to be live"——见文件末尾的描述断言。）
check(world.sessions.get('s-a1') === undefined, '前置：s-a1 不是活会话（覆盖"未加载也能置顶/归档"）')
const pinned = await call(sessionTool, { action: 'pin', sessionId: 's-a1' })
check(world.registry.pinnedSessionIds.join(',') === 's-a1', 'pin 写入置顶集合')
check(pinned.text.includes('已置顶'), 'pin 有文本回报')
const pinnedAgain = await call(sessionTool, { action: 'pin', sessionId: 's-a1' })
check(pinnedAgain.text.includes('已经置顶'), 'pin 幂等')

const archived = await call(sessionTool, { action: 'archive', sessionId: 's-a1' })
check(world.registry.archivedSessionIds.join(',') === 's-a1', 'archive 写入归档集合')
check(world.registry.pinnedSessionIds.length === 0, '归档同时清掉置顶（真实注册表语义）')
const archivedAgain = await call(sessionTool, { action: 'archive', sessionId: 's-a1' })
check(archivedAgain.text.includes('已经归档'), 'archive 幂等')

await checkThrows('置顶已归档会话被拒', '已归档，归档会话不能置顶', () => call(sessionTool, { action: 'pin', sessionId: 's-a1' }))
const restored = await call(sessionTool, { action: 'unarchive', sessionId: 's-a1' })
check(world.registry.archivedSessionIds.length === 0 && restored.text.includes('已从归档恢复'), 'unarchive 生效')
const restoredAgain = await call(sessionTool, { action: 'unarchive', sessionId: 's-a1' })
check(restoredAgain.text.includes('本来就没归档'), 'unarchive 幂等')

// 有运行中工作的会话：真实注册表抛 WorkspaceActiveSessionError。
world.state.activity.set('s-b1', ['turn'])
await checkThrows('archive 遇到运行中工作时报错', 'active', () => call(sessionTool, { action: 'archive', sessionId: 's-b1' }))
check(world.registry.archivedSessionIds.length === 0, '拒绝时归档集合没变')
world.state.activity.delete('s-b1')

/* ---- 会话：rename ---- */
console.log('\n[会话] rename')
world.sessions.create('s-live', { meta: { cwd: '/proj/a' } })
world.titles.set('s-live', '旧标题')
const sessionRenamed = await call(sessionTool, { action: 'rename', sessionId: 's-live', title: '新标题' })
check(sessionRenamed.data.title === '新标题' && world.titles.get('s-live') === '新标题', 'rename 写入标题')
check(sessionRenamed.text.includes('原名：旧标题'), 'rename 回报原名')
await checkThrows('rename 未加载会话时明确报错', '当前没有加载', () => call(sessionTool, { action: 'rename', sessionId: 's-a2', title: 'x' }))
await checkThrows('rename 拒绝空标题', '非空的 title', () => call(sessionTool, { action: 'rename', sessionId: 's-live', title: '' }))

/* ---- 会话：rename + resume（未加载会话：临时加载 → 改名 → 释放） ---- */
console.log('\n[会话] rename + resume: true')
check(world.sessions.get('s-a2') === undefined, '前置：s-a2 未加载')
check(world.titles.get('s-a2') === 'Zeta 排序实验', '前置：s-a2 原有标题')
world.resumeLog.length = 0
world.emitLog.length = 0
const resumed = await call(sessionTool, { action: 'rename', sessionId: 's-a2', title: '按需加载改名', resume: true })
check(resumed.data.resumed === true, 'resume 路径标记 resumed: true')
check(resumed.data.released === true, 'resume 路径标记 released: true')
check(world.titles.get('s-a2') === '按需加载改名', 'resume 路径写入标题')
check(world.sessions.get('s-a2') === undefined, '改名后会话已释放（不会常驻内存）')
check(world.resumeLog.map((entry) => entry[0]).join(',') === 'resume,rename,flush,summary,dispose', '顺序是 resume → rename → flush → summary → dispose（快照必须在改名之后取）')
check(world.resumeLog.find((entry) => entry[0] === 'summary')?.[2] === '按需加载改名', '列表行快照抓到的是**新**标题（否则会把侧边栏按回旧名）')
check(resumed.text.includes('原名：Zeta 排序实验'), 'resume 路径从会话日志读到原名')
check(resumed.text.includes('回到未加载状态'), 'resume 路径在返回文本里说明已释放')
check(resumed.data.rowRestored === true, 'dispose 之后补回了客户端列表行（rowRestored: true）')
check(world.emitLog.map((entry) => entry[0]).join(',') === 'api-session/removed,api-session/added', '事件顺序是 removed → added（否则侧边栏那一行会消失）')
const readded = world.emitLog[1]?.[1]
check(readded?.sessionId === 's-a2' && readded.running === false && readded.agentAvailable === false, '补回的行带着 running / agentAvailable = false')
check(readded?.title === '按需加载改名', '补回的行带的是新标题（这条曾回归成旧标题）')
// 客户端真正消费的是 `projections.values.title`（wire 类型 string | null），不是顶层 title。
const readdedTitle = readded?.projections?.values?.title
check(readdedTitle === undefined || typeof readdedTitle === 'string' || readdedTitle === null,
  '补帧的 projections.values.title 绝不是对象（客户端只认 string|null；曾把快照对象塞进来）', typeof readdedTitle)
check(!resumed.text.includes('刷新页面即可恢复'), '补回成功时不给用户多余的警告')
// 改名失败也必须释放，否则一次报错就留下一个常驻会话。
await checkThrows('改名失败时把错误报出来', 'title rejected', () => call(sessionTool, { action: 'rename', sessionId: 's-u1', title: 'BOOM', resume: true }))
check(world.sessions.get('s-u1') === undefined, '改名失败后仍然释放了会话')
check(world.titles.get('s-u1') === '未分组的一条', '改名失败没有动原标题')
// 释放失败要如实报告，而不是假装成功。
const releaseFailed = await call(sessionTool, { action: 'rename', sessionId: 's-u2', title: '释放失败用例', resume: true })
check(releaseFailed.data.released === false, 'dispose 失败时 released: false')
check(releaseFailed.text.includes('释放失败'), 'dispose 失败在返回文本里如实报告')
check(world.sessions.get('s-u2') !== undefined, 'dispose 失败时会话确实还在（报告与事实一致）')
check(releaseFailed.data.rowRestored === false, 'dispose 失败时不做补发（rowRestored: false）')
// 已加载的会话走直连，不 resume 也不 release。
world.sessions.create('s-live2', { meta: { cwd: '/proj/a' } })
world.titles.set('s-live2', '旧标题2')
const renamedWhileLive = await call(sessionTool, { action: 'rename', sessionId: 's-live2', title: '已活会话再改', resume: true })
check(renamedWhileLive.data.resumed === false && renamedWhileLive.data.released === undefined, '已加载会话走直连路径，不 resume / 不 release')
check(world.sessions.get('s-live2') !== undefined, '直连路径不会释放本来活着的会话')
await checkThrows('resume 未知会话时报 not found', 'not found', () => call(sessionTool, { action: 'rename', sessionId: 's-nope', title: 'x', resume: true }))
// 没有 agents 服务的部署：resume: true 明确报错，默认路径仍然只是拒绝改名。
const bareCtx = makeCtx(world, { sessions: world.sessions, sessionTitle: world.sessionTitle })
await loadPlugin(bareCtx)
const bareSessionTool = bareCtx.__tools.get('dsh_session_manage')
await checkThrows('没有 agents 服务时 resume: true 明确报错', 'resume: true 不可用', () => call(bareSessionTool, { action: 'rename', sessionId: 's-u1', title: 'x', resume: true }))
await checkThrows('没有 agents 服务时默认路径仍然只是拒绝改名', '当前没有加载', () => call(bareSessionTool, { action: 'rename', sessionId: 's-u1', title: 'x' }))
// agents 存在但形状不对（没有 resume）：也要明确报错。
const noResumeCtx = makeCtx(world, { sessions: world.sessions, sessionTitle: world.sessionTitle, agents: {} })
await loadPlugin(noResumeCtx)
const noResumeTool = noResumeCtx.__tools.get('dsh_session_manage')
await checkThrows('agents 缺 resume 方法时明确报错', 'resume: true 不可用', () => call(noResumeTool, { action: 'rename', sessionId: 's-u1', title: 'x', resume: true }))

/* ---- 会话：create ---- */
console.log('\n[会话] create')
const newSession = await call(sessionTool, { action: 'start', workspaceId: 'w-aaa', title: '全新会话', prompt: '测试用第一条指令' })
check(/^session-[0-9a-f-]{36}$/.test(newSession.data.sessionId), 'create 产出标准 session-<uuid> id', newSession.data.sessionId)
check(newSession.data.cwd === '/proj/a', 'create 用工作区目录')
check(newSession.data.workspaceId === 'w-aaa', 'create 回报归属工作区')
check(idsOf('w-aaa')[0] === newSession.data.sessionId, '新会话登记在工作区队首（与真实 attachSession 一致）')
check(world.titles.get(newSession.data.sessionId) === '全新会话', 'create 写入标题')
check(world.sessions.get(newSession.data.sessionId) !== undefined, 'create 建出了活会话')

const byCwd = await call(sessionTool, { action: 'start', cwd: '/loose/dir', prompt: '测试用第一条指令' })
check(byCwd.data.workspaceId === null && byCwd.text.includes('未分组'), 'cwd 建会话归入未分组（该目录未注册为工作区）')

// 回归：cwd 是**已注册**目录时必须反查工作区并 attach（2026-10-11 修的缺陷）。
// 修复前这里只建会话、从不 attach，会话静默落进"未分组"。
// 用一个**独立注册表**断言，避免往共享 world 的 w-aaa 里多塞成员（会破坏后面 reorder/sort 的成员数断言）。
const cwdWorld = makeWorld()
const cwdCtx = makeCtx(cwdWorld, { sessions: cwdWorld.sessions, sessionTitle: cwdWorld.sessionTitle })
await loadPlugin(cwdCtx)
const cwdTool = cwdCtx.__tools.get('dsh_session_manage')
const byRegisteredCwd = await call(cwdTool, { action: 'start', cwd: '/proj/a', title: '按目录归组', prompt: '测试用第一条指令' })
check(byRegisteredCwd.data.workspaceId === 'w-aaa', 'cwd 命中已注册目录时回报归属工作区', String(byRegisteredCwd.data.workspaceId))
check(cwdWorld.registry.get('w-aaa').sessionIds[0] === byRegisteredCwd.data.sessionId, 'cwd 命中已注册目录时登记到工作区队首')
check(!byRegisteredCwd.text.includes('未分组'), 'cwd 命中已注册目录时文本不再说未分组')
check(cwdWorld.titles.get(byRegisteredCwd.data.sessionId) === '按目录归组', 'cwd 反查路径下标题仍正常写入')

// 对照：同一独立世界里给未注册目录建会话，仍应未分组。
const looseCwd = await call(cwdTool, { action: 'start', cwd: '/loose/dir', prompt: '测试用第一条指令' })
check(looseCwd.data.workspaceId === null, '对照：未注册目录的 cwd 仍不归组')

// resolveByPath 抛错（目录不存在等）时不能整体失败，只退回未分组。
// 注意：`makeCtx` 的 workspaceRegistry 是固定字段、`get(name)` 会影子掉它，
// 所以这里用原型继承造一个只替换该字段的上下文。
// **不能污染共享 world**：本用例的 sessions.create 与 attachSession 都改成不落盘，
// 否则会往 w-aaa 里多塞一条会话，破坏后面 reorder/sort 用例的成员数断言。
const flakyCtx = Object.create(ctx)
// 必须用 Object.create 保留原型（`{...world.registry}` 会丢掉类上的方法），只覆盖 resolveByPath。
flakyCtx.workspaceRegistry = Object.create(world.registry)
flakyCtx.workspaceRegistry.resolveByPath = async () => { throw new Error('ENOENT: no such file or directory') }
flakyCtx.get = (name) => (name === 'sessions'
  ? { create: (id, options) => ({ id, header: header(id, { cwd: options?.meta?.cwd }) }) }
  : undefined)
flakyCtx.__tools = new Map()
flakyCtx.tools = { register: (definition) => flakyCtx.__tools.set(definition.name, definition) }
await loadPlugin(flakyCtx)
const flakyCreate = await call(flakyCtx.__tools.get('dsh_session_manage'), { action: 'start', cwd: '/proj/a', prompt: '测试用第一条指令' })
check(flakyCreate.data.workspaceId === null && flakyCreate.text.includes('未分组'), 'resolveByPath 抛错时退回未分组而不是整体失败')

await checkThrows('start 缺少目标时报错', '需要 workspaceId 或 cwd', () => call(sessionTool, { action: 'start' }))
await checkThrows('start 同时给两个目标时报错', '只能给', () => call(sessionTool, { action: 'start', workspaceId: 'w-aaa', cwd: '/x' }))
await checkThrows('start 未知工作区报错', '找不到工作区', () => call(sessionTool, { action: 'start', workspaceId: 'nope' }))
// `create` 一律要求 prompt（用户 2026-10-15 的要求）：不给就直接拒绝，避免"建了却看不见"。
await checkThrows(
  'start 不给 prompt 时报错（这个动作没有空会话这回事）',
  '需要 prompt',
  () => call(sessionTool, { action: 'start', workspaceId: 'w-aaa', title: '想建个空的' }),
)
await checkThrows(
  'start 的 prompt 只有空白字符时也报错',
  '需要 prompt',
  () => call(sessionTool, { action: 'start', workspaceId: 'w-aaa', prompt: '   ' }),
)

/* ---- 会话：create 走**官方** sessionController.create（2026-10-14 修的落盘缺陷） ---- */
console.log('\n[会话] create 走官方路径')
// 为什么单开一个世界：官方路径会连带"假控制器"的行为，不能污染共享 world 的断言。
const apiWorld = makeWorld()
/** 官方 create 收到的请求，用来断言我们把参数交给了它。 */
const apiCalls = []
apiWorld.sessionController.create = async (request) => {
  apiCalls.push(request)
  const workspace = request.workspaceId === undefined ? undefined : apiWorld.registry.get(request.workspaceId)
  const cwd = workspace?.path ?? request.cwd
  apiWorld.sessions.create(request.sessionId, { meta: { cwd } })
  if (workspace !== undefined) await workspace.attachSession(request.sessionId)
  return { sessionId: request.sessionId }
}
const apiCtx = makeCtx(apiWorld, {
  sessions: apiWorld.sessions,
  sessionTitle: apiWorld.sessionTitle,
  sessionController: apiWorld.sessionController,
})
await loadPlugin(apiCtx)
const apiTool = apiCtx.__tools.get('dsh_session_manage')

const viaApi = await call(apiTool, { action: 'start', workspaceId: 'w-aaa', title: '走官方路径', prompt: '测试用第一条指令' })
check(viaApi.data.createdThrough === 'session-controller', '有 sessionController.create 时走官方路径', String(viaApi.data.createdThrough))
check(apiCalls.length === 1 && apiCalls[0].workspaceId === 'w-aaa', '把 workspaceId 原样交给官方 create')
check(apiCalls[0].sessionId === viaApi.data.sessionId, '自己先生成 id 再交给官方 create（便于回报与播报）')
check(apiWorld.sessions.get(viaApi.data.sessionId) !== undefined, '官方路径建出的会话是活的')
check(apiWorld.titles.get(viaApi.data.sessionId) === '走官方路径', '官方路径也把标题写进去了')
check(viaApi.data.accounted === true, '带 workspaceId 时回读成员表核验通过（不假定官方 attach 成功）')
check(apiWorld.registry.get('w-aaa').sessionIds[0] === viaApi.data.sessionId, '官方路径下会话仍登记在队首')
check(viaApi.text.includes('已经落盘'), '返回文本说明这条会话已落盘（不再宣称"重启后消失"）')
check(!viaApi.text.includes('不会落盘'), '返回文本不再声称会话不会落盘')

const viaApiCwd = await call(apiTool, { action: 'start', cwd: '/proj/a', title: '官方路径加目录', prompt: '测试用第一条指令' })
check(apiCalls[1].workspaceId === 'w-aaa' && apiCalls[1].cwd === undefined, '只给 cwd 时先反查成 workspaceId 再交给官方 create（顺手绕开"cwd 不归组"）')
check(viaApiCwd.data.workspaceId === 'w-aaa', '官方路径下 cwd 反查归组仍然生效（§1.3 的修复没退化）')
check(apiWorld.registry.get('w-aaa').sessionIds[0] === viaApiCwd.data.sessionId, 'cwd 路径也登记在队首')

/* ---- create + prompt：建完**当场开工**（用户要的是这个，不是建一块空地） ---- */
console.log('\n[会话] create 带 prompt：建完就开工')
/** 让延后投递的 promise 链跑完。 */
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0))
const promptWorld = makeWorld()
promptWorld.sessionController.create = async (request) => {
  const workspace = request.workspaceId === undefined ? undefined : promptWorld.registry.get(request.workspaceId)
  promptWorld.sessions.create(request.sessionId, { meta: { cwd: workspace?.path ?? request.cwd } })
  if (workspace !== undefined) await workspace.attachSession(request.sessionId)
  return { sessionId: request.sessionId }
}
const promptCtx = makeCtx(promptWorld, {
  sessions: promptWorld.sessions,
  sessionTitle: promptWorld.sessionTitle,
  sessionController: promptWorld.sessionController,
})
await loadPlugin(promptCtx)
const promptTool = promptCtx.__tools.get('dsh_session_manage')
const withPrompt = await call(promptTool, {
  action: 'start', workspaceId: 'w-aaa', title: '带指令', prompt: '帮我把 X 做掉',
})
check(withPrompt.text.includes('已经开始干活'), 'start 带 prompt 时说明会话已经在干活')
// 2026-10-15 定稿：**立刻投递**——早先那版"延后 2.5 秒等界面把行画出来"已被实验证明不需要
// （指令立刻投递后，行被画出来时会话已经在干活，标题投影也在同一帧里）。
check(
  promptCtx.__timers.length === 0,
  '不用 ctx.setTimeout（它会被作用域回收），所以假上下文里没有排下定时器',
  String(promptCtx.__timers.length),
)
check(pendingTimers.length === 0, '不排任何定时器（立刻投递）', String(pendingTimers.length))
await settle()
const sent = promptWorld.sessionController.promptCalls
check(sent.length === 1, '立刻投递了一次 prompt', String(sent.length))
check(
  sent[0].sessionId === withPrompt.data.sessionId && sent[0].mode === 'queue',
  'prompt 的 sessionId / mode 正确',
  JSON.stringify({ same: sent[0].sessionId === withPrompt.data.sessionId, mode: sent[0].mode }),
)
check(
  Array.isArray(sent[0].content) && sent[0].content[0]?.type === 'text' && sent[0].content[0]?.text === '帮我把 X 做掉',
  'prompt 的 content 是官方的 PromptContentPart 形状',
  JSON.stringify(sent[0].content),
)
check(
  typeof sent[0].requestId === 'string' && sent[0].requestId.startsWith('workbench-'),
  'prompt 带一个唯一 requestId',
  String(sent[0].requestId),
)
check(
  !promptWorld.sessionController.resolved.includes(withPrompt.data.sessionId)
    && promptWorld.sessionController.promptCalls.some((call_) => call_.sessionId === withPrompt.data.sessionId),
  '第一条指令直接走官方 prompt（prompt 内部 resolve/resume，不再先调 resolveAgent）',
)
check(withPrompt.text.includes('已经开始干活'), '返回文本告诉调用方"它已经在干活"')

// 再建一条：仍然立刻投递，且不会重复投同一条。
const secondCreate = await call(promptTool, { action: 'start', workspaceId: 'w-aaa', title: '再来一条', prompt: '第二条指令' })
await settle()
check(promptWorld.sessionController.promptCalls.length === 2, '第二次投递也发出了（不重复投同一条）', String(promptWorld.sessionController.promptCalls.length))
check(
  promptWorld.sessionController.promptCalls[0].content[0].text === '帮我把 X 做掉'
    && promptWorld.sessionController.promptCalls[1].content[0].text === '第二条指令',
  '两次投递各自对应自己的指令',
)
check(secondCreate.text.includes('已经开始干活'), '带 prompt 时返回文本说明会话已经在干活')

// 官方 create 失败必须如实抛出，而不是假装建好了。
apiWorld.sessionController.create = async () => {
  throw new Error('persistence refused (test marker)')
}
await checkThrows('官方 create 失败时如实报错', 'persistence refused', () => call(apiTool, { action: 'start', workspaceId: 'w-aaa', prompt: '测试用第一条指令' }))

// 没有 sessionController 时退回 session store，并在文本里标明代价（不静默降级）。
const fallbackWorld = makeWorld()
const fallbackCtx = makeCtx(fallbackWorld, { sessions: fallbackWorld.sessions, sessionTitle: fallbackWorld.sessionTitle })
await loadPlugin(fallbackCtx)
const fallbackTool = fallbackCtx.__tools.get('dsh_session_manage')
const viaStore = await call(fallbackTool, { action: 'start', workspaceId: 'w-aaa', prompt: '测试用第一条指令' })
check(viaStore.data.createdThrough === 'session-store', '没有 sessionController 时退回 session store', String(viaStore.data.createdThrough))
check(viaStore.text.includes('不会落盘') || viaStore.text.includes('未落盘'), '退回路径明确告知会话不会落盘')

/* ---- 会话：attach（补登记） ---- */
console.log('\n[会话] attach')
// 独立世界：attach 会改成员表，不能在共享 world 里做（理由同上面的 create 回归用例）。
const attachWorld = makeWorld()
const attachCtx = makeCtx(attachWorld, { sessions: attachWorld.sessions, sessionTitle: attachWorld.sessionTitle })
await loadPlugin(attachCtx)
const attachTool = attachCtx.__tools.get('dsh_session_manage')
// 一条已持久化、目录属于 w-ccc（'/proj/c'）、当前未归属任何工作区的会话。
attachWorld.headers.set('s-loose', header('s-loose', { createdAt: NOW - 3 * HOUR, cwd: '/proj/c' }))

const attached = await call(attachTool, { action: 'attach', sessionId: 's-loose', workspaceId: 'w-ccc' })
check(attached.data.session.workspaceId === 'w-ccc', 'attach 回报归属工作区', String(attached.data.session.workspaceId))
check(attached.data.session.accounted === true, 'attach 回读成员表确认已登记')
check(attachWorld.registry.get('w-ccc').sessionIds.includes('s-loose'), 'attach 把会话写进工作区 sessionIds')
check(attached.text.includes('成员表核验：已出现'), 'attach 文本给出核验结果')

// 用 cwd 反查目标工作区（等价路径），并确认幂等：已归属的会话再次 attach 报错而不是重复登记。
const beforeCount = attachWorld.registry.get('w-ccc').sessionIds.length
await checkThrows('attach 已归属同一工作区时明确报错（幂等）', '已经登记在工作区', () => call(attachTool, { action: 'attach', sessionId: 's-loose', workspaceId: 'w-ccc' }))
check(attachWorld.registry.get('w-ccc').sessionIds.length === beforeCount, 'attach 幂等失败时成员表未被改动')

// 不许搬家：s-a1 已属于 w-aaa，不能塞进 w-ccc。
await checkThrows('attach 拒绝跨工作区搬家', '本工具不做跨工作区搬家', () => call(attachTool, { action: 'attach', sessionId: 's-a1', workspaceId: 'w-ccc' }))
// 目录不匹配：s-u2 运行在 '/elsewhere'，与 w-ccc 的 '/proj/c' 不符。
await checkThrows('attach 目录不匹配时拒绝', '目录不匹配', () => call(attachTool, { action: 'attach', sessionId: 's-u2', workspaceId: 'w-ccc' }))
// 目标目录未注册为工作区。
await checkThrows('attach 目标目录未注册时报错', '还没有注册为工作区', () => call(attachTool, { action: 'attach', sessionId: 's-u2', cwd: '/nope/dir' }))
// 参数与未知会话。
await checkThrows('attach 缺少目标时报错', '需要 workspaceId 或 cwd 指定目标工作区', () => call(attachTool, { action: 'attach', sessionId: 's-u1' }))
await checkThrows('attach 同时给两个目标时报错', '只能给', () => call(attachTool, { action: 'attach', sessionId: 's-u1', workspaceId: 'w-ccc', cwd: '/proj/c' }))
await checkThrows('attach 未知会话报错', '找不到会话', () => call(attachTool, { action: 'attach', sessionId: 's-nope', workspaceId: 'w-ccc' }))
await checkThrows('attach 缺 sessionId 报错', 'attach 需要 sessionId', () => call(attachTool, { action: 'attach', workspaceId: 'w-ccc' }))

/* ---- 会话：reorder ---- */
console.log('\n[会话] reorder')
const sessionReorder = await call(sessionTool, { action: 'reorder', workspaceId: 'w-aaa', order: [newSession.data.sessionId, 's-a3', 's-a1', 's-a2'] })
check(idsOf('w-aaa').join(',') === `${newSession.data.sessionId},s-a3,s-a1,s-a2`, 'reorder 精确落位', idsOf('w-aaa').join(','))
check(sessionReorder.data.sessionIds.length === 4, 'reorder 回报完整成员列表')
await checkThrows('reorder 缺项被拒', 'order 必须恰好覆盖', () => call(sessionTool, { action: 'reorder', workspaceId: 'w-aaa', order: ['s-a1'] }))
await checkThrows('reorder 拒绝重复项', '重复', () => call(sessionTool, { action: 'reorder', workspaceId: 'w-bbb', order: ['s-b1', 's-b1'] }))

/* ---- 会话：sort ---- */
console.log('\n[会话] sort')
// w-bbb: [s-b1, s-b2]；按标题升序 → s-b1("Cloudflare 权限") 在 s-b2(无标题) 前。
const sortedByTitle = await call(sessionTool, { action: 'sort', workspaceId: 'w-bbb', by: 'title' })
check(idsOf('w-bbb').join(',') === 's-b1,s-b2', 'sort by title 落位正确', idsOf('w-bbb').join(','))
check(sortedByTitle.data.sortedCount === 2, 'sort 回报参与排序的条数')

// 按创建时间升序 → 最早在前
await call(sessionTool, { action: 'sort', workspaceId: 'w-bbb', by: 'created-asc' })
check(idsOf('w-bbb').join(',') === 's-b1,s-b2', 'created-asc 落位正确', idsOf('w-bbb').join(','))
await call(sessionTool, { action: 'sort', workspaceId: 'w-bbb', by: 'created-desc' })
check(idsOf('w-bbb').join(',') === 's-b2,s-b1', 'created-desc 落位正确', idsOf('w-bbb').join(','))

// 范围过滤：只排 from 之后的，没排的保持相对位置
await call(sessionTool, { action: 'sort', workspaceId: 'w-aaa', by: 'created-desc', from: '2026-10-11 00:00' })
check(idsOf('w-aaa').length === 4, 'range sort 不丢会话', idsOf('w-aaa').join(','))
const sortedRange = await call(sessionTool, { action: 'sort', workspaceId: 'w-aaa', by: 'title' })
check(sortedRange.data.sortedCount === 4, '无范围时空 sort 排全部')

/* ---- 参数与错误路径 ---- */
console.log('\n[通用] 错误路径')
await checkThrows('未知 action 报错', '未知 action', () => call(workspaceTool, { action: 'nope' }))
await checkThrows('未知 action 报错（会话）', '未知 action', () => call(sessionTool, { action: 'nope' }))
await checkThrows('空工作区 sort 明确报错而不是假装成功', '没有会话可排序', () => call(sessionTool, { action: 'sort', workspaceId: 'w-ccc', by: 'title' }))
check(idsOf('w-ccc').length === 0, '报错时工作区成员没被改动')
await checkThrows('范围筛掉全部会话时明确报错', '没有会话可排序', () => call(sessionTool, {
  action: 'sort',
  workspaceId: 'w-bbb',
  by: 'title',
  from: '2030-01-01',
}))

/* ---- 播报：唯一的目的是把 values.title 送出去 ---- */
console.log('\n[播报] 把会话的 title 投影送给浏览器')
/** 上次清空以来收到的 `api-session/added` 帧。 */
const addedFrames = () => world.emitLog.filter((entry) => entry[0] === 'api-session/added').map((entry) => entry[1])

world.emitLog.length = 0
const announcedStart = await call(sessionTool, { action: 'start', workspaceId: 'w-bbb', title: '播报用例', prompt: '测试用第一条指令' })
const createFrame = addedFrames().find((frame) => frame.sessionId === announcedStart.data.sessionId)
check(createFrame !== undefined, 'start 之后补发 api-session/added', String(addedFrames().length))
check(
  createFrame?.projections?.values?.title !== undefined,
  '★ 帧里带着 title 投影（这才是它存在的理由：活会话的标题格常常还没物化）',
  JSON.stringify(createFrame?.projections?.values),
)
check(
  createFrame?.projections?.values?.workbench === undefined,
  '帧里不带插件自定义投影（没有消费者）',
  JSON.stringify(Object.keys(createFrame?.projections?.values ?? {})),
)
check(createFrame?.projections?.kind === 'sequenced' && typeof createFrame?.projections?.asOfSeq === 'number', 'projections 块形状合法（客户端按 kind 分支 applyListBlock）')
// running / agentAvailable 必须**原样沿用**控制器给的 summary：这两个字段会被客户端
// 直接写进列表行，自己编一个就等于谎报会话状态。
const controllerSummary = world.sessionController.listState.summaryFor(world.sessions.get(announcedStart.data.sessionId))
check(
  createFrame?.running === controllerSummary.running && createFrame?.agentAvailable === controllerSummary.agentAvailable,
  '帧沿用控制器的 running / agentAvailable（不自己编）',
  `${String(createFrame?.running)}/${String(createFrame?.agentAvailable)}`,
)

// 冷会话（未加载但已持久化）是 pin / archive 的常态：必须也能播报。
world.emitLog.length = 0
await call(sessionTool, { action: 'unarchive', sessionId: 's-b2' })
await call(sessionTool, { action: 'archive', sessionId: 's-b2' })
const coldFrame = addedFrames().find((frame) => frame.sessionId === 's-b2')
check(coldFrame !== undefined, '冷会话（未加载）也能补发帧——走官方 summarizeCold 那条路')
check(coldFrame?.running === false && coldFrame?.agentAvailable === false, '冷会话帧如实报告未运行')

// 幂等动作不播报：第二次 pin 什么都没改。
world.emitLog.length = 0
await call(sessionTool, { action: 'pin', sessionId: 's-b1' })
check(addedFrames().some((frame) => frame.sessionId === 's-b1'), 'pin 会播报')
world.emitLog.length = 0
const pinAgain = await call(sessionTool, { action: 'pin', sessionId: 's-b1' })
check(pinAgain.text.includes('已经置顶'), '前置：第二次 pin 是 no-op')
check(addedFrames().length === 0, 'no-op 不播报（不制造幽灵变更）')

// 工作区改动不补会话帧：它走官方 `remote.workspace.follow` 推送流。
world.emitLog.length = 0
await call(workspaceTool, { action: 'rename', workspaceId: 'w-bbb', title: '工作区改名用例' })
check(addedFrames().length === 0, '工作区改动不补会话帧（官方 follow 流已经推了）')

// 没碰到任何会话的失败也不播报。
world.emitLog.length = 0
await checkThrows('未加载会话 rename 被拒（这是一次失败的操作）', '当前没有加载', () => call(sessionTool, { action: 'rename', sessionId: 's-b2', title: 'x' }))
check(addedFrames().length === 0, '失败且没碰到会话时不播报')

// 失败但**碰到了会话**：仍然要播报。场景：`resume: true` 的改名先把会话加载起来、
// 失败后又被 dispose——客户端那一行会被 `api-session/removed` 删掉，必须把它补回来，
// 否则"一次失败的改名"会顺手抹掉界面上的一行。
world.emitLog.length = 0
await checkThrows('resume 改名失败（失败路径也要播报）', 'title rejected', () => call(sessionTool, { action: 'rename', sessionId: 's-u1', title: 'BOOM', resume: true }))
const failedFrame = addedFrames().find((frame) => frame.sessionId === 's-u1')
check(failedFrame !== undefined, '改名失败后把被 dispose 删掉的行补回来（走冷会话 summarizeCold）')
check(failedFrame?.running === false, '补回来的帧如实报告该会话当前未运行')

/* ---- 新动作：send / cancel / search / read / fork / openPath / model ---- */
console.log('\n[会话] send：把指令投进**已有**会话')
world.sessionController.promptCalls.length = 0
const resolvedBeforeSend = world.sessionController.resolved.length
const sentCall = await call(sessionTool, { action: 'send', sessionId: 's-b1', prompt: '继续把 Y 做掉' })
check(
  world.sessionController.promptCalls.some((call_) => call_.sessionId === 's-b1'
    && call_.mode === 'queue' && call_.content?.[0]?.text === '继续把 Y 做掉'),
  'send 用官方 prompt 投递（mode: queue，不打断正在跑的 turn）',
  JSON.stringify(world.sessionController.promptCalls.slice(-1)),
)
check(world.sessionController.resolved.length === resolvedBeforeSend,
  'send 直接走官方 prompt（prompt 内部 resolve/resume，不再先调 resolveAgent）')
check(sentCall.text.includes('已把指令投进会话'), 'send 返回文本说明已投递')
await checkThrows('send 缺 prompt 时报错', '需要 prompt', () => call(sessionTool, { action: 'send', sessionId: 's-b1' }))
await checkThrows('send 未知会话时报错', '找不到会话', () => call(sessionTool, { action: 'send', sessionId: 's-nope', prompt: 'x' }))

/* ---- send / steer：交付前先读运行状态，并按真实语义回报（2026-11-02 修复） ---- */
console.log('\n[会话] send / steer：交付前读运行状态、如实回报实际语义')
await world.agents.resume({ resumeSessionId: 's-b1' })
const liveB1 = world.sessions.get('s-b1')
check(liveB1 !== undefined, '前置：s-b1 已加载（否则测不到运行状态分支）')

// 空闲 + send：必须说明"会立刻开始新一轮"，不能误导成"排在当前 turn 之后"。
world.sessionController.promptCalls.length = 0
const sendIdle = await call(sessionTool, { action: 'send', sessionId: 's-b1', prompt: '把状态补一句' })
check(sendIdle.data.runningBefore === false, 'send 回报投递前运行状态（空闲 = false）', JSON.stringify(sendIdle.data))
check(sendIdle.text.includes('没有在跑 turn') && sendIdle.text.includes('立刻开始新一轮'),
  'send 到空闲会话时说明会立刻开工')
check(world.sessionController.promptCalls.at(-1)?.mode === 'queue', 'send 到空闲会话仍走官方 queue 模式')

// 运行中 + send：如实说明"排在当前 turn 之后、不打断"，并给出**不重发**的补救路径（queueAction: steer）。
liveB1.status = 'running'
const sendRunning = await call(sessionTool, { action: 'send', sessionId: 's-b1', prompt: '顺便把 B 也做了' })
check(sendRunning.data.runningBefore === true, 'send 回报投递前正在跑（true）', JSON.stringify(sendRunning.data))
check(sendRunning.text.includes('正在跑一个 turn') && sendRunning.text.includes('queueAction: steer'),
  'send 到运行中会话时说明"排到下一轮"并指出可把这条队列项提升为 steer')
check(sendRunning.text.includes('不要重发'), 'send 到运行中会话时明确警告"不要重发"（避免重复投递）')
check(world.sessionController.promptCalls.at(-1)?.mode === 'queue', 'send 到运行中会话仍用 queue（不打断）')

// 运行中 + steer：走官方 steer 模式，说明"下一步被采纳、当前 turn 不中断"。
const steerRunning = await call(sessionTool, { action: 'steer', sessionId: 's-b1', prompt: '别做 C，改成 D' })
check(steerRunning.data.mode === 'steer' && steerRunning.data.runningBefore === true,
  'steer 走官方 steer 模式并回报 runningBefore', JSON.stringify(steerRunning.data))
check(steerRunning.text.includes('插话') && steerRunning.text.includes('不中断'),
  'steer 文本说明插话且不中断当前 turn')

// 空闲 + steer：官方 prompt 其实也接受 steer（会记入 nextStep 并立刻开一轮），但官方客户端规则是
// `!running → queue`；工具照抄该规则：**不尝试 steer**，直接 queue 并说明，不编造"正在跑的 turn"。
liveB1.status = 'idle'
world.sessionController.promptCalls.length = 0
const steerIdle = await call(sessionTool, { action: 'steer', sessionId: 's-b1', prompt: '顺带看一下 E' })
check(steerIdle.data.mode === 'queue' && steerIdle.data.runningBefore === false,
  'steer 到空闲会话时按官方客户端规则解析为 queue', JSON.stringify(steerIdle.data))
check(steerIdle.text.includes('steer 没有使用') && steerIdle.text.includes('没有在跑'),
  'steer 到空闲会话时说明"没有可插话的 turn"')
check(world.sessionController.promptCalls.length === 1 && world.sessionController.promptCalls[0].mode === 'queue',
  '空闲 steer 不会调用 steer 模式（避免产生一个假的"插话"）',
  JSON.stringify(world.sessionController.promptCalls.map((call_) => call_.mode)))
check(steerIdle.text.includes('不需要重发'), '空闲 steer 说明这条已投递、不需要重发')

// 运行中 + steer 的竞态：读时在跑、投递时 turn 结束 → 回退 queue，并带真实原因（不重发）。
liveB1.status = 'running'
const realPrompt = world.sessionController.prompt
world.sessionController.prompt = async (request) => {
  if (request.mode === 'steer') {
    world.sessionController.promptCalls.push(request)
    const error = new Error('session disposed during admission')
    error.code = 'session/not-found'
    throw error
  }
  return realPrompt(request)
}
try {
  world.sessionController.promptCalls.length = 0
  const steerRace = await call(sessionTool, { action: 'steer', sessionId: 's-b1', prompt: '改成 F' })
  check(steerRace.data.mode === 'queue' && steerRace.data.runningBefore === true,
    'steer 竞态失败后回退 queue 并如实回报 runningBefore=true', JSON.stringify(steerRace.data))
  check(steerRace.text.includes('steer 没有生效') && steerRace.text.includes('session/not-found'),
    'steer 回退文本带真实原因（官方错误码）')
  check(steerRace.text.includes('不需要重发'), 'steer 竞态回退说明这条已投递、不需要重发')
  check(world.sessionController.promptCalls.at(-1)?.mode === 'queue',
    'steer 竞态回退确实用 queue 投递（消息不丢）')
} finally {
  world.sessionController.prompt = realPrompt
  delete liveB1.status
}

// 运行状态进入 list / get：模型不用猜、也不用额外调一次工具就能判断。
liveB1.status = 'running'
const listRunning = await call(sessionTool, { action: 'list', workspaceId: 'w-bbb' })
const rowB1 = listRunning.data.sessions.find((row) => row.sessionId === 's-b1')
check(rowB1?.running === true, 'list 行带 running=true', JSON.stringify(rowB1))
check(listRunning.text.includes('[运行中'), 'list 文本渲染 [运行中] 标记')
const getRunning = await call(sessionTool, { action: 'get', sessionId: 's-b1' })
check(getRunning.data.session.running === true && getRunning.text.includes('运行：正在跑一个 turn'),
  'get 带出运行状态（文本 + data.session.running）')
liveB1.inbox = { nextTurn: [{ id: 'q-b1', content: [{ type: 'text', text: '后做的 A' }] }], nextStep: [] }
const getQueued = await call(sessionTool, { action: 'get', sessionId: 's-b1' })
check(getQueued.data.session.nextTurn === 1 && getQueued.text.includes('待处理队列：下一轮 1 条'),
  'get 带出待处理队列条数')
delete liveB1.status

/* ---- queue 动作：只管理已经在队列里的消息（不新增），edit/remove/steer 走官方 updateQueue ---- */
console.log('\n[会话] queue：管理已排队消息（不是发送入口）')
// 真实 wire 形状（kebab-case）：这是 0.2.1-rc.5 `values.inbox` 的实际键名。
world.sessionController.inboxProjection = {
  'next-turn': [{ id: 'q-b1', content: [{ type: 'text', text: '后做的 A' }] }],
  'next-step': [],
}
const queueList = await call(sessionTool, { action: 'queue', sessionId: 's-b1' })
check(queueList.data.nextTurn?.[0]?.itemId === 'q-b1' && queueList.text.includes('后做的 A'),
  'queue list 读出真实 wire 形状（next-turn/next-step）的 inbox 投影')
// camelCase 兼容：个别旧实现/假服务给 camelCase，不应因此读成空。
world.sessionController.inboxProjection = {
  nextTurn: [{ id: 'q-legacy', content: [{ type: 'text', text: '旧形状的消息' }] }],
  nextStep: [],
}
const queueListCamel = await call(sessionTool, { action: 'queue', sessionId: 's-b1' })
check(queueListCamel.data.nextTurn?.[0]?.itemId === 'q-legacy', 'queue list 兼容 camelCase 的 inbox 投影形状')
// 投影对象在、但两个键都缺失：不能当"空"（会假报空），应回退到 live agent 的 inbox。
world.sessionController.inboxProjection = {}
liveB1.inbox = { nextTurn: [{ id: 'q-live', content: [{ type: 'text', text: 'live inbox 的消息' }] }], nextStep: [] }
const queueListFallback = await call(sessionTool, { action: 'queue', sessionId: 's-b1' })
check(queueListFallback.data.nextTurn?.[0]?.itemId === 'q-live',
  '投影形状不合预期时回退 live agent inbox（不把"读不到"当"空"）')
world.sessionController.inboxProjection = {
  'next-turn': [{ id: 'q-b1', content: [{ type: 'text', text: '后做的 A' }] }],
  'next-step': [],
}
delete liveB1.inbox
await checkThrows('queue 不接受 prompt（它不是发送入口）', '只管理**已排队**的消息',
  () => call(sessionTool, { action: 'queue', sessionId: 's-b1', prompt: '顺便发一条' }))
// list 走 projections，不 resolveAgent、不加载会话。
const resolvedBeforeQueue = world.sessionController.resolved.length
await call(sessionTool, { action: 'queue', sessionId: 's-u1' })
check(world.sessionController.resolved.length === resolvedBeforeQueue,
  'queue list 不加载会话（走官方 projections 投影，而不是 resolveAgent）')
// 没有 projections 的老部署：冷会话如实说明"未加载、不会为了看一眼加载会话"。
const projectionsImpl = world.sessionController.projections
delete world.sessionController.projections
try {
  const coldNoProjection = await call(sessionTool, { action: 'queue', sessionId: 's-u1' })
  check(coldNoProjection.data.loaded === false && coldNoProjection.text.includes('当前未加载'),
    '没有 projections 的部署：冷会话 queue list 如实说明"未加载、不加载会话"')
} finally {
  world.sessionController.projections = projectionsImpl
}
// queue steer 需要目标正在跑（官方 updateQueue 限制）：先给可行动的拒绝，再成功路径。
await checkThrows('空闲时 queue steer 给出可行动错误', '需要目标**正在跑 turn**',
  () => call(sessionTool, { action: 'queue', sessionId: 's-b1', queueAction: 'steer', itemId: 'q-b1' }))
liveB1.status = 'running'
const queueSteer = await call(sessionTool, { action: 'queue', sessionId: 's-b1', queueAction: 'steer', itemId: 'q-b1' })
check(world.sessionController.queueUpdates.at(-1)?.action?.kind === 'steer',
  'queue steer 调官方 updateQueue（kind=steer）')
check(queueSteer.text.includes('下一步'), 'queue steer 文本说明会进入当前 turn 的下一步')
delete liveB1.status
await call(sessionTool, { action: 'queue', sessionId: 's-b1', queueAction: 'edit', itemId: 'q-b1', content: '改成 B' })
check(JSON.stringify(world.sessionController.queueUpdates.at(-1)?.action?.content)
  === JSON.stringify([{ type: 'text', text: '改成 B' }]), 'queue edit 把替换文本交给官方 updateQueue')
await call(sessionTool, { action: 'queue', sessionId: 's-b1', queueAction: 'remove', itemId: 'q-b1' })
check(world.sessionController.queueUpdates.at(-1)?.action?.kind === 'remove',
  'queue remove 调官方 updateQueue（kind=remove）')
await checkThrows('queue 缺 itemId 时报错', 'itemId',
  () => call(sessionTool, { action: 'queue', sessionId: 's-b1', queueAction: 'remove' }))
world.sessionController.inboxProjection = { 'next-turn': [], 'next-step': [] }

/* ---- 运行状态读不到时（没有 agents 服务）：必须如实说"未知"并按最安全规则解析 ---- */
console.log('\n[会话] 运行状态未知时的安全解析')
const noAgentsCtx = makeCtx(world, {
  sessions: world.sessions,
  sessionTitle: world.sessionTitle,
  sessionController: world.sessionController,
})
await loadPlugin(noAgentsCtx)
const noAgentsTool = noAgentsCtx.__tools.get('dsh_session_manage')
const unknownSend = await call(noAgentsTool, { action: 'send', sessionId: 's-a2', prompt: '状态未知时发送' })
check(unknownSend.data.runningBefore === null && unknownSend.text.includes('读不到目标的运行状态'),
  '读不到 agents 服务时 send 如实回报 runningBefore=null', JSON.stringify(unknownSend.data))
world.sessionController.promptCalls.length = 0
const unknownSteer = await call(noAgentsTool, { action: 'steer', sessionId: 's-a2', prompt: '状态未知时插话' })
check(unknownSteer.data.mode === 'queue' && unknownSteer.data.runningBefore === null
  && unknownSteer.text.includes('运行状态读不到'),
  '读不到运行状态时 steer 按最安全规则解析为 queue（不盲发 steer）', JSON.stringify(unknownSteer.data))
check(world.sessionController.promptCalls.at(-1)?.mode === 'queue', '未知状态 steer 不调用 steer 模式')

/* ---- wait / notify：等待与提醒的分工（不轮询、不白占 turn） ---- */
console.log('\n[会话] wait / notify：等待与提醒的分工')
// 不带 after 的 wait 以"现在"为基线：历史事件不算新内容。
world.sessionController.eventRecords = [
  { type: 'assistant/message', seq: 900, time: Date.now() - 60000, data: { message: { content: [{ type: 'text', text: '很久以前的回复' }] } } },
]
const waitedIdle = await call(sessionTool, { action: 'wait', sessionId: 's-b1' })
check(waitedIdle.data.state === 'idle' && waitedIdle.text.includes('无需等待'),
  'wait 到空闲会话时立即返回"无需等待"')
check(waitedIdle.data.newEvents === 0 && !waitedIdle.text.includes('很久以前的回复'),
  '不带 after 的 wait 不把历史事件当新内容（基线=现在）', JSON.stringify(waitedIdle.data))
await checkThrows('notify 只能在 turn 内登记', 'turn 内调用',
  () => call(sessionTool, { action: 'notify', sessionId: 's-b1' }, { signal: undefined }))
const notifyIdle = await sessionTool.execute(
  { action: 'notify', sessionId: 's-b1' },
  { signal: undefined, agent: { session: { id: 'caller-session' } } },
)
check(JSON.parse(notifyIdle.data).state === 'idle', 'notify 到空闲会话时说明"无需登记"', notifyIdle.message)

/* ---- 新原语：cursor / after / until（跨会话收发的可靠契约） ---- */
console.log('\n[会话] cursor / after / until：跨会话读写的新原语')
// send 返回 cursor 锚点
world.sessionController.eventRecords = [
  { type: 'assistant/message', seq: 40, time: Date.now() - 1000, data: { message: { content: [{ type: 'text', text: '之前的回复' }] } } },
]
const sendWithCursor = await call(sessionTool, { action: 'send', sessionId: 's-a2', prompt: '继续' })
check(typeof sendWithCursor.data.cursor === 'number', 'send 返回 cursor 锚点（投递前的日志末尾 seq）', JSON.stringify(sendWithCursor.data))
check(sendWithCursor.text.includes('after:'), 'send 文本提示如何用 after 读回之后的回复')
// read(after)：只读 cursor 之后
world.sessionController.eventRecords = [
  { type: 'user/message', seq: 1, time: Date.now() - 3000, data: { content: [{ type: 'text', text: '很早的旧消息' }] } },
  { type: 'assistant/message', seq: 2, time: Date.now() - 2000, data: { message: { content: [{ type: 'text', text: '之后的新回复' }] } } },
]
const incRead = await call(sessionTool, { action: 'read', sessionId: 's-a2', after: 1 })
check(incRead.text.includes('之后的新回复') && !incRead.text.includes('很早的旧消息'),
  'read(after=cursor) 只返回 cursor 之后的事件', incRead.text.slice(0, 120))
check(incRead.data.cursor === 2, 'read(after) 返回新 cursor', JSON.stringify(incRead.data))
// wait(until=reply)：收到新完整回复就返回
liveB1.status = 'running'
world.sessionController.eventRecords = []
const replyPromise = sessionTool.execute(
  { action: 'wait', sessionId: 's-b1', after: 0, until: 'reply', timeoutMs: 60000 },
  { signal: undefined },
)
// 等 wait 先完成 catch-up 并订阅（否则事件在订阅前触发会丢，测试会挂到超时）。
await new Promise((resolve) => realSetTimeout(resolve, 30))
ctx.__fire('session/event', { id: 's-b1' }, { type: 'tool/result', seq: 5, time: Date.now(), data: { message: {} } })
ctx.__fire('session/event', { id: 's-b1' }, {
  type: 'assistant/message', seq: 6, time: Date.now(),
  data: { message: { content: [{ type: 'text', text: '新的完整回复' }] } },
})
const waitedReply = await replyPromise
check(JSON.parse(waitedReply.data).state === 'reply' && waitedReply.message.includes('新的完整回复'),
  'wait(until=reply) 收到新回复即返回（不等整轮）', waitedReply.message.slice(0, 120))
// wait(until=step)：工具结果就算一步
world.sessionController.eventRecords = []
const stepPromise = sessionTool.execute(
  { action: 'wait', sessionId: 's-b1', after: 6, until: 'step', timeoutMs: 60000 },
  { signal: undefined },
)
await new Promise((resolve) => realSetTimeout(resolve, 30))
ctx.__fire('session/event', { id: 's-b1' }, { type: 'tool/result', seq: 7, time: Date.now(), data: { message: {} } })
const waitedStep = await stepPromise
check(JSON.parse(waitedStep.data).state === 'step', 'wait(until=step) 完成一步即返回', waitedStep.message.slice(0, 120))
// wait 超时：返回已收到内容 + idleForMs，不抛错
world.sessionController.eventRecords = []
const timeoutPromise = sessionTool.execute(
  { action: 'wait', sessionId: 's-b1', after: 0, until: 'reply', timeoutMs: 5000 },
  { signal: undefined },
)
await new Promise((resolve) => realSetTimeout(resolve, 30))
await flushTimers()
const waitedTimeout = await timeoutPromise
const timeoutData = JSON.parse(waitedTimeout.data)
check(timeoutData.state === 'timeout' && waitedTimeout.message.includes('已收到'),
  'wait 超时返回状态与已收到内容（不抛错）', waitedTimeout.message.slice(0, 120))
check(typeof timeoutData.idleForMs === 'number', 'wait 超时回报 idleForMs（多久没动静）')
delete liveB1.status
world.sessionController.eventRecords = []

console.log('\n[会话] cancel：停掉正在跑的 turn')
liveB1.status = 'running'
const cancelled = await call(sessionTool, { action: 'cancel', sessionId: 's-b1' })
check(world.sessionController.cancelCalls.includes('s-b1'), 'cancel 调到官方 sessionController.cancel')
check(cancelled.text.includes('已请求取消') && cancelled.text.includes('队列'), 'cancel 文本说明"已请求取消且不动队列"')
check(cancelled.data.runningBefore === true, 'cancel 回报投递前运行状态（true）')
delete liveB1.status
const cancelledIdle = await call(sessionTool, { action: 'cancel', sessionId: 's-b1' })
check(cancelledIdle.text.includes('没有在跑的 turn') && cancelledIdle.data.runningBefore === false,
  'cancel 到空闲会话时如实说明"无改动"（不假装停了什么）')
await checkThrows('cancel 未知会话时报错', '找不到会话', () => call(sessionTool, { action: 'cancel', sessionId: 's-nope' }))

console.log('\n[会话] archive / send：运行中与已归档的守卫')
liveB1.status = 'running'
await checkThrows('archive 正在跑 turn 的会话时给出可行动错误', '正在跑 turn',
  () => call(sessionTool, { action: 'archive', sessionId: 's-b1' }))
delete liveB1.status
world.state.archivedIds.add('s-b1')
try {
  await checkThrows('send 到已归档会话时拒绝（官方会接受 prompt 但丢弃工作）', '已归档',
    () => call(sessionTool, { action: 'send', sessionId: 's-b1', prompt: 'x' }))
  await checkThrows('steer 到已归档会话时拒绝', '已归档',
    () => call(sessionTool, { action: 'steer', sessionId: 's-b1', prompt: 'x' }))
} finally {
  world.state.archivedIds.delete('s-b1')
}

// 子会话栅栏：官方 prompt 对 origin:subagent 的子会话抛 session/agent-busy（要求走 subagents 域），
// 工具要把它翻译成模型能行动的错误，而不是让模型反复重试。（s-b2 在上面的归档用例里被归档了，先临时恢复。）
world.state.archivedIds.delete('s-b2')
const promptBeforeFence = world.sessionController.prompt
world.sessionController.prompt = async () => {
  const error = new Error('use subagent delivery for this child session')
  error.code = 'session/agent-busy'
  throw error
}
try {
  await checkThrows('投递到子会话时翻译 session/agent-busy 并指路 subagents 域', 'subagents 域',
    () => call(sessionTool, { action: 'send', sessionId: 's-b2', prompt: 'x' }))
} finally {
  world.sessionController.prompt = promptBeforeFence
  world.state.archivedIds.add('s-b2')
}

console.log('\n[会话] search：按内容找会话')
world.sessionController.searchResult = { items: [{ sessionId: 's-b1', snippet: '这里讨论过 X 的做法' }], hasMore: false }
const found = await call(sessionTool, { action: 'search', query: 'X' })
check(world.sessionController.lastSearchRequest?.query === 'X', 'search 把关键词原样交给官方 search')
check(found.data.items?.[0] === 's-b1', 'search 返回命中的会话 id 列表')
check(found.text.includes('这里讨论过 X'), 'search 文本里带 snippet')
await checkThrows('search 缺 query 时报错', '需要 query', () => call(sessionTool, { action: 'search' }))
world.sessionController.searchResult = { items: [], hasMore: false }
const noneFound = await call(sessionTool, { action: 'search', query: '不存在的词' })
check(noneFound.text.includes('没有会话内容匹配'), 'search 无命中时明确说"没有"')
// 官方 search **不能限条数**（`SessionSearchRequest` 只有 query），所以限显示条数是我们的事：
// 不限制会把十几条命中连大段 snippet 全倒进上下文（实测踩到）。
world.sessionController.searchResult = {
  items: Array.from({ length: 12 }, (unused, index) => ({ sessionId: `s-hit-${index}`, snippet: `命中 ${index} ${'长'.repeat(300)}` })),
  hasMore: true,
}
const manyHits = await call(sessionTool, { action: 'search', query: '多', limit: 3 })
check(manyHits.data.items.length === 3, 'search 按 limit 限制返回的 id 数（默认 8）', String(manyHits.data.items.length))
check(
  manyHits.text.includes('本次返回 12 条') && manyHits.text.includes('显示前 3 条'),
  'search 文本里如实说明"返回多少 / 显示多少"',
  manyHits.text.split('\n')[0],
)
check(!manyHits.text.includes('s-hit-5'), 'search 不把被截掉的命中写进文本')
check(manyHits.text.length < 1200, 'search 输出不会撑爆上下文（snippet 截断 + 条数受限）', String(manyHits.text.length))

console.log('\n[会话] read：读回最近的消息（官方 events API）')
world.sessionController.eventRecords = [
  { type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: '帮我把 X 做掉' }] } },
  { type: 'assistant/message', seq: 2, time: 0, data: { message: { content: [{ type: 'text', text: '好的，已完成' }] } } },
  { type: 'tool/call', seq: 3, time: 0, data: { name: 'dsh_session_manage' } },
  { type: 'tool/result', seq: 4, time: 0, data: { message: {}, turn: 1, step: 1 } },
]
world.sessionController.hasMoreEvents = false
const readBack = await call(sessionTool, { action: 'read', sessionId: 's-b1', limit: 5 })
check(
  world.sessionController.lastEventsRequest?.address?.kind === 'session'
    && world.sessionController.lastEventsRequest?.address?.sessionId === 's-b1',
  'read 用官方 events 的 address 形状',
  JSON.stringify(world.sessionController.lastEventsRequest),
)
check(world.sessionController.lastEventsRequest?.maxMessages === 5, 'read 把 limit 传给官方 events.maxMessages')
check(world.sessionController.lastEventsRequest?.throughSeq === undefined, 'read 省略 throughSeq（取日志末尾，即最近 N 条）')
check(
  readBack.text.includes('帮我把 X 做掉') && readBack.text.includes('好的，已完成')
    && readBack.text.includes('工具调用') && readBack.text.includes('工具结果：ok'),
  'read 把 user / assistant / tool-call / tool-result 都渲染出来',
  readBack.text.slice(0, 140),
)
const beforeSeqRead = await call(sessionTool, { action: 'read', sessionId: 's-b1', beforeSeq: 3 })
check(world.sessionController.lastEventsRequest?.beforeSeq === 3, 'read 透传 beforeSeq 用于往前翻页')
world.sessionController.eventRecords = []
const emptyRead = await call(sessionTool, { action: 'read', sessionId: 's-b1' })
check(emptyRead.text.includes('没有可读的消息'), 'read 空会话时给出可行动说明而不是抛错', emptyRead.text.slice(0, 80))
world.sessionController.eventRecords = [{ type: 'user/message', seq: 42, time: 0, data: {} }]

console.log('\n[会话] fork / openPath / model')
const forked = await call(sessionTool, { action: 'fork', sessionId: announcedStart.data.sessionId })
check(forked.data.sessionId === 'session-forked', 'fork 返回新会话 id')
check(
  world.registry.get('w-bbb')?.sessionIds.includes('session-forked') === true,
  'fork 之后把新会话登记进源会话所在的工作区（官方 fork 不做归组）',
)
check(forked.text.includes('冷') && forked.text.includes('send'), 'fork 文本提醒"新会话是冷的，要它干活请 send"', forked.text.slice(0, 80))
const openedPath = await call(sessionTool, { action: 'openPath', workspaceId: 'w-aaa' })
check(world.sessionController.openPathCalls[0]?.path === world.registry.get('w-aaa').path, 'openPath 用工作区路径调官方 openWorkspacePath')
check(openedPath.text.includes('已'), 'openPath 返回文本')
await checkThrows('openPath 既没 path 也没 workspaceId 时报错', '需要 path', () => call(sessionTool, { action: 'openPath' }))
await call(sessionTool, { action: 'model', sessionId: 's-b1', provider: 'deepseek-account', model: 'deepseek-reasoner' })
check(
  world.sessionController.selectModelCalls[0]?.provider === 'deepseek-account'
    && world.sessionController.selectModelCalls[0]?.model === 'deepseek-reasoner',
  'model 把 provider / model 交给官方 selectModel',
)
await checkThrows('model 缺 provider/model 时报错', '需要 provider 与 model', () => call(sessionTool, { action: 'model', sessionId: 's-b1' }))

console.log('\n[会话] start 支持 agentPreset')
world.sessionController.create = async (request) => {
  world.sessionController.lastCreateRequest = request
  world.sessions.create(request.sessionId, { meta: { cwd: request.cwd } })
  return { sessionId: request.sessionId }
}
await call(sessionTool, { action: 'start', workspaceId: 'w-aaa', title: '带预设', prompt: '干活', agentPreset: 'coding' })
check(world.sessionController.lastCreateRequest?.agentPreset === 'coding', 'start 把 agentPreset 交给官方 create')
await call(sessionTool, { action: 'start', workspaceId: 'w-aaa', title: '不带预设', prompt: '干活' })
check(world.sessionController.lastCreateRequest?.agentPreset === undefined, '不给 agentPreset 时不塞这个字段')


/* ---- 配置工具：读 / 预览 / 写入 / 复位 ---- */
console.log('\n[配置] list / get：先看清再改')
const configTool = ctx.__tools.get('dsh_config_manage')
const configEditorFake = ctx.get('configEditor')
check(configTool !== undefined, '注册了配置工具 dsh_config_manage')
const cfgListed = await call(configTool, { action: 'list' })
check(cfgListed.text.includes('fake-row') && cfgListed.text.includes('plain-row'), 'list 同时列出有覆盖与无覆盖的行', cfgListed.text.split('\n').slice(0, 3).join(' | '))
check(cfgListed.text.includes('共 3 行') && cfgListed.text.includes('2 行已有覆盖值'), 'list 报出总行数与覆盖行数')
check(cfgListed.text.includes('覆盖字段') && cfgListed.text.includes('alpha'), 'list 标出哪些行已有覆盖值')
const cfgGot = await call(configTool, { action: 'get', entry: 'plain-row' })
check(cfgGot.text.includes('继承值') && cfgGot.text.includes('gamma'), 'get 同时给出继承值 / 覆盖值 / 生效值')
await checkThrows('get 未知行时报错', '找不到可编辑的行', () => call(configTool, { action: 'get', entry: 'nope' }))

console.log('\n[配置] 预览：必须不写入')
configEditorFake.edits.length = 0
const cfgPreview = await call(configTool, { action: 'set', entry: 'fake-row', values: { alpha: 9 } })
check(configEditorFake.edits.length === 0, '不带 apply 的 set 绝不调用官方 edit（只预览）', String(configEditorFake.edits.length))
// 覆盖里已经含全部继承字段 → 这次改动不会额外"钉住"任何字段：必须明说"检查过了"，而不是静默省略。
const cfgPinnedPreview = await call(configTool, { action: 'set', entry: 'pinned-row', values: { beta: 3 } })

// 非 volatile 字段的用例（用于"会重建 / 可能打断"这条路径）
const cfgRebuildPreview = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false } })
check(cfgPreview.text.includes('【预览·未写入】'), '预览明确标注"未写入"')
check(cfgPreview.text.includes('alpha: 2 → 9'), '预览给出 before → after')
check(typeof cfgPreview.data.previewToken === 'string' && cfgPreview.data.previewToken.length >= 8,
  '预览返回 previewToken（写入凭证）', JSON.stringify(cfgPreview.data.previewToken))

/* 结构：先"给用户看"（短、通俗、按优先级），再"技术依据"（Agent 自己看）。 */
const userSection = (text) => {
  const body = text.split('———— 给用户看')[1]?.split('———— 技术依据')[0] ?? ''
  return body.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.includes('————'))
}
const techSection = (text) => (text.split('———— 技术依据')[1] ?? '')
for (const [name, text] of [['预览', cfgPreview.text], ['无变化行预览', cfgRebuildPreview.text]]) {
  const user = userSection(text)
  check(user.length > 0 && user.length <= 6, `${name}：给用户看的那段不超过 6 行（认知负担可控）`, String(user.length))
  const order = ['改什么：', '会不会打断你正在做的事：', '要不要重启：', '能不能改回来：', '影响范围：']
  const positions = order.map((label) => user.findIndex((line) => line.startsWith(label)))
  check(positions.every((index) => index >= 0) && positions.every((value, index) => index === 0 || value > positions[index - 1]),
    `${name}：按优先级排列（改什么 → 会不会打断 → 要不要重启 → 能不能改回 → 影响范围）`, JSON.stringify(positions))
  /* 过滤：用户段里不许出现技术术语（那些只该在技术依据里）。 */
  const jargon = ['volatile', 'dispose', 'fiber', 'profile', 'patch 层', 'schema', 'insert', 'HMR', '唯一寻址', '顶层字段']
  const leaked = jargon.filter((word) => user.some((line) => line.includes(word)))
  check(leaked.length === 0, `${name}：用户段里没有技术术语（过滤生效）`, leaked.join(', '))
}
check(userSection(cfgPreview.text)[0].includes('alpha'), '用户段第一行说清"改什么"（用通俗字段名/值）')
check(/会不会打断你正在做的事：不会/.test(userSection(cfgPreview.text)[2]) || /会不会打断你正在做的事：不会/.test(userSection(cfgPreview.text).join(' ')), 'volatile 字段 → 明确告诉用户"不会打断"')
check(userSection(cfgPreview.text).some((line) => line.startsWith('要不要重启：不用')), 'volatile 字段 → 明确告诉用户"不用重启"')
const cfgPreviewUser = userSection(cfgRebuildPreview.text).join(' ')
check(
  /会不会打断你正在做的事：(有可能|不会)/.test(cfgPreviewUser) && cfgPreviewUser.includes('会话'),
  '非 volatile 字段 → 用实时会话数告诉用户"会不会打断"',
  cfgPreviewUser,
)
check(userSection(cfgRebuildPreview.text).some((line) => line.includes('能不能改回来：能')), '用户段给出"能不能改回来"')

check(
  /完整覆盖：(本次没有未改字段被钉在 profile 层|以下未改字段会被钉在 profile 层)/.test(techSection(cfgPreview.text)),
  '技术依据里保留"完整覆盖"的结论（含"本次无额外影响"）',
  techSection(cfgPreview.text).split('\n').find((line) => line.startsWith('完整覆盖')),
)
/* 技术依据：完整保留官方语义与边界。 */
for (const phrase of ['volatile 判定', 'fiber._config 就地更新', '完整覆盖', '原子写入', '文件锁', '只能改已经存在的行', '会被官方拒绝']) {
  check(techSection(cfgPreview.text).includes(phrase), `技术依据里保留该语义：${phrase}`)
}
check(techSection(cfgRebuildPreview.text).includes('dispose + 重新创建'), '技术依据里说明非 volatile 会 dispose + 重新创建', techSection(cfgRebuildPreview.text).split('\n')[1])
/* 只在相关时才出现：平面字段改动不提"顶层字段"限制；给了嵌套对象才提。 */
check(!cfgPreview.text.includes('只合并顶层字段'), '平面字段改动不出现"顶层字段"限制（过滤）')
const cfgNested = await call(configTool, { action: 'set', entry: 'plain-row', values: { nested: { deep: 1 } } })
check(cfgNested.text.includes('只合并顶层字段'), '给了嵌套对象才提"只支持顶层字段"限制（按需出现）')

console.log('\n[配置] apply：走官方 edit，并把未改的字段一起带上')
const cfgApplied = await call(configTool, {
  action: 'set',
  entry: 'fake-row',
  values: { alpha: 9 },
  apply: true,
  previewToken: cfgPreview.data.previewToken,
})
check(configEditorFake.edits.length === 1, '带 apply:true 才调用官方 edit')
check(
  JSON.stringify(configEditorFake.edits[0].next) === JSON.stringify({ alpha: 9, beta: 'kept' }),
  '写入的是"完整覆盖"（未改的字段按当前值保留）',
  JSON.stringify(configEditorFake.edits[0].next),
)
check(cfgApplied.text.includes('【已写入】') && cfgApplied.text.includes('写入后的生效值'), '写入后回报实际生效值')
check(world.configRows[0].override.alpha === 9, '写入之后那一行的值确实变了')

console.log('\n[配置] reset：把覆盖交回继承值')
configEditorFake.edits.length = 0
const cfgResetPreview = await call(configTool, { action: 'reset', entry: 'fake-row' })
await call(configTool, { action: 'reset', entry: 'fake-row', apply: true, previewToken: cfgResetPreview.data.previewToken })
check(
  JSON.stringify(configEditorFake.edits[0].next) === JSON.stringify({ alpha: 1, beta: 'kept' }),
  'reset 把 next 设成继承值（官方 edit 会因此删掉覆盖行）',
  JSON.stringify(configEditorFake.edits[0].next),
)
await checkThrows('set 缺 values 时报错', '需要 values', () => call(configTool, { action: 'set', entry: 'fake-row' }))
const cfgNoChange = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: true } })
check(cfgNoChange.text.includes('没有变化'), 'set 目标值等于现值时明确说"没有变化"')

console.log('\n[配置] 治理：预览凭证 / 审批 / 审计 / 回滚 / 冲突')
const plainRowOverride = () => world.configRows.find((row) => row.id === 'plain-row').override
// 0) fail-closed：没有审批通道时拒绝写入
{
  const originalGet = ctx.get
  const p0 = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false } })
  ctx.get = (name) => (name === 'approval' ? undefined : originalGet(name))
  await checkThrows('没有审批通道时拒绝写入（fail closed）', '没有审批通道',
    () => call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false }, apply: true, previewToken: p0.data.previewToken }))
  ctx.get = originalGet
  check(JSON.stringify(plainRowOverride()) === '{}', 'fail-closed 拒绝时没有写入')
}
// 1) apply 缺 previewToken → 拒绝
await checkThrows('apply 缺 previewToken 被拒', '缺少 previewToken',
  () => call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false }, apply: true }))
// 2) 凭证不匹配 → 拒绝
const govPreview = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false } })
await checkThrows('previewToken 不匹配被拒', '预览凭证不匹配',
  () => call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false }, apply: true, previewToken: 'deadbeefdeadbeef' }))
// 3) 审批被拒 → 不写入
world.approval.calls.length = 0
world.approvalOutcome = 'rejected'
await checkThrows('审批被拒时拒绝写入', '未获批准',
  () => call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false }, apply: true, previewToken: govPreview.data.previewToken }))
check(world.approval.calls.length === 1, '拒绝前确实请求了审批（不是静默拒绝）', String(world.approval.calls.length))
check(JSON.stringify(plainRowOverride()) === '{}', '审批被拒时没有写入')
// 4) 审批通过 → 写入 + 审计
world.approvalOutcome = 'allowed-once'
world.approval.calls.length = 0
const cfgGovApplied = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false }, apply: true, previewToken: govPreview.data.previewToken })
check(cfgGovApplied.text.includes('【已写入】'), '审批通过后写入成功')
const govAuditA = cfgGovApplied.data.auditId
check(typeof govAuditA === 'string' && govAuditA.length > 0, '写入返回 auditId')
check(world.approval.calls.length === 1
  && world.approval.calls[0].toolName === 'dsh_config_manage'
  && String(world.approval.calls[0].reason).includes('plain-row'),
  '审批请求带工具名与原因', JSON.stringify(world.approval.calls[0]?.reason))
// 5) history 能查到
const cfgHistory = await call(configTool, { action: 'history' })
check(cfgHistory.text.includes(govAuditA) && cfgHistory.text.includes('gamma'), 'history 能查到刚才的审计记录与字段差异')
// 6) 回滚预览 + 凭证
const govRevertPreview = await call(configTool, { action: 'revert', entry: 'plain-row', auditId: govAuditA })
check(govRevertPreview.text.includes('【预览·未写入】') && typeof govRevertPreview.data.previewToken === 'string',
  '回滚先预览并给凭证')
// 7) 回滚应用：字段恢复成"未覆盖"
const govReverted = await call(configTool, {
  action: 'revert', entry: 'plain-row', auditId: govAuditA, apply: true, previewToken: govRevertPreview.data.previewToken,
})
check(govReverted.text.includes('【已回滚】') && !('gamma' in plainRowOverride()), '回滚把新加的覆盖字段删掉了', JSON.stringify(plainRowOverride()))
// 8) 冲突检测：回滚目标之后又被改过 → 拒绝回滚
const govP2 = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false } })
const govAppliedB = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: false }, apply: true, previewToken: govP2.data.previewToken })
const govP3 = await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: true } })
await call(configTool, { action: 'set', entry: 'plain-row', values: { gamma: true }, apply: true, previewToken: govP3.data.previewToken })
await checkThrows('回滚前字段又被改过时检测到冲突', '检测到冲突',
  () => call(configTool, { action: 'revert', entry: 'plain-row', auditId: govAppliedB.data.auditId, apply: true, previewToken: 'x' }))
// 9) approval: never → 只读
{
  const neverWorld = makeWorld()
  const neverCtx = makeCtx(neverWorld)
  await loadPlugin(neverCtx, { approval: 'never' })
  const neverTool = neverCtx.__tools.get('dsh_config_manage')
  const preview = await neverTool.execute({ action: 'set', entry: 'plain-row', values: { gamma: false } }, TEST_EXEC)
  const token = JSON.parse(preview.data).previewToken
  let caught
  try {
    await neverTool.execute({ action: 'set', entry: 'plain-row', values: { gamma: false }, apply: true, previewToken: token }, TEST_EXEC)
  } catch (error) {
    caught = error
  }
  check(caught?.message.includes('never'), 'approval=never 时拒绝一切写入（只读模式）', caught?.message)
  check(JSON.stringify(neverWorld.configRows.find((row) => row.id === 'plain-row').override) === '{}',
    'never 模式拒绝时没有写入')
}

/* ---- 2026-10-30：preset 语义收尾（不再是路由维度 / get 显示当前值 / 只接受 roster 内显式值） ---- */
console.log('\n[会话] get：Agent preset 显示当前值，不是 header 的创建事实')
// header = 创建事实（可能与当前值不同）；当前值在 agentPreset projection 里。
world.headers.set('s-preset', header('s-preset', { createdAt: NOW - 3 * HOUR, cwd: '/proj/a', agentPreset: 'legacy-a' }))
world.currentPresets.set('s-preset', 'standard') // 2026-10-29 repair 等价：日志追加了 agent-preset/selected
const presetGetCold = await call(sessionTool, { action: 'get', sessionId: 's-preset' })
check(presetGetCold.text.includes('Agent preset：standard（创建时：legacy-a）'),
  'get 冷会话：当前值来自 projection，header 值标注为"创建时"', presetGetCold.text.split('\n').slice(-1)[0])
check(presetGetCold.data.session.agentPreset === 'standard' && presetGetCold.data.session.createdWithPreset === 'legacy-a',
  'get 的 data：agentPreset=当前值，createdWithPreset=header', JSON.stringify(presetGetCold.data.session))
check(presetGetCold.data.session.agentPresetReadable === true, 'get 标出当前值是否可读')

// 活会话走 sessionProjections.stateOf（0 I/O 路径）。
await world.agents.resume({ resumeSessionId: 's-preset' })
world.currentPresets.set('s-preset', 'cordis')
const presetGetLive = await call(sessionTool, { action: 'get', sessionId: 's-preset' })
check(presetGetLive.text.includes('Agent preset：cordis（创建时：legacy-a）'),
  'get 活会话：直接读 Session projection（header 仍标创建时）', presetGetLive.text.split('\n').slice(-1)[0])
world.sessions.get('s-preset') // 活会话存在，才能走到 stateOf 分支
world.currentPresets.set('s-preset', 'standard')

// projection 不可读时回落 header 并明确标注（不假装知道当前值）。
const realObserve = world.sessionQuery.observeSession
world.sessionQuery.observeSession = async () => { throw new Error('projection unavailable (test marker)') }
services.sessionProjections.stateOf = () => undefined
world.headers.set('s-preset-cold', header('s-preset-cold', { createdAt: NOW - 2 * HOUR, cwd: '/proj/a', agentPreset: 'legacy-b' }))
const presetGetUnknown = await call(sessionTool, { action: 'get', sessionId: 's-preset-cold' })
check(presetGetUnknown.text.includes('（创建时；当前值读不到）'),
  'get 读不到 projection 时回落 header 并明说"当前值读不到"', presetGetUnknown.text.split('\n').slice(-1)[0])
check(presetGetUnknown.data.session.agentPresetReadable === false, 'get 的可读标记为 false（不把 header 冒充当前值）')
world.sessionQuery.observeSession = realObserve
services.sessionProjections.stateOf = (session, key) => (key === 'agentPreset'
  ? (world.currentPresets.get(session.id) ?? session.header.agentPreset ?? null)
  : undefined)

console.log('\n[会话] list 的 preset 字段改名 createdWithPreset（header 是创建事实）')
await world.registry.get('w-aaa').attachSession('s-preset')
const listWithPreset = await call(sessionTool, { action: 'list', workspaceId: 'w-aaa' })
const presetRow = listWithPreset.data.sessions.find((row) => row.sessionId === 's-preset')
check(presetRow !== undefined && presetRow.createdWithPreset === 'legacy-a', 'list 行用 createdWithPreset 暴露 header 值',
  JSON.stringify(presetRow))
check(presetRow !== undefined && presetRow.agentPreset === undefined, 'list 行不再用 agentPreset 这个名字（避免被当当前值）')

console.log('\n[架构] 2026-11-02 合并：session_router / 决策模型已移除')
check(ctx.__tools.get('session_router') === undefined, 'session_router 工具不再注册')
check(
  plugin.Config.__shape !== undefined
    && Object.keys(plugin.Config.__shape).sort().join(',') === 'approval,requirePreview,strictErrors',
  'Config 只有错误处理 + 配置治理三项（router / 决策模型配置已删除）',
  JSON.stringify(plugin.Config.__shape),
)
check(!sessionTool.parameters.action.enum.includes('create') && !sessionTool.parameters.action.enum.includes('preset'),
  'action 枚举不再有 create / preset（创建只有一个动词 start）')
check(sessionTool.parameters.task === undefined && sessionTool.parameters.decide === undefined,
  'start 不再有 task / decide 参数（工具不替 agent 猜位置）')
check(sessionTool.parameters.agentPreset?.type === 'string', 'start 仍可在创建时指定 agentPreset')

/* ---- schema 编译 ---- */
console.log('\n[通用] 输出 schema 形状')
check(typeof workspaceTool.description === 'string' && workspaceTool.description.length > 80, '工作区工具描述足够具体')
check(typeof sessionTool.description === 'string' && sessionTool.description.length > 80, '会话工具描述足够具体')
// 描述必须与实现一致：唯一需要活会话的 action 是 rename；pin/unpin/archive/unarchive 只走 registry；
// rename 对未加载会话默认拒绝，只有显式 resume: true 才走 sessionController。
check(sessionTool.description.includes('`rename` is the ONLY action that needs a live session'),
  '会话工具描述只对 rename 声明"需要活会话"')
check(sessionTool.description.includes('`pin`/`unpin`/`archive`/`unarchive` need no live session'),
  '会话工具描述说明 pin / archive 不要求活会话')
check(!/pin and archive need the session to be live/.test(sessionTool.description), '会话工具描述不再声称 pin / archive 需要活会话')
check(sessionTool.description.includes('resume:true') && sessionTool.description.includes('loads, renames, and releases in one call'),
  '会话工具描述讲清了 resume: true 是"加载→改名→释放"')
check(sessionTool.description.includes('does not stay live'), '会话工具描述明确不会留下常驻会话')
// 描述必须讲清 list 的两种语义——否则模型又会拿全量列表去撞 520 条。
check(
  sessionTool.description.includes('it does NOT dump every session')
    && sessionTool.description.includes('compact per-workspace summary')
    && sessionTool.description.includes('dsh_workspace_manage list')
    && sessionTool.description.includes('default 50'),
  '会话工具描述讲清 list 的两种语义、workspaceId 来源与默认上限',
)
// 本次修复的核心契约：send / steer / queue 的区别 + 默认规则必须在描述里。
check(
  sessionTool.description.includes('`send` delivers an instruction')
    && sessionTool.description.includes('NEXT turn')
    && sessionTool.description.includes('injects into the turn the target is running')
    && sessionTool.description.includes('use `send` — it is non-disruptive'),
  '会话工具描述写清 send / steer 语义与"不确定时用 send"的默认规则',
)
check(
  sessionTool.description.includes('`queue` inspects/edits/removes messages')
    && sessionTool.description.includes('never sends new text'),
  '会话工具描述写清 queue 不能用来发送',
)
check(
  /only sessions in no workspace; returns the flat list/.test(sessionTool.parameters.ungrouped.description),
  'ungrouped 参数说明它会返回扁平列表（不绕回分组摘要）',
)
check(/list: alternative to workspaceId/.test(sessionTool.parameters.cwd.description), 'cwd 参数说明它也可用于 list')
check(sessionTool.parameters.resume?.type === 'boolean', 'schema 里有 resume 布尔参数')
check(workspaceTool.output.schema.additionalProperties === false, '输出 schema 关闭额外字段')
check(typeof workspaceTool.output.render === 'function', '输出带 render')

/* ---- caveat 2：静默降级路径的可断言覆盖（logger.warn 不落盘时的替代证据） ---- */
console.log('\n[降级] 静默错误路径：工具仍成功 + 记录预期 warn')
const takeWarnings = () => world.warnings.splice(0)
world.warnings.length = 0
world.sessions.create('s-degrade', { meta: { cwd: '/proj/a' } })
world.titles.set('s-degrade', '降级测试会话')

// A. 标题服务整批失败 → 列表降级为"标题未知"，不整体失败
{
  const original = world.sessionQuery.readTitleSnapshots
  world.sessionQuery.readTitleSnapshots = async () => { throw new Error('titles boom') }
  const degraded = await call(sessionTool, { action: 'list', workspaceId: 'w-aaa' })
  world.sessionQuery.readTitleSnapshots = original
  check(degraded.data?.sessions?.length > 0, '标题读取失败时 list 仍返回行（降级不阻塞）')
  check(takeWarnings().some((line) => line.includes('session titles unavailable')),
    '标题读取失败记录了预期 warn（session titles unavailable）')
  check(degraded.text.includes('部分标题读取失败'), '标题读取失败在输出里如实告知（不再静默降级）', degraded.text.slice(0, 120))
}

// B. 播报失败（ctx.emit 抛）→ 工具仍成功，只记 warn
{
  const originalEmit = ctx.emit
  ctx.emit = () => { throw new Error('emit boom') }
  const pinnedLive = await call(sessionTool, { action: 'pin', sessionId: 's-degrade' })
  ctx.emit = originalEmit
  check(pinnedLive.text.includes('已置顶'), '播报失败时 pin 仍成功（补帧是 best-effort）')
  check(takeWarnings().some((line) => line.includes('announce failed')), '播报失败记录了预期 warn（announce failed）')
  check(pinnedLive.text.includes('界面行可能未刷新'), '播报失败在输出里告知"界面可能没刷新"', pinnedLive.text.slice(-80))
  await call(sessionTool, { action: 'unpin', sessionId: 's-degrade' })
}

// C. 公开 list() 失败 → 回落私有路径，工具仍成功
{
  world.faults.controllerList = true
  const pinnedC = await call(sessionTool, { action: 'pin', sessionId: 's-degrade' })
  world.faults.controllerList = false
  check(pinnedC.text.includes('已置顶'), '公开 list() 失败时 pin 仍成功（回落私有路径）')
  check(takeWarnings().some((line) => line.includes('list summary failed')), '公开 list() 失败记录了预期 warn')
  await call(sessionTool, { action: 'unpin', sessionId: 's-degrade' })
}

// D. 私有 summary 也失败 → 仍不阻塞，只记 warn
{
  world.faults.privateSummary = true
  const pinnedD = await call(sessionTool, { action: 'pin', sessionId: 's-degrade' })
  world.faults.privateSummary = false
  check(pinnedD.text.includes('已置顶'), '私有 summary 失败时 pin 仍成功（拿不到摘要就不发幽灵帧）')
  check(takeWarnings().some((line) => line.includes('private summaryFor failed')), '私有 summary 失败记录了预期 warn')
  await call(sessionTool, { action: 'unpin', sessionId: 's-degrade' })
}

// E. fork 之后登记工作区失败 → fork 仍成功，文本如实提示"未分组"
{
  const originalList = world.registry.list
  world.registry.list = () => [{
    id: 'w-bbb',
    title: 'B 工作区',
    sessionIds: ['s-degrade'],
    attachSession: async () => { throw new Error('attach boom') },
  }]
  const forkedDegraded = await call(sessionTool, { action: 'fork', sessionId: 's-degrade' })
  world.registry.list = originalList
  check(forkedDegraded.text.includes('没能登记进工作区'), 'fork 登记失败时文本如实说明"未分组"')
  check(takeWarnings().some((line) => line.includes('fork 之后登记进工作区失败')), 'fork 登记失败记录了预期 warn')
}

// F. 配置工具查活动会话失败 → 仍可返回配置，只记 warn
{
  world.faults.querySessions = true
  const configDegraded = await call(configTool, { action: 'list', limit: 3 })
  world.faults.querySessions = false
  check(typeof configDegraded.text === 'string' && configDegraded.text.length > 0, '活动会话查询失败时配置 list 仍返回内容')
  check(takeWarnings().some((line) => line.includes('配置工具查活动会话失败')), '配置工具查询失败记录了预期 warn')
}

// G2. 启动必需行预警 + 收据掩码
console.log('\n[配置] 危险行预警与收据掩码')
{
  const riskWorld = makeWorld()
  riskWorld.configRows = [
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', inherited: { port: 3080 }, override: {} },
    { id: 'secrets-row', name: '@local/secrets', inherited: { apiKey: 'inherited-key', gamma: true }, override: {} },
  ]
  const riskCtx = makeCtx(riskWorld)
  await loadPlugin(riskCtx)
  const riskTool = riskCtx.__tools.get('dsh_config_manage')

  const riskPreview = await riskTool.execute({ action: 'set', entry: 'webserver', values: { port: 0 } }, TEST_EXEC)
  check(riskPreview.message.includes('启动必需行') && riskPreview.message.includes('cordis.patch.yml'),
    '启动必需行：预览给出"可能让 App 打不开"的强提示与应急恢复步骤')
  const riskToken = JSON.parse(riskPreview.data).previewToken
  const riskApplied = await riskTool.execute({ action: 'set', entry: 'webserver', values: { port: 0 }, apply: true, previewToken: riskToken }, TEST_EXEC)
  check(riskApplied.message.includes('收据·原始覆盖值'), '写入成功后附"原始覆盖值"收据')
  check(riskApplied.message.includes('恢复：action=reset'), '收据给出恢复命令')
  check(riskApplied.message.includes('启动必需行'), '启动必需行写入成功也附应急恢复提示')

  const secretPreview = await riskTool.execute({ action: 'set', entry: 'secrets-row', values: { apiKey: 'super-secret-123' } }, TEST_EXEC)
  check(!secretPreview.message.includes('super-secret-123') && secretPreview.message.includes('***'),
    '预览对敏感字段掩码（不打印明文密钥）', secretPreview.message.slice(0, 100))
  const nestedPreview = await riskTool.execute({ action: 'set', entry: 'secrets-row', values: { providers: [{ apiKey: 'nested-secret-456' }] } }, TEST_EXEC)
  check(!nestedPreview.message.includes('nested-secret-456'),
    '字段名不敏感但值里嵌了密钥（providers[].apiKey）也会掩码', nestedPreview.message.slice(0, 120))
  const secretToken = JSON.parse(secretPreview.data).previewToken
  const secretApplied = await riskTool.execute({ action: 'set', entry: 'secrets-row', values: { apiKey: 'super-secret-123' }, apply: true, previewToken: secretToken }, TEST_EXEC)
  check(!secretApplied.message.includes('super-secret-123'), '写入成功回执不打印明文密钥')
  check(secretApplied.message.includes('敏感字段'), '收据提示敏感字段已掩码')
}

// G. 编程错误必须重新抛出（不允许被兜底吞掉）
{
  const original = world.sessionQuery.readTitleSnapshots
  world.sessionQuery.readTitleSnapshots = async () => { throw new TypeError('our bug, must not be swallowed') }
  let caught
  try {
    await call(sessionTool, { action: 'list', workspaceId: 'w-aaa' })
  } catch (error) {
    caught = error
  }
  world.sessionQuery.readTitleSnapshots = original
  check(caught instanceof TypeError && caught.message.includes('our bug'),
    '编程错误（TypeError）被重新抛出，而不是被静默降级吞掉', caught?.message)
  takeWarnings()
}

// H. strictErrors 模式：降级路径直接抛错（开发/测试用）
{
  const strictWorld = makeWorld()
  const strictCtx = makeCtx(strictWorld)
  const strictPlugin = await loadPlugin(strictCtx, { strictErrors: true })
  const strictSessionTool = strictCtx.__tools.get('dsh_session_manage')
  strictWorld.sessionQuery.readTitleSnapshots = async () => { throw new Error('service down') }
  let strictCaught
  try {
    await strictSessionTool.execute({ action: 'list', workspaceId: 'w-aaa' }, { signal: undefined })
  } catch (error) {
    strictCaught = error
  }
  check(strictCaught?.message === 'service down', 'strictErrors=true 时降级路径直接抛错（不再降级）', strictCaught?.message)
  check(strictCtx.__tools.get('dsh_workspace_manage') !== undefined, 'strict 模式仍正常注册工具')
}

console.log(`\n======================\n${checks - failures}/${checks} 项通过`)
if (failures > 0) {
  console.log(`${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过（注意：这是假 DSH 的逻辑验证，真实服务行为仍需安装后实测）')
void pathToFileURL
