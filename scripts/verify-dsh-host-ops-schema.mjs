#!/usr/bin/env node
/**
 * verify-dsh-host-ops-schema.mjs —— 用**真实**的 `@deepseek-ai/dsh-tools` 与
 * `@deepseek-ai/schemastery` 编译 dsh-host-ops 的工具定义。
 *
 * 为什么需要这一步：`defineTool()` 会在注册时把参数 schema 与输出 schema
 * 编译成受支持的 JSON Schema 子集，写错一个 key（比如 parameters 里出现
 * `items` 却没写 `type`、或 output 里用了 `oneOf` 之外的多分支）就会**在加载时抛错**，
 * 让整个插件挂不上。这个脚本把这一步提前到工作区里做，不需要装 profile。
 *
 * 它直接从 App 的 app.asar 里 import 真实模块——纯 ESM、无 Electron 依赖，
 * 因此 Node 能直接加载。
 *
 * 覆盖的**是**：真实 schema 编译、工具名/描述/参数面、输出 schema 形状。
 * 覆盖的**不是**：真实服务行为（那是 scripts/verify-dsh-host-ops.mjs 的假 DSH 逻辑验证，
 * 以及安装后的实测）。
 *
 * 用法：node scripts/verify-dsh-host-ops-schema.mjs
 *
 * @module verify-dsh-host-ops-schema
 */

import { createHash as nodeCreateHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = path.join(ROOT)
const ASAR = process.env.DSH_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

let failures = 0
let checks = 0

/**
 * 断言并记账。
 * @param condition - 断言条件。
 * @param label - 断言语义。
 * @param detail - 失败细节。
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

if (!fs.existsSync(ASAR)) {
  console.error(`找不到 app.asar：${ASAR}`)
  process.exit(2)
}

/**
 * 把 asar 内的包提取到 `reference/tmp/dsh-host-ops-schema/`。
 *
 * 从入口包开始按 `dependencies` + `peerDependencies` 广度优先展开：
 * dsh-tools → cordis / dsh-llm / dsh-sandbox / … → cosmokit / zod。
 * dsh 的包把跨包引用放在 peerDependencies 里（真实安装由 profile 的
 * node_modules 解析），所以两者都要跟。这样 import 真实 dsh-tools 时
 * 整棵依赖树都能解析，不用手动罗列。
 *
 * @param entry - 入口包名，形如 `@deepseek-ai/dsh-tools`。
 * @returns 提取根目录绝对路径。
 */
function extractDependencyTree(entry) {
  // 输出根就是 node_modules 本身：--strip dsh/node_modules/ 之后，
  // 每个包正好落在 <root>/@scope/name/...，与真实安装布局一致。
  const root = path.join(ROOT, 'reference', 'tmp', 'dsh-host-ops-schema', 'node_modules')
  fs.mkdirSync(root, { recursive: true })
  const queue = [entry]
  const seen = new Set()
  const missing = []
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const target = path.join(root, name)
    fs.mkdirSync(target, { recursive: true })
    spawnExtract(`${name}/`, root)
    const manifestPath = path.join(target, 'package.json')
    if (!fs.existsSync(manifestPath)) {
      missing.push(name)
      continue
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(manifest[field] ?? {})) queue.push(dependency)
    }
  }
  if (missing.length > 0) throw new Error(`提取依赖树失败，缺少：${missing.join(', ')}`)
  return root
}

/**
 * 调工作区自带的 asar 提取脚本。
 * @param pattern - 归档内路径正则。
 * @param outRoot - 输出根目录（提取结果落在 outRoot/<包内相对路径>）。
 * @returns 提取脚本的输出（含写入计数）。
 */
function spawnExtract(pattern, outRoot) {
  const run = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dsh-asar-extract.mjs'),
    'extract', pattern, '--out', outRoot, '--strip', 'dsh/node_modules/',
  ], { encoding: 'utf8' })
  return `${run.stdout ?? ''}${run.stderr ?? ''}`
}

console.log('用真实 dsh-tools / schemastery 编译 dsh-host-ops 工具定义\n')
const extractedRoot = extractDependencyTree('@deepseek-ai/dsh-tools')
const toolsDir = path.join(extractedRoot, '@deepseek-ai', 'dsh-tools')
const schemaDir = path.join(extractedRoot, '@deepseek-ai', 'schemastery')
const tools = await import(pathToFileURL(path.join(toolsDir, 'lib', 'index.js')).href)
const schemastery = await import(pathToFileURL(path.join(schemaDir, 'lib', 'index.mjs')).href)
check(typeof tools.defineTool === 'function', '真实 dsh-tools 导出了 defineTool')
check(schemastery.default !== undefined && typeof schemastery.default.object === 'function', '真实 schemastery 导出可用')

