#!/usr/bin/env node
/**
 * check-plugin-compliance.mjs —— 只读检查 DSH 插件是否符合官方规范（docs/spec-matrix.md）。
 *
 * 为什么要有它：2026-11-14 的启动事故不是"没读文档"，而是**读了文档、朝合规方向改造**
 * 仍然写出了会让 Host 拒绝启动的代码（`modifyRecord` 写了裸对象，缺 `kind`）。
 * 规范必须落成可执行检查，否则下一次还会靠人肉记忆。
 *
 * 检查的是"契约与组合面"，不是行为正确性：
 *   - 规则表见 docs/spec-matrix.md（每条 rule ID 对应那里的一个卡片）；
 *   - 行为验证仍走 scripts/check-plugins.sh 的 run_verifier 列表。
 *
 * 只读：本脚本不写任何文件（--self-test 也只读内存/`git show`）。
 *
 * 用法：
 *   node scripts/check-plugin-compliance.mjs                    # 审计 plugins/*，A 级违规退出 1
 *   node scripts/check-plugin-compliance.mjs --strict           # A+B 全部阻断（发布前 G1 用）
 *   node scripts/check-plugin-compliance.mjs --dir <abs-dir>    # 审计单个插件目录（可重复）
 *   node scripts/check-plugin-compliance.mjs --root <dir>       # 审计一个根（子目录或它本身是插件）
 *   node scripts/check-plugin-compliance.mjs --json             # 机器可读
 *   node scripts/check-plugin-compliance.mjs --list-rules       # 打印规则表
 *   node scripts/check-plugin-compliance.mjs --self-test        # 回归用例（旧 dsh-channels 必须报错）
 *
 * 退出码：
 *   0 = 阈值以上的违规为 0；1 = 有；2 = 用法/IO 错误（目录不存在、manifest 读不了）。
 *
 * @module check-plugin-compliance
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const FIXTURES = path.join(HERE, 'fixtures', 'compliance')

/** 不是产品插件的目录：整目录豁免（理由要写清）。 */
const EXEMPT = {
  'hello-dsh': '官方起点模板抄本，不是产品插件（与 audit-plugin-presentation.mjs 同一豁免）',
}

/** 官方已占用的服务名：插件 provide 同名会抢占 provider。 */
const OFFICIAL_SERVICES = new Set([
  'agents', 'attachments', 'authorization', 'configEditor', 'connection', 'credentials',
  'credentialsController', 'deepseekAccount', 'layout', 'locale', 'mcpManager', 'pluginManager',
  'profileContext', 'sessionController', 'sessionProjections', 'sessionProjectionCache',
  'sessionQuery', 'skills', 'systemPrompt', 'theme', 'tools', 'typertGateway', 'uiWorkspace',
  'webServer', 'workspaceRegistry',
])

const SEVERITY_ORDER = { A: 0, B: 1, C: 2 }

// ─────────────────────────────────────────── 源码视图：去注释、括号配平、取实参

/** 把注释替换成等长空格（保留换行），字符串原样保留。 */
function stripComments(src) {
  const out = src.split('')
  const n = src.length
  let i = 0
  let state = null // null | "'" | '"' | '`' | 'line' | 'block'
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'line') {
      if (c === '\n') { state = null; i += 1; continue }
      out[i] = ' '; i += 1; continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = null; continue }
      if (c !== '\n') out[i] = ' '
      i += 1; continue
    }
    if (state === "'" || state === '"' || state === '`') {
      if (c === '\\') { i += 2; continue }
      if (c === state) state = null
      i += 1; continue
    }
    if (c === '/' && d === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
    if (c === '/' && d === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') { state = c; i += 1; continue }
    i += 1
  }
  return out.join('')
}

/**
 * 结构视图：把字符串/模板/正则字面量内容替换成空格（等长、保留换行）。
 * 括号配平、深度、实参切分都必须在它上面做——否则字面量里的 `(`、`,`、`{`
 * （尤其是正则里的 `[)`）会把深度算歪，检测器就会把嵌套函数里的代码当成顶层语句。
 */
function blankLiterals(code) {
  const out = code.split('')
  const n = code.length
  const tail = []
  const pushTail = (ch) => {
    if (!/\s/.test(ch)) { tail.push(ch); if (tail.length > 24) tail.shift() }
  }
  const REGEX_PREV = '(,=:[!&|?{};+-*%<>~^'
  const REGEX_KEYWORD = /(?:^|[^\w$])(return|typeof|case|in|of|delete|void|instanceof|do|else|yield|await|new)\s*$/
  let i = 0
  while (i < n) {
    const c = code[i]
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(code, i)
      for (let k = i; k < end; k += 1) if (out[k] !== '\n') out[k] = ' '
      pushTail('x')
      i = end
      continue
    }
    if (c === '/') {
      const before = tail.join('')
      const lastChar = before[before.length - 1] ?? ''
      const regexAllowed = lastChar === '' || REGEX_PREV.includes(lastChar) || REGEX_KEYWORD.test(before)
      if (regexAllowed) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < n) {
          const cj = code[j]
          if (cj === '\\') { j += 2; continue }
          if (cj === '\n') break
          if (cj === '[') inClass = true
          else if (cj === ']') inClass = false
          else if (cj === '/' && !inClass) { j += 1; closed = true; break }
          j += 1
        }
        if (closed) {
          while (j < n && /[a-z]/.test(code[j])) j += 1
          for (let k = i; k < j; k += 1) if (out[k] !== '\n') out[k] = ' '
          pushTail('x')
          i = j
          continue
        }
      }
    }
    pushTail(c)
    i += 1
  }
  return out.join('')
}

function lineStarts(text) {  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function position(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: index - starts[lo] + 1 }
}

/** 从 i（指向开括号）找到配对的闭括号索引；跳过字符串。 */
function findBalanced(text, i) {
  const open = text[i]
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  let j = i
  while (j < text.length) {
    const c = text[j]
    if (c === "'" || c === '"' || c === '`') { j = skipString(text, j); continue }
    if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return j
    }
    j += 1
  }
  return -1
}

function skipString(text, i) {
  const q = text[i]
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === q) return j + 1
    j += 1
  }
  return text.length
}

/** 取从 start（指向开括号）到配对闭括号之间的实参区间列表。 */
function argSpans(text, start) {
  const end = findBalanced(text, start)
  if (end < 0) return null
  const spans = []
  let from = start + 1
  let depth = 0
  for (let j = start + 1; j < end; j += 1) {
    const c = text[j]
    if (c === "'" || c === '"' || c === '`') { j = skipString(text, j) - 1; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ',' && depth === 0) { spans.push([from, j]); from = j + 1 }
  }
  if (text.slice(from, end).trim() !== '') spans.push([from, end])
  return { spans, end }
}

/** 计算 index 处的括号深度（跳过字符串）——用于只认"顶层语句"。 */
function depthAt(text, index) {
  let depth = 0
  for (let i = 0; i < index; i += 1) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i) - 1; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
  }
  return depth
}

/** 收集 `function NAME(...) {...}` 的范围，用来判断某次写盘属于哪个函数。 */
function functionRanges(code) {
  const ranges = []
  for (const match of code.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const parenIndex = match.index + match[0].length - 1
    const close = findBalanced(code, parenIndex)
    if (close < 0) continue
    let j = close + 1
    while (j < code.length && /\s/.test(code[j])) j += 1
    if (code[j] !== '{') continue
    const end = findBalanced(code, j)
    if (end < 0) continue
    ranges.push({ name: match[1], start: j, end })
  }
  return ranges
}