/* 把插件的两个 import 指到真实模块上。 */
const source = fs.readFileSync(path.join(PLUGIN, 'lib', 'index.js'), 'utf8')

/*
 * 裸包 import 必须有对应的 peerDependencies —— 这一步是补上真实故障的缺口。
 *
 * bundle 用 link: 装进 profile 后，它的目录是 dsh 的 linked root；
 * `@deepseek-ai/dsh-app-boot` 的 routeLinked/readPeerNames 只按**当前 package.json 的
 * peerDependencies 键名**（且该名字在安装区运行时表里）把解析改道到 dsh 安装目录。
 * 少一个 key，解析就退回 Node 原生 → `Cannot find package '@deepseek-ai/schemastery'`
 * → Loader 报 failed to import、整行 inactive。
 *
 * 下面的 replace() 会把这两个 import 换成局部常量，所以「用真实 dsh-tools 编译」
 * 这一步永远发现不了这类问题；必须在替换之前、对着原始源码单独断言。
 */
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
const peerNames = Object.keys(manifest.peerDependencies ?? {})
const bareImports = [...source.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)]
  .map((match) => match[1])
  .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('cordis:'))
check(
  bareImports.length > 0 && bareImports.every((name) => peerNames.includes(name)),
  '每个裸包 import 都在 peerDependencies 里声明',
  `imports=${bareImports.join(', ') || '(无)'} peers=${peerNames.join(', ') || '(无)'}`,
)

const withRealImports = source
  .replace("import { createHash } from 'node:crypto'", 'const createHash = CREATE_HASH')
  .replace("import z from '@deepseek-ai/schemastery'", 'const z = SCHEMASTERY.default')
  .replace("import { defineTool } from '@deepseek-ai/dsh-tools'", 'const { defineTool } = TOOLS')
  .replace(/\bexport const\b/g, 'const')
  .replace(/\bexport function apply\b/g, 'function apply')

const registered = new Map()
const ctx = {
  workspaceRegistry: { list: () => [], get: () => undefined, archivedSessionIds: [], pinnedSessionIds: [] },
  sessionQuery: { listSessions: async () => [], readTitleSnapshots: async (ids) => ids.map(() => ({ status: 'rejected' })) },
  tools: { register: (definition) => registered.set(definition.name, definition) },
  get: () => undefined,
  logger: { warn: () => {} },
}

/** 只在编译期需要：拿到 apply 并跑一遍注册。 */
const factory = new Function(
  'TOOLS', 'SCHEMASTERY', 'CREATE_HASH',
  `${withRealImports}\nreturn { name, inject, Config, apply }\n`,
)

let module
try {
  module = factory(tools, schemastery, nodeCreateHash)
  module.apply(ctx, {})
  check(true, 'apply() 在真实 defineTool 下执行成功（schema 编译通过）')
} catch (error) {
  check(false, 'apply() 在真实 defineTool 下执行成功', error instanceof Error ? error.message : String(error))
}

const workspaceTool = registered.get('dsh_workspace_manage')
const sessionTool = registered.get('dsh_session_manage')
const configTool = registered.get('dsh_config_manage')
check(workspaceTool !== undefined, 'dsh_workspace_manage 已注册')
check(sessionTool !== undefined, 'dsh_session_manage 已注册')

if (workspaceTool !== undefined) {
  // defineTool() 已经把 author spec 编译成下发用的 JSON Schema，直接用它的产物断言。
  const parameters = workspaceTool.parameters
  check(parameters.type === 'object', '工作区工具参数编译成 object')
  check(parameters.required?.includes('action') === true, 'action 是必填参数')
  check(
    JSON.stringify(parameters.properties.action.enum)
      === JSON.stringify(['list', 'get', 'create', 'rename', 'reorder', 'remove']),
    '工作区 action 枚举与实现分支一一对应',
    JSON.stringify(parameters.properties.action.enum),
  )
  check(parameters.properties.order.type === 'array' && parameters.properties.order.items.type === 'string', 'order 编译成 string 数组')
  check(workspaceTool.output.schema.type === 'object', '工作区输出 schema 编译成 object')
}