/** 在一段文本里找深度 0 的 `=>`。 */
function findArrow(text) {
  let depth = 0
  for (let i = 0; i < text.length - 1; i += 1) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i) - 1; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === '=' && text[i + 1] === '>' && depth === 0 && text[i - 1] !== '=' && text[i - 1] !== '!' && text[i - 1] !== '<') {
      return i
    }
  }
  return -1
}

/** 从函数体里取所有深度 0 的 return 后面的表达式文本。 */
function extractReturns(body) {
  const returns = []
  const text = body
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i) - 1; continue }
    if (c === '{' || c === '(' || c === '[') { depth += 1; continue }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; continue }
    if (depth !== 0) continue
    if (!text.startsWith('return', i)) continue
    const before = text[i - 1]
    const after = text[i + 6]
    if (before !== undefined && /[\w$]/.test(before)) continue
    if (after !== undefined && /[\w$]/.test(after)) continue
    let j = i + 6
    let d = 0
    while (j < text.length) {
      const cj = text[j]
      if (cj === "'" || cj === '"' || cj === '`') { j = skipString(text, j); continue }
      if (cj === '{' || cj === '(' || cj === '[') d += 1
      else if (cj === '}' || cj === ')' || cj === ']') {
        if (d === 0) break
        d -= 1
      } else if ((cj === ';' || cj === '\n') && d === 0) break
      j += 1
    }
    returns.push(text.slice(i + 6, j).trim())
    i = j - 1
  }
  return returns
}