if (workspaceTool !== undefined) {
  // 走 defineTool 自带的参数校验：非法参数必须在进入 execute 之前就被拒
  // （execute 抛的是 ToolArgsError，body 根本不会执行）。
  const rejects = async (args) => {
    try {
      await workspaceTool.execute(args, { signal: undefined })
      return null
    } catch (error) {
      // ToolArgsError 是 HarnessError 的子类，name 就是错误类型名。
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  }
  const missingAction = await rejects({ action: 'nope' })
  check(missingAction !== null && missingAction.includes('ToolArgsError'), '非法 action 被 schema 拦下', String(missingAction))
  const wrongType = await rejects({ action: 'list', showIds: 'yes' })
  check(wrongType !== null && wrongType.includes('ToolArgsError'), '错类型参数被 schema 拦下', String(wrongType))
  const okList = await workspaceTool.execute({ action: 'list' }, { signal: undefined })
  check(okList.ok === true && okList.action === 'list', '合法调用进入 execute 并返回声明值')
  check(typeof okList.message === 'string' && okList.message !== '', '输出 message 非空')
  check(okList.data === undefined || typeof okList.data === 'string', 'data 是字符串（声明为 json，序列化后下发）')
  const rendered = workspaceTool.output.render({ action: 'list' }, okList)
  check(Array.isArray(rendered) && rendered[0]?.type === 'text', 'render 产出文本块')
}

if (sessionTool !== undefined) {
  const parameters = sessionTool.parameters
  const expected = [
    'list', 'get', 'start', 'send', 'steer', 'cancel', 'wait', 'notify',
    'queue', 'search', 'read', 'fork', 'attach', 'rename', 'reorder', 'sort', 'pin', 'unpin',
    'archive', 'unarchive', 'openPath', 'model',
  ]
  check(
    JSON.stringify(parameters.properties.action.enum) === JSON.stringify(expected),
    '会话 action 枚举与文档一致',
    JSON.stringify(parameters.properties.action.enum),
  )
  check(parameters.required?.includes('action') === true && parameters.required.length === 1, '只有 action 必填，其余全部可选')
  check(parameters.properties.by.enum.includes('created-desc'), 'by 枚举含 created-desc')
  check(parameters.properties.kind.enum.join(',') === 'session,subagent', 'kind 枚举正确')
  check(parameters.properties.order.items.type === 'string', '会话 order 编译成 string 数组')
  check(sessionTool.output.schema.additionalProperties === false, '输出 schema 关闭额外字段')

  /*
   * 交付语义契约（本次修复的核心）：send / steer / queue 的差别必须写在模型能看到的地方，
   * 而且**第一屏就要能看到**——按需加载只展示描述前 ~240 字符（dsh-tool-discovery 截断），
   * 若 steer/queue 规则藏在长描述尾部，模型搜到也用不对。
   */
  const opening = sessionTool.description.slice(0, 240)
  check(/send/.test(opening) && /steer/.test(opening) && /queue/.test(opening),
    '描述前 240 字符（发现目录的展示窗口）同时出现 send / steer / queue',
    opening)
  check(
    sessionTool.description.includes('delivers an instruction')
      && sessionTool.description.includes('NEXT turn')
      && sessionTool.description.includes('injects into the turn the target is running')
      && sessionTool.description.includes('RIGHT NOW'),
    '描述写清 send = 下一轮 / steer = 当前正在跑的 turn',
  )
  check(
    sessionTool.description.includes('`queue` inspects/edits/removes messages')
      && sessionTool.description.includes('never sends new text'),
    '描述写清 queue 只管理已排队消息、不能用来发送',
  )
  check(
    sessionTool.description.includes('running and you are unsure which the user wants, use `send`'),
    '描述给出"运行中且不确定时优先 send（不打断）"的默认规则',
  )
  check(
    sessionTool.description.includes('`list` and `get` report whether a turn is running')
      && sessionTool.description.includes('运行中'),
    '描述说明 list/get 会报告运行状态（模型据此选 send / steer）',
  )
  check(
    sessionTool.description.includes('`rename` is the ONLY action that needs a live session')
      && sessionTool.description.includes('`pin`/`unpin`/`archive`/`unarchive` need no live session'),
    '描述仍守住"只有 rename 需要活会话"的事实',
  )
  const actionDescription = parameters.properties.action.description
  check(/MESSAGE DELIVERY/.test(actionDescription) && /prefer send/.test(actionDescription),
    'action 参数描述带交付决策规则（模型选枚举值时能看到）', actionDescription.slice(0, 160))
  check(/queue` = inspect/.test(actionDescription) && /never sends/.test(actionDescription),
    'action 参数描述写明 queue 不发送')
  check(
    parameters.properties.prompt.description.includes('NEXT turn')
      && parameters.properties.prompt.description.includes('steer'),
    'prompt 参数描述覆盖 send / steer 两种投递语义',
  )
  /* wait 的默认值必须与实现一致（实现：默认 90s、上限 30min；描述曾写 600000，是真实漂移）。 */
  check(
    parameters.properties.timeoutMs.description.includes('default 90000')
      && parameters.properties.timeoutMs.description.includes('1800000'),
    'wait.timeoutMs 描述与实现默认值/上限一致（90000 / 1800000）',
    parameters.properties.timeoutMs.description,
  )
  check(
    parameters.properties.queueAction.description.includes('ALREADY pending')
      && parameters.properties.queueAction.description.includes('never adds a new message'),
    'queueAction 参数描述写明它不新增消息',
  )
}

if (workspaceTool !== undefined) {
  /* 跨工具分工：工作区 vs 会话、工作区排序 vs 会话排序，是用户报告的"同类问题"之一。 */
  check(
    workspaceTool.description.includes('this tool manages WORKSPACES')
      && workspaceTool.description.includes('dsh_session_manage manages the SESSIONS'),
    '工作区工具描述写明与会话工具的分工',
  )
  check(
    workspaceTool.description.includes('WORKSPACE order')
      && workspaceTool.parameters.properties.action.description.includes('dsh_session_manage reorder'),
    '工作区 reorder 与会话 reorder 在描述里被区分',
  )
  check(workspaceTool.description.includes('remove only unregisters'),
    '工作区 remove 语义（只注销、不删数据）保持不变')
}

/* 2026-11-02 架构合并：session_router 工具与其决策模型（config.router / 21 字段）已删除。
 * 创建只剩 dsh_session_manage.start 一个入口，位置必须显式给出——工具不再替 agent 猜。 */
check(registered.get('session_router') === undefined, 'session_router 工具已移除（创建入口合并为一个）')
check(registered.size === 3, '插件只注册 3 个工具（workspace / session / config）', [...registered.keys()].join(','))
check(
  sessionTool.description.includes('it requires an explicit `workspaceId` or `cwd`')
    && sessionTool.description.includes('never guesses where a session belongs'),
  '会话工具描述写明 start 必须显式给位置（工具不猜工作区）',
)
check(
  sessionTool.description.includes('There is deliberately no blank-session action'),
  '会话工具描述写明没有空白会话动作（create 已移除）',
)
check(
  sessionTool.parameters.properties.task === undefined && sessionTool.parameters.properties.decide === undefined,
  'start 不再有 task / decide 参数（决策模型已移除）',
)
check(module.Config !== undefined, '插件仍导出 Config（当前为空 schema）')
{
  const patchText = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  check(!/decisionProvider|typesafeBaseUrl|config:\s*\n\s+router/.test(patchText),
    'bundle patch 不再包含 router / 决策模型配置')
}

/* 发现层窗口：按需加载只展示 240 字符（工具）/ 200 字符（组描述）。
 * 关键决策规则（send vs steer vs queue、remove 只注销、TWO-STEP、router vs start）
 * 必须落在第一屏内，否则模型搜到工具时根本看不到它们。 */
if (workspaceTool !== undefined) {
  const opening = workspaceTool.description.slice(0, 240)
  check(/remove only unregisters/.test(opening) && /dsh_session_manage reorder/.test(opening),
    '工作区描述前 240 字符含"remove 只注销"与"会话排序去别处"', opening)
}
if (configTool !== undefined) {
  const opening = configTool.description.slice(0, 240)
  check(/TWO-STEP/.test(opening) && /apply: true/.test(opening),
    '配置描述前 240 字符含两段式写入规则', opening)
}

if (sessionTool !== undefined) {
  /* 子会话栅栏：prompt 对 subagent child 会被 session/agent-busy 拒绝——必须在描述里说清，
   * 否则模型会一直重试 send/steer（官方要求走 subagents 域的交付通道）。 */
  check(
    sessionTool.description.includes('Child sessions (origin: subagent) accept no send/steer')
      && sessionTool.description.includes('subagents domain'),
    '会话工具描述写明子会话不能由 send/steer 投递',
  )
  /* 空闲 steer 的官方事实：prompt(steer) 空闲也接受并立刻开一轮；工具按官方客户端规则解析为 queue。 */
  check(
    sessionTool.description.includes('when the target is idle (or its state cannot be read)')
      && sessionTool.description.includes('resolves it to queue instead and says so'),
    '描述写明空闲/状态未知的 steer 会被解析为 queue（与官方客户端 !running → queue 一致）',
  )
}

/* 组描述由 dsh-tool-discovery 读：它出现在系统提示的按需组清单里，必须 <=200 字符且含交付关键词。
 * 单插件公开仓里没有 dsh-tool-discovery，缺文件时跳过这条跨仓断言。 */
{
  const discoveryPath = path.join(ROOT, 'plugins', 'dsh-tool-discovery', 'lib', 'index.js')
  if (fs.existsSync(discoveryPath)) {
    const discoverySource = fs.readFileSync(discoveryPath, 'utf8')
    const group = discoverySource.match(/id: 'dsh-host-ops',\s*description: '([^']*)'/)
    check(group !== null, 'dsh-tool-discovery 里有 dsh-host-ops 组描述')
    if (group !== null) {
      const text = group[1]
      check(text.length <= 200, 'dsh-host-ops 组描述 <=200 字符（系统提示不截断决策关键词）', `${text.length} 字符`)
      check(text.includes('send vs steer') && text.includes('send = next turn') && text.includes('steer = redirect'),
        'dsh-host-ops 组描述带 send / steer 关键词与语义')
    }
  } else {
    check(true, '单插件仓：dsh-tool-discovery 不在本仓，跳过跨仓组描述断言')
  }
}

if (configTool !== undefined) {
  const parameters = configTool.parameters
  check(
    JSON.stringify(parameters.properties.action.enum) === JSON.stringify(['list', 'get', 'set', 'reset', 'revert', 'history']),
    '配置 action 枚举 = list/get/set/reset/revert/history',
    JSON.stringify(parameters.properties.action.enum),
  )
  check(parameters.required?.includes('action') === true && parameters.required.length === 1, '配置工具只有 action 必填')
  check(
    parameters.properties.values.type === 'object' && parameters.properties.values.additionalProperties === true,
    'values 编译成"任意字段的对象"（顶层字段合并）',
    JSON.stringify(parameters.properties.values),
  )
  check(parameters.properties.apply.type === 'boolean', 'apply 是布尔（两段式写的开关）')
  /* 文档契约：写操作必须"先预览、经用户同意后再写"——这条要求写在工具描述里，用断言守住。 */
  check(
    /WITHOUT `apply` first/.test(configTool.description)
      && /explicitly agrees/.test(configTool.description)
      && /never pass `apply: true` in the same turn as the preview/.test(configTool.description),
    '描述里写明"先预览 → 用户明确同意 → 才带 apply:true"',
  )
  for (const phrase of ['home patches and command-line overlays', 'read-only', 'COMPLETE', 'interrupted', 'needs a restart', 'EXISTING rows only']) {
    check(configTool.description.includes(phrase), `描述里写明该限制：${phrase}`)
  }
}

/* 参数面与实际用到的参数是否对得上：代码里 args.* 提到的键必须都在 schema 里。 */
if (sessionTool !== undefined && workspaceTool !== undefined && configTool !== undefined) {
  const keysOf = (tool) => new Set(Object.keys(tool.parameters.properties))
  const declared = new Set([
    ...keysOf(sessionTool),
    ...keysOf(workspaceTool),
    ...keysOf(configTool),
  ])
  const usedByPlugin = new Set([...source.matchAll(/args\.([a-zA-Z]+)/g)].map((match) => match[1]))
  const missing = [...usedByPlugin].filter((key) => !declared.has(key))
  check(missing.length === 0, '代码里用到的 args.* 都在 schema 里声明过', missing.join(', '))
  const undocumented = [...declared].filter((key) => !usedByPlugin.has(key))
  check(undocumented.length === 0, 'schema 里没有代码从不读取的死参数', undocumented.join(', '))
}

check(module !== undefined && module.name === 'dsh-host-ops', '插件名正确')
check(
  Array.isArray(module?.inject) && module.inject.join(',') === 'tools,workspaceRegistry,sessionQuery',
  'inject 只声明了确认存在的三个服务',
  String(module?.inject),
)

console.log(`\n======================\n${checks - failures}/${checks} 项通过`)
if (failures > 0) {
  console.log(`${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过：真实 dsh-tools 能编译并注册三个工具')