/** 分析 mutate 实参：返回 { tagged, bare, returns, reason }。 */
function analyzeMutation(argText) {
  const text = argText.trim()
  if (text === '') return { tagged: false, bare: true, returns: [], reason: 'no-arg' }
  const arrow = findArrow(text)
  const isFunction = arrow >= 0 || /\bfunction\b/.test(text)
  if (!isFunction) return { tagged: false, bare: true, returns: [], reason: 'not-a-function' }

  const paramText = arrow >= 0 ? text.slice(0, arrow) : ''
  const currentName = (() => {
    const m = paramText.match(/\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*$/)
    return m ? m[1] : null
  })()

  let returns = []
  if (arrow >= 0) {
    const body = text.slice(arrow + 2).trim()
    if (body.startsWith('{') && findBalanced(body, 0) === body.length - 1) {
      returns = extractReturns(body.slice(1, -1))
    } else {
      returns = [body]
    }
  } else {
    const brace = text.indexOf('{')
    if (brace >= 0) returns = extractReturns(text.slice(brace + 1, findBalanced(text, brace)))
  }

  let tagged = false
  let bare = false
  for (const ret of returns) {
    if (ret === '' || ret === 'undefined') continue
    if (currentName !== null && ret === currentName) continue // 原样返回不变形状
    if (/(?:^|[{,(\[\s])["']?kind["']?\s*:/.test(ret)) { tagged = true; continue }
    if (/(?:^|[{,(\[\s])\.\.\.\s*[A-Za-z_$][\w$]*/.test(ret)) { tagged = true; continue } // spread 保留判别
    bare = true
  }
  return { tagged, bare, returns, reason: bare ? 'untagged' : 'ok' }
}

// ─────────────────────────────────────────── 规则表（与 docs/spec-matrix.md 一一对应）

/**
 * severity：A=可 brick 启动/数据凭据损坏；B=功能兼容偏离；C=体验展示。
 * gate：docs/09 的分层门。
 * source：官方出处（版本 0.2.2-rc.3）。
 */
const RULES = [
  { id: 'R-CRED-01', severity: 'A', domain: 'CRED', gate: 'G0/G1.5', title: 'modifyRecord 的写入值必须是带 kind 的记录' },
  { id: 'R-CRED-02', severity: 'A', domain: 'CRED', gate: 'G0/G1.5', title: '密钥只能经 credentials seam；禁写 profile/凭据文档' },
  { id: 'R-CRED-03', severity: 'A', domain: 'CRED', gate: 'G0', title: '记录 key 必须是 <scope>/<id>' },
  { id: 'R-CFG-01', severity: 'A', domain: 'CFG', gate: 'G0', title: '不得读写 profile 的 package.json / cordis.patch.yml' },
  { id: 'R-CFG-02', severity: 'A', domain: 'CFG', gate: 'G0', title: '密钥不进 Config 默认值 / bundle patch' },
  { id: 'R-BOOT-01', severity: 'A', domain: 'BOOT', gate: 'G1.5', title: '启动期不得写入未校验的持久化文档' },
  { id: 'R-BOOT-02', severity: 'A', domain: 'BOOT', gate: 'G1.5', title: 'apply 内异常不得逃逸' },
  { id: 'R-BOOT-04', severity: 'C', domain: 'BOOT', gate: 'G1.5', title: '启动路径函数里的写盘需人工复核（幂等迁移）' },
  { id: 'R-EVT-01', severity: 'A', domain: 'EVT', gate: 'G0', title: '不得 append 新的 session 事件类型' },
  { id: 'R-EVT-02', severity: 'A', domain: 'EVT', gate: 'G0', title: 'projection apply 必须同步纯、stateVersion 正确' },
  { id: 'R-SVC-01', severity: 'A', domain: 'SVC', gate: 'G0/G2', title: 'provide 的服务名/形状符合契约，且不抢占官方服务' },
  { id: 'R-SVC-02', severity: 'A', domain: 'SVC', gate: 'G0/G2', title: '可选服务必须 inject/ctx.inject' },
  { id: 'R-LDR-01', severity: 'A', domain: 'LDR', gate: 'G0', title: 'bundle patch 合法（存在/数组/条目有 insert 或 id）' },
  { id: 'R-LDR-02', severity: 'A', domain: 'LDR', gate: 'G0', title: 'patch 行 name 可解析、行 id 唯一' },
  { id: 'R-MCP-01', severity: 'A', domain: 'MCP', gate: 'G1', title: 'MCP 行字段完整且不含明文密钥' },
  { id: 'R-PKG-01', severity: 'A', domain: 'PKG', gate: 'G0/G1', title: '安装可达性：exports 指向真实文件、files 覆盖运行时文件' },
  { id: 'R-CRED-04', severity: 'B', domain: 'CRED', gate: 'G0', title: 'readRecord 后必须按 kind 取 payload' },
  { id: 'R-CRED-05', severity: 'C', domain: 'CRED', gate: '审计', title: '密钥落插件自有 state 文件：记录为 primary、mode 0600' },
  { id: 'R-CFG-03', severity: 'B', domain: 'CFG', gate: 'G0', title: '用户可调参数进 Config，不要持久化进插件 settings 段' },
  { id: 'R-EVT-03', severity: 'B', domain: 'EVT', gate: 'G0', title: 'session/event 监听里重扫 events；应改用 projections' },
  { id: 'R-EVT-04', severity: 'C', domain: 'EVT', gate: '审计', title: '订阅 session/event 维护派生状态（确认不是重扫）' },
  { id: 'R-UI-01', severity: 'B', domain: 'UI', gate: 'G0/G2', title: 'Client 半边不得加载 Harness Client 包' },
  { id: 'R-UI-02', severity: 'B', domain: 'UI', gate: 'G2', title: 'slot 贡献必须走 ctx.slots.inject' },
  { id: 'R-UI-04', severity: 'C', domain: 'UI', gate: 'G2', title: '不 append 第二份应用到 document.body、不替换 root' },
  { id: 'R-SVC-03', severity: 'B', domain: 'SVC', gate: 'G0', title: '裸 ctx.get(...) 之后不得直接调用成员' },
  { id: 'R-PKG-02', severity: 'B', domain: 'PKG', gate: 'G1', title: 'files 必须覆盖运行时模块' },
  { id: 'R-PKG-03', severity: 'C', domain: 'PKG', gate: '审计', title: 'package.json 没有 dsh 字段：不是 bundle' },
  { id: 'R-PKG-04', severity: 'A', domain: 'PKG', gate: 'G0/G1', title: 'Host 半边 import 的 @deepseek-ai 包必须声明 peerDependencies' },
]

const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]))

// ─────────────────────────────────────────── 文件级检查

const RUNTIME_SKIP = [
  /(^|\/)(test|tests|__tests__|fixtures?)\//,
  /(^|\/)verify-[^/]*\.(mjs|js)$/,
  /\.(test|spec)\.(mjs|js)$/,
  /(^|\/)scripts\//,
]

function isRuntimeFile(rel) {
  return !RUNTIME_SKIP.some((pattern) => pattern.test(rel))
}

function isClientFile(plugin, rel) {
  const clientExport = plugin.manifest.exports?.['./client']
  if (typeof clientExport === 'string' && path.normalize(clientExport).replace(/^\.\//, '') === rel) return true
  return /(^|\/)client\.js$/.test(rel) || /(^|\/)client\//.test(rel)
}

function writeApiRegex() {
  return /\b(writeFileSync|writeFile|writeJson|writeJsonAtomic|writeFileAtomic|writeFileAtomic0600|appendFileSync|appendFile|renameSync|rename|copyFileSync|copyFile|readFileSync|readFile)\s*\(/g
}

/**
 * 文件级规则：只依赖单个文件源码的检查。
 * @param {string} rel - 相对插件根的路径
 * @param {string} source - 源码
 * @param {{plugin: object, client: boolean, runtime: boolean}} info
 * @returns {Array<{rule, line, column, message, fix}>}
 */
function analyzeSource(rel, source, info) {
  const findings = []
  const code = stripComments(source)
  const shape = blankLiterals(code)
  const starts = lineStarts(source)
  const at = (index) => position(starts, index)
  const push = (rule, index, message, fix) => {
    const { line, column } = at(index)
    findings.push({ file: rel, line, column, rule, message, fix })
  }
  const fnRanges = functionRanges(shape)

  // ── R-CRED-01 / R-CRED-03：凭据记录写入形状与 key 语法
  const recordCalls = /\b(?:modifyRecord|deleteRecord|readRecord|describeRecord)\s*\(/g
  for (const match of shape.matchAll(recordCalls)) {
    const callIndex = match.index
    const parenIndex = callIndex + match[0].length - 1
    const args = argSpans(shape, parenIndex)
    if (args === null) continue
    const fnName = match[0].replace(/\s*\($/, '')
    const first = args.spans[0] === undefined ? '' : code.slice(args.spans[0][0], args.spans[0][1]).trim()

    // R-CRED-03：key 字面量必须是 <scope>/<id>
    const keyLiteral = first.match(/^['"`]([^'"`]+)['"`]$/)
    if (keyLiteral !== null) {
      const key = keyLiteral[1]
      if (!key.includes('/') && !key.includes('${')) {
        push('R-CRED-03', callIndex, `${fnName} 的 key "${key}" 不是 <scope>/<id> 形式`,
          '改成 `<插件注册名>/<id>`；scope 是注册名而不是包名')
      } else if (key.startsWith(`${info.plugin.manifest.name}/`)) {
        push('R-CRED-03', callIndex, `${fnName} 的 key 用了包名 "${info.plugin.manifest.name}" 作 scope`,
          'scope 必须是插件**注册名**（cordis.patch.yml 的 id），不是包名')
      }
    }

    if (fnName === 'modifyRecord') {
      const mutateSpan = args.spans[1]
      const verdict = analyzeMutation(mutateSpan === undefined ? '' : shape.slice(mutateSpan[0], mutateSpan[1]))
      if (verdict.reason === 'not-a-function') {
        push('R-CRED-01', callIndex, 'modifyRecord 的第二个实参必须是 mutate 函数',
          '写成 current => ({ ...current, payload }) 或 () => ({ kind: \'grant\', payload })')
      } else if (verdict.reason === 'no-arg') {
        push('R-CRED-01', callIndex, 'modifyRecord 缺少 mutate 实参',
          '写成 modifyRecord(key, current => ({ kind: \'grant\', payload }))')
      } else if (verdict.bare) {
        push('R-CRED-01', callIndex,
          `modifyRecord 的 mutate 返回了无判别对象的 ${verdict.returns
            .filter((text) => text !== '' && text !== 'undefined')
            .map((text) => text.slice(0, 60))
            .join(' | ')}`,
          '返回 { kind: \'grant\', payload } 或 { kind: \'api-key\', key/env }；返回 undefined 表示不改')
      }
    }
  }

  // ── R-CRED-04（B）：readRecord 的结果必须按 kind 判别后再取 payload
  {
    const enclosing = (index) => fnRanges
      .filter((range) => index > range.start && index < range.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
    const guardFor = (declIndex, useIndex) => {
      const enclosure = enclosing(declIndex)
      const from = enclosure === undefined ? 0 : enclosure.start
      return /\bkind\b/.test(shape.slice(from, useIndex))
    }
    for (const match of shape.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.readRecord\s*\(/g)) {
      const varName = match[1]
      const usageRe = new RegExp(`\\b${varName}\\s*\\.\\s*payload\\b`, 'g')
      for (const use of shape.matchAll(usageRe)) {
        if (guardFor(match.index, use.index)) continue
        push('R-CRED-04', use.index,
          `readRecord 的结果 ${varName}.payload 没有先判 kind === 'grant'`,
          "记录是带判别的联合：const payload = record?.kind === 'grant' ? record.payload : null")
      }
    }
    for (const match of shape.matchAll(/(?:const|let|var)\s*\{[^}]*\bpayload\b[^}]*\}\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.readRecord\s*\(/g)) {
      push('R-CRED-04', match.index, '解构 readRecord 的 payload，绕过了 kind 判别',
        "先取整条记录判 kind，再解构 grant 的 payload")
    }
  }

  // ── R-CRED-02 / R-CFG-01：profile 与凭据文档的直写/直读
  for (const match of shape.matchAll(writeApiRegex())) {
    const callIndex = match.index
    const parenIndex = callIndex + match[0].length - 1
    const args = argSpans(shape, parenIndex)
    if (args === null) continue
    const firstSpan = args.spans[0]
    const first = firstSpan === undefined ? '' : source.slice(firstSpan[0], firstSpan[1])
    const windowText = source.slice(callIndex, Math.min(source.length, callIndex + 320))
    const look = `${first}\n${windowText}`
    if (/\.credentials\.yaml/.test(look)) {
      push('R-CRED-02', callIndex, `${match[1]} 直接碰 .credentials.yaml（DSH 自己解析的凭据文档）`,
        '用 ctx.credentials.set/unset/modifyRecord；文档解析失败 = 启动失败')
    } else if (/cordis\.patch\.yml/.test(look)) {
      push('R-CFG-01', callIndex, `${match[1]} 直接碰 cordis.patch.yml（用户 profile 文件）`,
        '改自己的配置走 ctx.get(\'configEditor\').edit(entry, change)')
    } else if (/DSH_PROFILE_DIR|\brealpathSync\([^)]*profile|['"]profiles['"]|profiles\//.test(look)) {
      push('R-CFG-01', callIndex, `${match[1]} 访问了 profile 目录（${look.match(/DSH_PROFILE_DIR|profiles/)[0]}）`,
        '插件不得定位 profile；配置走 configEditor，状态走 storage/credentials seam')
    }
  }

  // ── R-CRED-05（C）：密钥落插件自有 state 文件
  for (const match of shape.matchAll(writeApiRegex())) {
    if (!/^(write|append)/.test(match[1])) continue
    const callIndex = match.index
    const parenIndex = callIndex + match[0].length - 1
    const args = argSpans(shape, parenIndex)
    if (args === null) continue
    const firstSpan = args.spans[0]
    const first = firstSpan === undefined ? '' : code.slice(firstSpan[0], firstSpan[1])
    if (!/(cred|token|secret|auth|passw)/i.test(first)) continue
    const hasMode = /0o?600|mode:\s*0o?600/.test(code.slice(callIndex, callIndex + 400))
    push('R-CRED-05', callIndex,
      `${match[1]} 把密钥类数据写进插件自有文件${hasMode ? '（调用点带 0600）' : ''}`,
      '优先 ctx.credentials.modifyRecord；必须留文件 fallback 时确保 mode 0600 且记录为 primary')
  }

  // ── R-CFG-02：Config 默认值里的明文密钥
  for (const match of code.matchAll(/(?:api[_-]?key|secret|password|token|clientSecret)\s*:\s*z\.[^,]*\.default\(\s*['"`]([^'"`]{8,})['"`]/gi)) {
    push('R-CFG-02', match.index, `Config 默认值里出现疑似明文密钥（${match[1].slice(0, 4)}…）`,
      '默认值留空；密钥走 ctx.credentials 的 ref 或 record')
  }
  for (const match of code.matchAll(/(?:apiKey|api_key|token|secret|password|clientSecret)\s*:\s*['"`](sk-[^'"`]+|ghp_[^'"`]+|[A-Za-z0-9_-]{24,})['"`]/g)) {
    push('R-CFG-02', match.index, '源码里出现疑似明文密钥字面量', '移入 credential store，配置只留引用名')
  }

  // ── R-EVT-01：自造 session 事件类型
  for (const match of shape.matchAll(/\.append\s*\(/g)) {
    const parenIndex = match.index + match[0].length - 1
    const args = argSpans(shape, parenIndex)
    if (args === null) continue
    const firstSpan = args.spans[0]
    if (firstSpan === undefined) continue
    const objectText = code.slice(firstSpan[0], firstSpan[1])
    if (!objectText.trim().startsWith('{')) continue
    const typeMatch = objectText.match(/(?:^|[{,\s])type\s*:\s*['"`]([^'"`]+)['"`]/)
    if (typeMatch !== null) {
      const { line } = at(match.index)
      findings.push({
        file: rel, line, column: 1, rule: 'R-EVT-01',
        message: `append() 写了事件类型 "${typeMatch[1]}"（自造类型）`,
        fix: 'live append 设不了 ignorable，未知类型会让 Session 拒绝重开；改从已有事件派生或用 storage',
      })
    }
  }
  for (const match of shape.matchAll(/\bappendPluginRecord\s*\(/g)) {
    push('R-EVT-01', match.index, 'appendPluginRecord 仅保留给 DSH 实验包', '改用 projections 或 storage service')
  }

  // ── R-EVT-02：projection 纯度
  for (const match of shape.matchAll(/sessionProjections\.register\s*\(/g)) {
    const parenIndex = match.index + match[0].length - 1
    const args = argSpans(shape, parenIndex)
    if (args === null) continue
    const firstSpan = args.spans[0]
    if (firstSpan === undefined) continue
    const definition = shape.slice(firstSpan[0], firstSpan[1])
    const applyMatch = definition.match(/\bapply\s*[:(]/)
    if (applyMatch === null) continue
    const applyIndex = firstSpan[0] + applyMatch.index
    const bodyStart = definition.indexOf('{', applyMatch.index)
    let body = definition
    if (bodyStart >= 0) {
      const close = findBalanced(definition, bodyStart)
      body = definition.slice(bodyStart, close < 0 ? definition.length : close + 1)
    }
    const bodyOffset = bodyStart >= 0 ? firstSpan[0] + bodyStart : applyIndex
    if (/\bawait\b/.test(body)) {
      const offset = bodyOffset + body.indexOf('await')
      push('R-EVT-02', offset, 'projection 的 apply 里出现 await（必须同步纯函数）',
        'apply 只做同步折叠；异步取数放到事件处理或 warmup')
    }
    if (/\b(Date\.now|new Date\s*\(|Math\.random)\b/.test(body)) {
      const offset = bodyOffset + body.search(/\b(Date\.now|new Date\s*\(|Math\.random)\b/)
      push('R-EVT-02', offset, 'projection 的 apply 里用了当前时间/随机数（不纯）',
        '时间戳从事件或 init(header) 取；同一事件必须折叠出同一状态')
    }
    if (!/\bstateVersion\s*:/.test(definition)) {
      push('R-EVT-02', firstSpan[0], 'projection 没有声明 stateVersion',
        '声明 stateVersion；字段/折叠语义变化时 +1，否则旧 checkpoint 会被复用')
    }
  }

  // ── R-EVT-03：订阅 session/event 重扫
  for (const match of code.matchAll(/\bon\s*\(\s*['"`]session\/event['"`]/g)) {
    const window = code.slice(match.index, match.index + 800)
    const rescans = /session\s*\.\s*events/.test(window) && !/payload/.test(window)
    if (rescans) {
      push('R-EVT-03', match.index, '监听 session/event 后重扫 session.events（绕过 projection 的增量机制）',
        '用 ctx.sessionProjections.register 派生状态；Client 用 wire.view')
    } else {
      push('R-EVT-04', match.index, '订阅 session/event 维护派生状态（未发现重扫 events）',
        '副作用用订阅可以；若这是"每会话派生状态"，改 projection 免得全量重放')
    }
  }

  // ── R-SVC-01：抢占官方服务 / 重复 provide
  const provided = new Map()
  for (const match of code.matchAll(/\bprovide\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    const name = match[1]
    if (OFFICIAL_SERVICES.has(name)) {
      push('R-SVC-01', match.index, `provide 了官方已占用的服务名 "${name}"`,
        '插件服务用自己的名字（如提供的能力名）；同名 provider 会让组合出现两个实例')
    }
    if (provided.has(name)) push('R-SVC-01', match.index, `同一文件重复 provide "${name}"`, '只留一处注册')
    provided.set(name, match.index)
  }

  // ── R-SVC-02：inject 声明与"可选处理"矛盾（静态可见部分）
  const injectDecl = code.match(/(?:export\s+const\s+inject|static\s+inject)\s*=\s*\[([^\]]*)\]/)
  if (injectDecl !== null) {
    const names = [...injectDecl[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const getRe = new RegExp(`\\bget\\s*\\(\\s*['"\`]${escaped}['"\`]\\s*\\)`, 'g')
      for (const getMatch of code.matchAll(getRe)) {
        push('R-SVC-02', getMatch.index,
          `"${name}" 写进了 inject（必需），但代码又用 ctx.get 按可选处理`,
          '可选依赖改成 ctx.inject([...], cb)；必需依赖则不要兜底')
      }
    }
  }

  // ── R-SVC-03：裸 ctx.get(...) 直接调用成员
  for (const match of code.matchAll(/\b(?:ctx|scope|app)\.get\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    push('R-SVC-03', match.index, `ctx.get('${match[1]}').${match[2]}() 没有判空（服务可能不存在）`,
      '先取到变量判空，或用 ctx.inject 保证激活顺序')
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.get\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*;?\s*\1\./g)) {
    push('R-SVC-03', match.index, `ctx.get('${match[2]}') 的返回值立即被解引用`, '判空后再用')
  }

  // ── R-BOOT-01 / R-BOOT-02：启动期写入与异常
  const applyMatch = code.match(/export\s+(?:async\s+)?function\s+apply\s*\([^)]*\)\s*\{/)
  if (applyMatch !== null) {
    const bodyStart = applyMatch.index + applyMatch[0].length - 1
    const bodyEnd = findBalanced(shape, bodyStart)
    const body = bodyEnd < 0 ? shape.slice(bodyStart) : shape.slice(bodyStart, bodyEnd + 1)
    const tryRanges = []
    for (const tryMatch of body.matchAll(/\btry\s*\{/g)) {
      const open = tryMatch.index + tryMatch[0].length - 1
      const close = findBalanced(body, open)
      if (close >= 0) tryRanges.push([open, close])
    }
    const inTry = (offset) => tryRanges.some(([from, to]) => offset >= from && offset <= to)

    // 只认 apply 体内的**顶层语句**（深度 1 = body[0] 的 `{` 里面一层）：
    // 嵌在内部函数/回调里的 throw 与写盘不是 boot 期行为，误报会毁掉整个门。
    const topLevel = (offset) => depthAt(body, offset) === 1

    for (const match of body.matchAll(/\b(modifyRecord|writeJson|writeFileAtomic|writeFileSync|writeFile|appendFile|appendFileSync)\s*\(/g)) {
      if (!topLevel(match.index) || inTry(match.index)) continue
      const absolute = bodyStart + match.index
      push('R-BOOT-01', absolute, `apply 顶层直接调用 ${match[1]}（boot 会解析落盘结果）`,
        '迁移/写入必须"先校验后落盘"且包在 try 里；写失败不得让整行 fatal')
    }
    for (const match of body.matchAll(/\bthrow\b/g)) {
      if (!topLevel(match.index) || inTry(match.index)) continue
      push('R-BOOT-02', bodyStart + match.index, 'apply 内顶层 throw（必需行失败 → host 拒绝启动）',
        '改成 log + 保持 inactive，或把失败暴露在状态/工具结果里')
    }
    for (const match of body.matchAll(/\(\s*async\s*\(\s*\)\s*=>/g)) {
      if (!topLevel(match.index) || inTry(match.index)) continue
      const near = body.slice(match.index, match.index + 600)
      if (!/\.catch\s*\(/.test(near) && !/\btry\b/.test(near)) {
        push('R-BOOT-02', bodyStart + match.index, 'apply 里 fire-and-forget 的 async IIFE 没有 catch',
          '加 .catch(error => log(...))；否则 rejection 会变成未处理错误')
      }
    }

    // ── R-BOOT-04（C）：apply 直接调用的本文件函数里也有写盘 → 启动期写入，人工复核。
    // 注意区分"调用"与"声明/方法定义"：`function saveJobsNow() {` 也匹配 NAME(，
    // 不排除它就会把每个 apply 内声明的函数都报成启动期写盘。
    const topLevelCalls = new Set()
    for (const call of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (depthAt(body, call.index) !== 1) continue
      const before = body.slice(Math.max(0, call.index - 24), call.index)
      if (/(?:function|async)\s+$/.test(before)) continue
      if (/(?:const|let|var)\s+$/.test(before)) continue
      topLevelCalls.add(call[1])
    }
    const ranges = fnRanges
    for (const match of shape.matchAll(/\b(modifyRecord|writeJson|writeJsonAtomic|writeFileAtomic|writeFileSync|writeFile)\s*\(/g)) {
      const enclosure = ranges
        .filter((range) => match.index > range.start && match.index < range.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
      if (enclosure === undefined) continue
      if (!topLevelCalls.has(enclosure.name)) continue
      push('R-BOOT-04', match.index, `启动期会走到 ${enclosure.name}()，其中调用了 ${match[1]}（人工复核：写前校验/失败降级）`,
        '启动路径的写盘应是幂等迁移；先校验已有文档再写，失败只 log 不抛')
    }
  }

  // ── UI 规则（只看 client 半边）
  if (info.client) {
    for (const match of code.matchAll(/require\s*\(\s*['"`](@deepseek-ai\/dsh-client[^'"`]*)['"`]\s*\)/g)) {
      push('R-UI-01', match.index, `client 半边加载了 Harness Client 包 "${match[1]}"`,
        '自己写控件（抄宿主 markup/CSS）；dsh.client.inject 只排序，可以留')
    }
    for (const match of code.matchAll(/\bfrom\s+['"`](@deepseek-ai\/dsh-client[^'"`]*)['"`]/g)) {
      push('R-UI-01', match.index, `client 半边 import 了 Harness Client 包 "${match[1]}"`, '同上：写自己的控件')
    }
    if (/slots\.register\s*\(/.test(code) && !/slots\.inject\s*\(/.test(code)) {
      const index = code.search(/slots\.register\s*\(/)
      push('R-UI-02', index, 'slots.register 不在 ctx.slots.inject 内（注入容器收起时不会被清理）',
        'ctx.slots.inject(ownerKey, () => ctx.slots.register(...))')
    }
    for (const match of code.matchAll(/\bdocument\s*\.\s*body\b/g)) {
      const around = code.slice(Math.max(0, match.index - 400), match.index + 240)
      const portal = /createPortal\s*\(/.test(around)
      push('R-UI-04', match.index,
        portal ? 'client 半边把浮层 portal 到 document.body（确认只是浮层，不是第二份应用）' : 'client 半边直接操作 document.body',
        '优先用 slot 分配的空间；宿主题/布局由宿主负责，不接管 body')
    }
  }

  return findings
}

// ─────────────────────────────────────────── 插件级检查（manifest / patch）

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/^\.\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * 简化 patch 行解析：按顶层 `- ` 分块，块内找 id/name，并保留**行号**。
 * 只做结构启发式；YAML 的深度解析仍由 check-plugins.sh（PyYAML）负责。
 */
function parsePatchRows(text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let current = null
  lines.forEach((line, index) => {
    if (/^- /.test(line)) {
      current = { headerLine: index + 1, body: [] }
      blocks.push(current)
    }
    if (current !== null) current.body.push({ text: line, line: index + 1 })
  })
  return blocks.map((block) => {
    const bodyText = block.body.map((entry) => entry.text).join('\n')
    const ids = []
    const names = []
    for (const entry of block.body) {
      const idMatch = entry.text.match(/^\s*-?\s*id\s*:\s*['"]?([^'"\s]+)['"]?\s*$/)
      if (idMatch !== null) ids.push({ value: idMatch[1], line: entry.line })
      const nameMatch = entry.text.match(/^\s*-?\s*name\s*:\s*['"]?([^'"\s]+)['"]?\s*$/)
      if (nameMatch !== null) names.push({ value: nameMatch[1], line: entry.line })
    }
    return {
      headerLine: block.headerLine,
      body: bodyText,
      hasInsert: /\binsert\s*:/.test(block.body[0].text),
      hasId: /\bid\s*:/.test(block.body[0].text),
      ids,
      names,
    }
  })
}

function analyzePlugin(plugin) {
  const findings = []
  const push = (rule, file, line, message, fix) => findings.push({ rule, file, line, column: 1, message, fix })

  const { manifest, dir, dirName } = plugin
  const name = typeof manifest.name === 'string' ? manifest.name : ''
  const patchRel = manifest.dsh?.bundle?.patch
  const looksLikeBundle = manifest.dsh !== undefined && manifest.dsh !== null
    && typeof manifest.dsh === 'object' && Object.keys(manifest.dsh).length > 0
  if (!looksLikeBundle) {
    // 探测脚本 / 工具包（例如 wechat-probe）不是 bundle：不套 bundle 规则，只留一条提示。
    push('R-PKG-03', 'package.json', 1, 'package.json 没有 dsh 字段：这不是一个 DSH bundle（跳过后面的 bundle 规则）',
      '若它确实是要安装的插件，补 dsh.bundle.patch；否则把它排除在插件审计范围外')
  } else if (typeof patchRel !== 'string' || patchRel === '') {
    push('R-LDR-01', 'package.json', 1, '缺少 dsh.bundle.patch（Loader 不会把这个包当 bundle 装载）',
      'package.json 加 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }')
  } else {
    const patchPath = path.join(dir, patchRel)
    const patchText = readText(patchPath)
    if (patchText === null) {
      push('R-LDR-01', 'package.json', 1, `dsh.bundle.patch 指向的文件不存在: ${patchRel}`, '补文件或改路径')
    } else {
      plugin.patchText = patchText
      const trimmed = patchText.trimStart()
      if (trimmed.startsWith('{')) {
        push('R-LDR-01', patchRel, 1, 'patch 顶层是映射，Loader 期望数组', '顶层写成 `- insert: [...]` 列表')
      }
      const rows = parsePatchRows(patchText)
      if (rows.length === 0 && trimmed !== '') {
        push('R-LDR-01', patchRel, 1, 'patch 里没有任何 `- ` 条目', '每层条目以 `- ` 开头')
      }
      rows.forEach((row) => {
        if (!row.hasInsert && !row.hasId) {
          push('R-LDR-01', patchRel, row.headerLine, '条目既没有 insert 也没有 id（Loader 会警告并跳过）',
            '插入用 `- insert: [...]`；覆盖已有行用 `- id: <rowId>` + 要覆盖的字段')
        }
      })

      // ── R-LDR-02：行 name 可解析 + id 唯一
      const seenIds = new Map()
      rows.forEach((row) => {
        for (const id of row.ids) {
          if (seenIds.has(id.value)) {
            push('R-LDR-02', patchRel, id.line, `行 id "${id.value}" 在 patch 里重复`, '行 id 必须唯一')
          }
          seenIds.set(id.value, true)
        }
        for (const rowName of row.names) {
          const patchName = rowName.value
          if (name !== '' && patchName === name) continue
          if (name !== '' && patchName.startsWith(`${name}/`)) {
            const subpath = `.${patchName.slice(name.length)}`
            if (!exportsHas(manifest.exports, subpath)) {
              push('R-LDR-02', patchRel, rowName.line, `patch 行 name "${patchName}" 在 exports 里没有对应子路径 ${subpath}`,
                `在 package.json exports 里加 "${subpath}"，或改行 name`)
            }
            continue
          }
          if (patchName.startsWith('.')) continue // 相对 patch 文件的路径行
          if (resolvableFromInstall(patchName) === false) {
            push('R-LDR-02', patchRel, rowName.line, `patch 行 name "${patchName}" 在安装版里解析不到`,
              '检查包名拼写；本地包用 @local/...，官方包用 @deepseek-ai/...')
          }
        }
      })

      // ── R-MCP-01：mcp-client 行
      const mcpRows = rows.filter((row) => row.names.some((rowName) => rowName.value === '@deepseek-ai/dsh-mcp-client'))
      for (const row of mcpRows) {
        const line = row.names.find((rowName) => rowName.value === '@deepseek-ai/dsh-mcp-client').line
        const body = row.body
        if (!/\bserverName\s*:/.test(body)) push('R-MCP-01', patchRel, line || 1, 'mcp-client 行缺 serverName', '加 config.serverName')
        if (!/\btransport\s*:/.test(body)) push('R-MCP-01', patchRel, line || 1, 'mcp-client 行缺 transport', 'transport: streamable-http | stdio')
        if (!/\b(url|command)\s*:/.test(body)) push('R-MCP-01', patchRel, line || 1, 'mcp-client 行缺 url/command', 'streamable-http 要 url；stdio 要 command')
        if (!/\bfailOnStartupError\s*:\s*(true|false|!!js)/.test(body)) {
          push('R-MCP-01', patchRel, line || 1, 'mcp-client 行没有显式 failOnStartupError', '按"必需/可选"显式写 true 或 false')
        }
      }
      const secret = patchText.match(/(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/)
      if (secret !== null) {
        const line = patchText.slice(0, secret.index).split(/\r?\n/).length
        push('R-MCP-01', patchRel, line, 'patch 里出现明文密钥/Bearer token', '用 ${credential:REF} + expandTemplates: true，或 !!js 引用')
      }
    }
  }

  // ── R-PKG-04：Host 半边 import 的 @deepseek-ai 包必须声明 peerDependencies
  // （link 安装时从 dsh 安装目录解析；漏声明 = install_bundle failed / ERR_MODULE_NOT_FOUND，
  //   重启也救不回——见 ~/.dsh/AGENTS.md 误报清单第 1 条）
  {
    const declared = new Set([
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.dependencies ?? {}),
    ])
    const hostSources = plugin.sources.filter(({ rel }) => !plugin.clientFiles.has(rel) && isRuntimeFile(rel))
    const reported = new Set()
    for (const { rel, source } of hostSources) {
      const code = stripComments(source)
      for (const match of code.matchAll(/(?:from\s+|require\s*\(\s*|import\s+)['"](@deepseek-ai\/[^'"\/]+(?:\/[^'"]*)?)['"]/g)) {
        const full = match[1]
        const pkgName = full.startsWith('@') ? full.split('/').slice(0, 2).join('/') : full
        if (declared.has(pkgName)) continue
        const key = `${rel}|${pkgName}`
        if (reported.has(key)) continue
        reported.add(key)
        const line = source.slice(0, match.index).split(/\r?\n/).length
        push('R-PKG-04', rel, line, `Host 半边 import 了 ${pkgName}，但 package.json 没有声明 peerDependencies`,
          `peerDependencies 加 "${pkgName}"；dsh 自带包从安装目录解析，写 dependencies 会在 profile 里装错版本`)
      }
    }
  }

  // ── R-PKG-01：exports 目标存在 + files 覆盖
  const exportsMap = manifest.exports
  if (exportsMap !== undefined && typeof exportsMap === 'object') {
    for (const [key, target] of Object.entries(exportsMap)) {
      if (key === './package.json') continue
      const targets = typeof target === 'string' ? [target] : []
      for (const t of targets) {
        if (t.includes('*')) continue // 通配目标由 audit-plugin-presentation / npm pack 校验
        if (!fs.existsSync(path.join(dir, t))) {
          push('R-PKG-01', 'package.json', 1, `exports["${key}"] 指向的文件不存在: ${t}`, '改成真实路径；解析失败发生在安装/启动时')
        }
      }
    }
  }
  const files = Array.isArray(manifest.files) ? manifest.files : null
  if (files !== null) {
    const runtimeTargets = []
    if (typeof exportsMap === 'object' && exportsMap !== null) {
      for (const [key, target] of Object.entries(exportsMap)) {
        if (key === './package.json' || typeof target !== 'string') continue
        if (target.includes('*')) continue
        runtimeTargets.push(target.replace(/^\.\//, ''))
      }
    }
    const patterns = files.map(globToRegExp)
    const covered = (rel) => {
      if (patterns.some((re) => re.test(rel))) return true
      // `files: ["src/overlay/"]` 这类目录项覆盖其下所有文件（npm 的实际语义）
      return files.some((pattern) => {
        const clean = pattern.replace(/^\.\//, '')
        if (clean.endsWith('/')) return rel.startsWith(clean) || rel === clean.slice(0, -1)
        if (!clean.includes('*')) return rel === clean || rel.startsWith(`${clean}/`)
        return false
      })
    }
    for (const target of runtimeTargets) {
      if (!covered(target)) {
        push('R-PKG-02', 'package.json', 1, `files 没有覆盖运行时文件 ${target}（npm pack 后会缺模块）`,
          '在 files 里加 `lib/*.js` 或对应文件')
      }
    }
  }
  return findings
}


function exportsHas(exportsMap, subpath) {
  if (exportsMap === undefined || exportsMap === null) return false
  if (typeof exportsMap === 'string') return subpath === '.'
  if (Object.hasOwn(exportsMap, subpath)) return true
  for (const key of Object.keys(exportsMap)) {
    if (!key.includes('*')) continue
    const re = new RegExp(`^${key.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    if (re.test(subpath)) return true
  }
  return false
}

const resolveCache = new Map()
/**
 * 判断 patch 行的包名能否从安装版解析。
 * 普通 Node 读不了 app.asar，所以借 DSH_NODE_EXECUTABLE（Electron 的 asar-aware fs）；
 * 拿不到运行时或锚点就返回 null（未知），**不**当成通过——避免"假绿"。
 * @returns {boolean|null}
 */
function resolvableFromInstall(specifier) {
  if (resolveCache.has(specifier)) return resolveCache.get(specifier)
  const anchor = process.env.DSH_INSTALL_DIR ?? ''
  const runtime = process.env.DSH_NODE_EXECUTABLE ?? ''
  if (!anchor || !runtime) { resolveCache.set(specifier, null); return null }
  let verdict = null
  try {
    execFileSync(runtime, ['-e', `require.resolve(${JSON.stringify(specifier)}, { paths: [${JSON.stringify(anchor)}] })`], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    verdict = true
  } catch {
    verdict = false
  }
  resolveCache.set(specifier, verdict)
  return verdict
}

// ─────────────────────────────────────────── 装载与遍历

function walk(dir, base = dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, base, out)
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(path.relative(base, abs))
  }
  return out
}

function loadPlugin(dir) {
  const manifestPath = path.join(dir, 'package.json')
  const text = readText(manifestPath)
  if (text === null) return null
  let manifest
  try { manifest = JSON.parse(text) } catch { return null }
  const files = walk(dir)
  const plugin = {
    dir,
    dirName: path.basename(dir),
    manifest,
    files,
    sources: files.map((rel) => ({ rel, source: readText(path.join(dir, rel)) ?? '' })),
  }
  plugin.clientFiles = new Set(files.filter((rel) => isClientFile(plugin, rel)))
  return plugin
}

function auditPlugin(plugin) {
  const findings = []
  findings.push(...analyzePlugin(plugin))
  for (const { rel, source } of plugin.sources) {
    const runtime = isRuntimeFile(rel)
    if (!runtime) continue
    const fileFindings = analyzeSource(rel, source, { plugin, client: plugin.clientFiles.has(rel), runtime })
    for (const finding of fileFindings) {
      finding.file = `${plugin.dirName}/${rel}`
      finding.plugin = plugin.dirName
      findings.push(finding)
    }
  }
  // 同一行同一规则只留一条（例如 `record.payload && typeof record.payload` 会命中多次）
  const seen = new Set()
  return findings.filter((finding) => {
    const key = `${finding.rule}|${finding.file}|${finding.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─────────────────────────────────────────── 输出

function formatFinding(finding) {
  const rule = RULE_BY_ID.get(finding.rule)
  const severity = rule === undefined ? '?' : rule.severity
  return `   ${severity}  ${finding.rule}  ${finding.file}:${finding.line}  ${finding.message}\n        修复：${finding.fix}`
}

function summarize(findings) {
  const counts = { A: 0, B: 0, C: 0 }
  for (const finding of findings) {
    const rule = RULE_BY_ID.get(finding.rule)
    if (rule !== undefined) counts[rule.severity] += 1
  }
  return counts
}

function parseArgs(argv) {
  const options = { roots: [], dirs: [], strict: false, json: false, listRules: false, selfTest: false, quiet: false, failOn: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--strict') options.strict = true
    else if (arg === '--json') options.json = true
    else if (arg === '--list-rules') options.listRules = true
    else if (arg === '--self-test') options.selfTest = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root' || arg === '--dir' || arg === '--fail-on') {
      const value = argv[++i]
      if (value === undefined) { console.error(`${arg} 需要一个值`); options.help = true; continue }
      if (arg === '--root') options.roots.push(path.resolve(value))
      else if (arg === '--dir') options.dirs.push(path.resolve(value))
      else options.failOn = value.toLowerCase().split(',').map((s) => s.trim().toUpperCase())
    }
    else if (arg.startsWith('--root=')) options.roots.push(path.resolve(arg.slice(7)))
    else if (arg.startsWith('--dir=')) options.dirs.push(path.resolve(arg.slice(6)))
    else if (arg.startsWith('--fail-on=')) options.failOn = arg.slice(10).toLowerCase().split(',').map((s) => s.trim().toUpperCase())
    else { console.error(`未知参数：${arg}`); options.help = true }
  }
  return options
}

function printHelp() {
  console.log(`check-plugin-compliance —— DSH 插件规范符合性只读检查（docs/spec-matrix.md）

用法：
  node scripts/check-plugin-compliance.mjs [选项]

选项：
  --root <dir>        审计一个根（子目录逐个当插件；根本身是插件则只审它），可重复。默认 plugins/
  --dir <dir>         审计单个插件目录，可重复
  --strict            等价于 --fail-on a,b（发布前用）
  --fail-on a,b,c     自定义阻断级别，默认 a
  --json              机器可读输出
  --quiet             只打印问题与汇总
  --list-rules        打印规则表
  --self-test         回归用例（旧 dsh-channels 必须报 R-CRED-01、当前代码必须干净）

退出码：0 干净；1 阈值以上有违规；2 用法/IO 错误。`)
}

/** 自检：内存 fixture + git 历史版本 + 当前工作树。 */
function runSelfTest() {
  const checks = []
  const check = (label, ok, detail) => checks.push({ label, ok, detail })

  const badFixture = readText(path.join(FIXTURES, 'credential-bare-record.js'))
  const goodFixture = readText(path.join(FIXTURES, 'credential-tagged-record.js'))
  check('fixture: 存在 scripts/fixtures/compliance/*.js', badFixture !== null && goodFixture !== null)

  if (badFixture !== null) {
    const plugin = { dirName: 'fixture', dir: FIXTURES, manifest: { name: '@local/fixture', exports: { '.': './index.js' } }, sources: [], clientFiles: new Set() }
    const found = analyzeSource('credential-bare-record.js', badFixture, { plugin, client: false, runtime: true })
    const rule1 = found.find((f) => f.rule === 'R-CRED-01')
    check('fixture 反例触发 R-CRED-01（A）', rule1 !== undefined, rule1 === undefined ? '没有报出来' : `第 ${rule1.line} 行：${rule1.message}`)
  }
  if (goodFixture !== null) {
    const plugin = { dirName: 'fixture', dir: FIXTURES, manifest: { name: '@local/fixture', exports: { '.': './index.js' } }, sources: [], clientFiles: new Set() }
    const found = analyzeSource('credential-tagged-record.js', goodFixture, { plugin, client: false, runtime: true })
    const rule1 = found.find((f) => f.rule === 'R-CRED-01')
    check('fixture 正例不触发 R-CRED-01', rule1 === undefined, rule1 === undefined ? '通过' : `误报：${rule1.message}`)
  }

  // 历史回归：引入事故的提交（6f349a3）必须报，修好后的工作树必须干净。
  // 注意：坏代码就在 6f349a3 里，不是 6f349a3^（handoff 里的 ^ 是 off-by-one，见 notes）。
  const gitOld = readGitFile('6f349a3:plugins/dsh-channels/index.js')
  if (gitOld === null) {
    check('git 回归：6f349a3:plugins/dsh-channels/index.js', true, 'SKIP（无 git 历史，用 fixture 兜底）')
  } else {
    const plugin = { dirName: 'dsh-channels@6f349a3', dir: path.join(REPO, 'plugins', 'dsh-channels'), manifest: { name: '@local/dsh-channels', exports: { '.': './index.js' } }, sources: [], clientFiles: new Set() }
    const found = analyzeSource('index.js', gitOld, { plugin, client: false, runtime: true })
    const rule1 = found.filter((f) => f.rule === 'R-CRED-01')
    check('git 回归：旧版必须报 R-CRED-01（≥2 处裸对象）', rule1.length >= 2,
      rule1.length === 0 ? '没有报出来' : rule1.map((f) => `L${f.line}`).join(', '))
  }

  const currentPath = path.join(REPO, 'plugins', 'dsh-channels', 'index.js')
  const current = readText(currentPath)
  if (current !== null) {
    const plugin = { dirName: 'dsh-channels', dir: path.dirname(currentPath), manifest: { name: '@local/dsh-channels', exports: { '.': './index.js' } }, sources: [], clientFiles: new Set() }
    const found = analyzeSource('index.js', current, { plugin, client: false, runtime: true })
    const rule1 = found.filter((f) => f.rule === 'R-CRED-01')
    check('git 回归：当前 dsh-channels 必须干净（R-CRED-01）', rule1.length === 0,
      rule1.length === 0 ? '通过' : rule1.map((f) => `L${f.line}: ${f.message}`).join('; '))
  }

  let failed = 0
  for (const item of checks) {
    console.log(`${item.ok ? '✓' : '✗'} ${item.label}${item.detail ? `  —  ${item.detail}` : ''}`)
    if (!item.ok) failed += 1
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`)
  return failed === 0 ? 0 : 1
}

function readGitFile(spec) {
  try {
    return execFileSync('git', ['-C', REPO, 'show', spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function collectPluginDirs(options) {
  const dirs = []
  const roots = options.roots.length > 0
    ? options.roots
    : (options.dirs.length > 0 ? [] : [path.join(REPO, 'plugins')])
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      console.error(`目录不存在：${root}`)
      process.exit(2)
    }
    if (fs.existsSync(path.join(root, 'package.json'))) {
      dirs.push(root)
      continue
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (fs.existsSync(path.join(root, entry.name, 'package.json'))) dirs.push(path.join(root, entry.name))
    }
  }
  for (const dir of options.dirs) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      console.error(`不是插件目录（缺 package.json）：${dir}`)
      process.exit(2)
    }
    dirs.push(dir)
  }
  return [...new Set(dirs)]
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { printHelp(); return 0 }
  if (options.listRules) {
    console.log('ID            级别  门       规则')
    for (const rule of RULES) console.log(`${rule.id.padEnd(13)} ${rule.severity.padEnd(4)}  ${rule.gate.padEnd(8)} ${rule.title}`)
    return 0
  }
  if (options.selfTest) return runSelfTest()

  const dirs = collectPluginDirs(options)
  if (dirs.length === 0) {
    console.error('没有找到任何插件目录')
    return 2
  }

  const plugins = []
  const allFindings = []
  for (const dir of dirs) {
    const plugin = loadPlugin(dir)
    if (plugin === null) continue
    const exempt = EXEMPT[plugin.dirName]
    if (exempt !== undefined) {
      if (!options.json && !options.quiet) console.log(`– ${plugin.dirName}：豁免（${exempt}）`)
      continue
    }
    const findings = auditPlugin(plugin)
    plugins.push({ plugin, findings })
    allFindings.push(...findings)
    if (!options.json && !options.quiet) {
      const counts = summarize(findings)
      const label = findings.length === 0 ? '✓' : `A${counts.A} B${counts.B} C${counts.C}`
      console.log(`── ${plugin.dirName}  (${plugin.manifest.name ?? '?'})  ${label}`)
      for (const finding of findings) console.log(formatFinding(finding))
      if (findings.length > 0) console.log('')
    }
  }

  const counts = summarize(allFindings)
  const failOn = options.failOn ?? (options.strict ? ['A', 'B'] : ['A'])
  const blocking = allFindings.filter((finding) => {
    const rule = RULE_BY_ID.get(finding.rule)
    return rule !== undefined && failOn.includes(rule.severity)
  })

  if (options.json) {
    console.log(JSON.stringify({
      plugins: plugins.map(({ plugin, findings }) => ({
        name: plugin.manifest.name,
        dir: plugin.dir,
        dirName: plugin.dirName,
        files: plugin.files.length,
        findings: findings.map((finding) => ({
          rule: finding.rule,
          severity: RULE_BY_ID.get(finding.rule)?.severity,
          file: finding.file,
          line: finding.line,
          message: finding.message,
          fix: finding.fix,
        })),
      })),
      summary: { plugins: plugins.length, ...counts, failOn, blocking: blocking.length },
    }, null, 2))
  } else {
    if (options.quiet) {
      for (const finding of allFindings) console.log(formatFinding(finding))
    }
    console.log('──────────────────────────────────────────────')
    console.log(`插件 ${plugins.length} 个；违规 A=${counts.A} B=${counts.B} C=${counts.C}；阻断级别 ${failOn.join(',')} → ${blocking.length} 条`)
    if (blocking.length > 0) {
      const byRule = new Map()
      for (const finding of blocking) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1)
      console.log('阻断项：' + [...byRule.entries()].map(([rule, n]) => `${rule}×${n}`).join(', '))
    }
    console.log('规则表：node scripts/check-plugin-compliance.mjs --list-rules；矩阵：docs/spec-matrix.md')
  }
  return blocking.length === 0 ? 0 : 1
}

process.exitCode = main()
