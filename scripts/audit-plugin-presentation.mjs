#!/usr/bin/env node
/**
 * audit-plugin-presentation.mjs —— 只读审计插件的"命名 + 展示元数据 + 图标"是否符合
 * `docs/08-插件命名与展示规范.md`。
 *
 * 为什么要这个脚本：Plugins 页的标题/描述/图标与 tool-search 的按需组名，过去是
 * 各写各的（同一个 dsh-workbench 插件，页面叫「Workbench Manager」、按需组叫
 * `dsh-ops`、目录又只叫 `dsh-workbench`）。规范落到代码后，靠这个脚本做**单一闸门**：
 * check-plugins.sh 会跑它，不合规就红。
 *
 * 检查项：
 *   1. manifest：`@local/dsh-*` 命名、description、`icon`、`files`、`exports`
 *      （`./package.json` + `./locale/*.json`）、`dsh.bundle.patch`；
 *   2. locale：`locale/en.json` / `locale/zh.json` 均有非空 `meta.title` /
 *      `meta.description`，标题与 docs/08 §2 的 canonical 值一致；
 *   3. 图标：36×36 透明底、glyph-only（无满版底板）、渐变主形、无 `currentColor`、渐变引用可解析、
 *      颜色限调色板、≤256 KiB；
 *   4. 按需组：dsh-agentic-tool-catalog v2 起组 id 由分组策略自动推导（rules）；源码里只允许
 *      "平台回退表" LEGACY_GROUPS（v1 兼容）与策略集合，不允许策略代码引用具体插件组 id，
 *      已废止的旧组 id 必须消失（堵住 `dsh-ops` 复活）；
 *   5. 组件（Loader 行）：行 id 必须等于 docs/08 §3 的 canonical 值（kebab、不带 `dsh-`
 *      前缀、同 profile 唯一），`@deepseek-ai/dsh-mcp-client` 行必须 `mcp-<config.serverName>`。
 *
 * 用法：
 *   node scripts/audit-plugin-presentation.mjs                  # 表格 + 问题清单
 *   node scripts/audit-plugin-presentation.mjs --markdown       # 供文档/notes 引用
 *   node scripts/audit-plugin-presentation.mjs --json           # 机器可读
 *   node scripts/audit-plugin-presentation.mjs --root <dir>     # 额外插件根（可重复）
 *
 * 退出码：0 全部合规（豁免项除外）；1 有违规。
 *
 * @module audit-plugin-presentation
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** 图标调色板：主形蓝渐变两端 + 强调色 + 白色细节。 */
const PALETTE = ['#7CB7FF', '#145AF3', '#45D9E7', '#F2AF63', '#A23AE7', '#FFFFFF']

/**
 * 豁免：不是产品插件、不参与展示规范检查。
 * @type {Record<string, string>}
 */
const EXEMPT = {
  'hello-dsh': '官方起点模板抄本，不是产品插件',
}

/**
 * Canonical 身份表 —— 真源是 `docs/08-插件命名与展示规范.md` §2。
 * 改这里之前先改文档；新增插件先加一行再动手。
 *
 * `group` 为 null 表示该插件不贡献 tool-search 按需组；
 * `rowIds` 是该 bundle 的 patch 应插入的 Loader 行 id（组件 id）集合。
 * 规则：默认 = 包名去掉 `@local/` 与 `dsh-` 前缀；MCP 行 = `mcp-<config.serverName>`；
 * 只有 profile 层覆盖引用到的行允许保留语义化例外（当前无例外）。
 * @type {Array<{
 *   slug: string, pkg: string, titleEn: string, titleZh: string,
 *   group: string | null, rowIds: string[], legacyPkg?: boolean,
 * }>}
 */
const CANONICAL = [
  {
    slug: 'dsh-attention-center',
    pkg: '@local/dsh-attention-center',
    titleEn: 'Attention Center',
    titleZh: '注意力中心',
    group: null,
    rowIds: ['attention-center'],
  },
  {
    slug: 'dsh-balance-hud',
    pkg: '@local/dsh-balance-hud',
    titleEn: 'Balance HUD',
    titleZh: '余额常驻',
    group: null,
    rowIds: ['balance-hud'],
  },
  {
    slug: 'dsh-insights',
    pkg: '@local/dsh-insights',
    titleEn: 'Insights',
    titleZh: '洞察',
    group: null,
    rowIds: ['insights'],
  },
  {
    slug: 'dsh-privacy-guard',
    pkg: '@local/dsh-privacy-guard',
    titleEn: 'Privacy Guard',
    titleZh: '隐私护栏',
    group: null,
    rowIds: ['privacy-guard'],
  },
  {
    slug: 'dsh-google-workspace',
    pkg: '@local/dsh-google-workspace',
    titleEn: 'Google Workspace',
    titleZh: 'Google Workspace',
    group: null,
    rowIds: ['google-workspace'],
    // 第三方集成品牌图标（docs/08 §5.1）：官方 Google "G" 矢量标识 + 官方品牌色。
    iconStyle: 'brand',
    iconPalette: ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#FFFFFF'],
  },
  {
    slug: 'dsh-channels',
    pkg: '@local/dsh-channels',
    titleEn: 'Channels',
    titleZh: '消息通道',
    group: null,
    rowIds: ['channels'],
  },
  {
    slug: 'dsh-media',
    pkg: '@local/dsh-media',
    titleEn: 'Media',
    titleZh: '媒体',
    group: null,
    rowIds: ['media'],
  },
  {
    slug: 'browser-use',
    pkg: '@local/browser-use',
    titleEn: 'Browser Use',
    titleZh: '浏览器操作',
    group: 'browser-use',
    rowIds: ['browser-use'],
    // 命名例外（§8）：能力项目包沿用项目名，不加 @local/dsh- 前缀。
    legacyPkg: true,
  },
  {
    slug: 'computer-use',
    pkg: '@local/computer-use',
    titleEn: 'Computer Use',
    titleZh: '电脑操作',
    group: null,
    rowIds: ['computer-use', 'computer-use-overlay'],
    // 命名例外（§8）：能力项目包沿用项目名，不加 @local/dsh- 前缀。
    legacyPkg: true,
  },
  {
    slug: 'dsh-cloudflare',
    pkg: '@local/dsh-cloudflare',
    titleEn: 'Cloudflare',
    titleZh: 'Cloudflare',
    group: null,
    rowIds: ['cloudflare'],
    // 第三方集成品牌图标（docs/08 §5.1）：Cloudflare 官方云标
    // （cloudflare/skills 的 logo.svg，Apache-2.0，2026-11-10 获取）。
    iconStyle: 'brand',
    iconPalette: ['#F6821F', '#FFFFFF'],
  },
  {
    slug: 'dsh-aws',
    pkg: '@local/dsh-aws',
    titleEn: 'AWS',
    titleZh: 'AWS',
    group: null,
    rowIds: ['aws', 'tool-aws'],
    // 第三方集成品牌图标（docs/08 §5.1）：AWS 官方标识（wordmark + smile）
    // （Wikimedia Commons 的官方 logo 矢量副本，2026-11-13 获取）。
    iconStyle: 'brand',
    iconPalette: ['#252F3E', '#FF9900'],
  },
  {
    slug: 'exhibits',
    pkg: '@local/dsh-exhibits',
    titleEn: 'Exhibits',
    titleZh: '展台',
    group: null,
    rowIds: ['exhibits'],
  },
  {
    // 已发布到 npm 的独立仓库（docs/08 §3）。包名是它自己的 npm 身份，不是 @local/dsh-*：
    // `@local` 只用于本工作区未发布的 bundle（§1.1）。
    slug: 'dsh-agentic-tool-catalog',
    pkg: 'dsh-agentic-tool-catalog',
    titleEn: 'Agentic Tool Catalog',
    titleZh: 'Agent 工具目录',
    group: null,
    rowIds: ['agentic-tool-catalog'],
    legacyPkg: true,
  },
  {
    // 已发布到 npm 的独立仓库（docs/08 §3）。同上：用自身 npm 包名。
    slug: 'dsh-host-ops',
    pkg: 'dsh-host-ops',
    titleEn: 'Host Ops',
    titleZh: '宿主操作台',
    group: null,
    rowIds: ['host-ops'],
    legacyPkg: true,
  },
]

/** 已废止的按需组 id：出现在 KNOWN_GROUPS 里就是回归。 */
const RETIRED_GROUPS = ['dsh-ops']

/**
 * browser 能力分层组（2026-11-10，按评测数据引入）：`browser-advanced` / `browser-capabilities` 必须存在，
 * 且必须排在 core `browser` 之前 —— groupOf 取第一个命中，顺序错了 advanced/capabilities 会被 core 通配吞掉。
 * 断言只在分层组已出现时生效：历史版本的单一 `browser` 组不会因此报错。
 */
const TIER_GROUPS = ['browser-advanced', 'browser-capabilities', 'browser']

/** 描述长度上限（en 字符 / zh 字符），只告警不失败。 */
const DESC_LIMIT_EN = 200
const DESC_LIMIT_ZH = 80

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const asMarkdown = args.includes('--markdown')
const roots = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(path.resolve(args[++i]))
}
if (roots.length === 0) roots.push(path.join(REPO, 'plugins'))

const canonicalByDir = new Map(CANONICAL.map((entry) => [entry.slug, entry]))
const canonicalByPkg = new Map(CANONICAL.map((entry) => [entry.pkg, entry]))

/** 读 JSON，失败返回 { error }。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/**
 * 从 patch 里抠 Loader 行（组件）：`id` + `name` + 紧随其后的 `config.serverName`。
 * 刻意只做行级扫描、不引入 YAML 解析：我们自己的 patch 结构简单，够用且零依赖。
 * @param file - cordis.patch.yml 路径。
 * @returns 行数组（按出现顺序）。
 */
function patchRows(file) {
  if (!fs.existsSync(file)) return []
  const rows = []
  let current
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const rowMatch = /^\s*-\s+id:\s*['"]?([^'"\n#]+?)['"]?\s*$/.exec(line)
    if (rowMatch !== null) {
      current = { id: rowMatch[1], name: undefined, serverName: undefined }
      rows.push(current)
      continue
    }
    if (current === undefined) continue
    const nameMatch = /^\s+name:\s*['"]?([^'"\n#]+?)['"]?\s*$/.exec(line)
    if (nameMatch !== null && current.name === undefined) {
      current.name = nameMatch[1]
      continue
    }
    const serverMatch = /^\s+serverName:\s*['"]?([^'"\n#]+?)['"]?\s*$/.exec(line)
    if (serverMatch !== null && current.serverName === undefined) current.serverName = serverMatch[1]
  }
  return rows
}

/** 检查图标 SVG 的结构与调色板（docs/08 §4：glyph-only、透明底、渐变家族）。 */
function checkIcon(file, canonical) {
  const problems = []
  const brand = canonical?.iconStyle === 'brand'
  const palette = canonical?.iconPalette ?? PALETTE
  const size = fs.statSync(file).size
  if (size > 256 * 1024) problems.push(`图标 ${Math.round(size / 1024)}KiB 超过 256 KiB`)
  const svg = fs.readFileSync(file, 'utf8')
  // 注释里可以写溯源 URL（不加载资源）；检查"外部引用"前先去掉注释。
  const svgContent = svg.replace(/<!--[\s\S]*?-->/g, '')
  if (!svg.trimStart().startsWith('<svg')) problems.push('不是以 <svg 开头的 SVG')
  if (!/viewBox="0 0 36 36"/.test(svg)) problems.push('viewBox 必须是 "0 0 36 36"')
  if (!/width="36"/.test(svg) || !/height="36"/.test(svg)) problems.push('缺少 width="36" height="36"')
  if (!/fill="none"/.test(svg.slice(0, 300))) problems.push('根节点应声明 fill="none"（透明底）')
  if (svgContent.includes('currentColor')) problems.push('用了 currentColor（图片 data URL 里不生效，必须写死颜色）')
  if (/<text[\s>]/.test(svg)) problems.push('用了 <text>（应改为矢量图形）')
  if (/<filter[\s>]/.test(svg)) problems.push('用了 <filter>（禁止；用渐变/叠色做层次）')
  if (/<mask[\s>]/.test(svg)) problems.push('用了 <mask>（禁止；用白色负空间/叠色）')
  if (/https?:\/\//.test(svgContent.replace(/xmlns(:\w+)?="[^"]*"/g, ''))) problems.push('引用了外部资源')
  // glyph-only：不允许满版不透明底板/背景矩形（Plugins 页自带浅色圆角容器）。
  for (const match of svg.matchAll(/<rect\b[^>]*>/g)) {
    const tag = match[0]
    const num = (name) => {
      const found = new RegExp(`${name}="(-?[\\d.]+)"`).exec(tag)
      return found === null ? undefined : Number(found[1])
    }
    const width = num('width')
    const height = num('height')
    const x = num('x') ?? 0
    const y = num('y') ?? 0
    const unfilled = /fill="none"/.test(tag)
    if (!unfilled && width !== undefined && height !== undefined && width >= 20 && height >= 20 && x <= 8 && y <= 8) {
      problems.push(`出现了接近满版的背景矩形（${width}×${height}；glyph-only 规范禁止自画底板，Plugins 页会自带容器）`)
    }
  }
  // 渐变：定义必须被引用、引用必须有定义，且 stop 颜色在调色板内。
  const defined = new Map()
  for (const match of svg.matchAll(/<linearGradient[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/linearGradient>/g)) {
    const stops = [...match[2].matchAll(/stop-color="([^"]+)"/g)].map((m) => m[1].toUpperCase())
    defined.set(match[1], stops)
  }
  const used = new Set([...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]))
  for (const id of used) {
    if (!defined.has(id)) problems.push(`url(#${id}) 没有对应的 <linearGradient>`)
  }
  if (!brand) {
    if (defined.size === 0) problems.push('没有 linearGradient（家族图标必须是"渐变主形"，单色平面剪影不合格）')
    if (used.size === 0) problems.push('没有形状使用 fill/stroke="url(#…)" 渐变（单色平面剪影不合格）')
  }
  for (const [id, stops] of defined) {
    if (!id.startsWith('dsh-')) problems.push(`渐变 id "${id}" 应以 dsh- 前缀（避免同页冲突）`)
    if (stops.length < 2) problems.push(`渐变 "${id}" 少于 2 个 stop`)
    for (const stop of stops) {
      if (!palette.includes(stop)) problems.push(`渐变 "${id}" 用了调色板外的颜色 ${stop}`)
    }
  }
  // 其余显式颜色也必须来自调色板（允许 fill/stroke 的 opacity）。
  for (const match of svg.matchAll(/(?:fill|stroke|stop-color)="(#[0-9A-Fa-f]{3,8})"/g)) {
    const color = match[1].toUpperCase()
    if (!palette.includes(color)) problems.push(`用了调色板外的颜色 ${match[1]}`)
  }
  // 品牌图标（第三方官方标识）必须留溯源注释，说明来源与"官方标识不改色/不改形"。
  if (brand && !/official/i.test(svg)) {
    problems.push('品牌图标缺少溯源注释（注释里需含 "official" 与官方资产 URL，见 docs/08 §5.1）')
  }
  return problems
}

/**
 * 审计一个 bundle。
 * @param dir - bundle 目录绝对路径。
 * @returns 审计结果。
 */
function auditBundle(dir) {
  const dirName = path.basename(dir)
  const problems = []
  const warnings = []
  const pkgFile = path.join(dir, 'package.json')
  const pkg = readJson(pkgFile)
  if (pkg.error !== undefined) {
    return { dirName, pkgName: '?', problems: [`package.json 解析失败: ${pkg.error}`], warnings, exempt: undefined, rowIds: [] }
  }

  const exempt = EXEMPT[dirName]
  const canonical = canonicalByDir.get(dirName) ?? canonicalByPkg.get(pkg.name)

  // ── 1. manifest ──────────────────────────────────────────────────────────
  if (typeof pkg.name !== 'string' || (!pkg.name.startsWith('@local/dsh-') && canonical?.legacyPkg !== true)) {
    problems.push(`包名应为 @local/dsh-*，实际 ${String(pkg.name)}${canonical?.legacyPkg === true ? '（canonical 已登记历史例外）' : ''}`)
  }
  if (typeof pkg.description !== 'string' || pkg.description.trim() === '') {
    problems.push('package.json 缺少 description（展示回退项）')
  }
  if (typeof pkg.icon !== 'string') {
    problems.push('package.json 缺少 icon 字段')
  } else {
    const iconFile = path.join(dir, pkg.icon)
    if (!fs.existsSync(iconFile)) problems.push(`icon 指向的文件不存在: ${pkg.icon}`)
    else problems.push(...checkIcon(iconFile, canonical))
  }
  if (pkg.exports?.['./package.json'] !== './package.json') {
    problems.push('exports 缺 "./package.json"（展示元数据回退要读它）')
  }
  if (pkg.exports?.['./locale/*.json'] !== './locale/*.json') {
    problems.push('exports 缺 "./locale/*.json"（Plugins 页双语标题/描述要从这里读）')
  }
  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const required of ['icon.svg', 'locale/*.json']) {
    if (!files.includes(required)) problems.push(`package.json files 缺 "${required}"`)
  }

  if (typeof pkg.dsh?.bundle?.patch !== 'string') problems.push('缺少 dsh.bundle.patch')
  if (pkg.meta !== undefined) warnings.push('package.json 顶层 meta 不会被读取器读取，展示文案请放 locale/*.json')

  // ── 2. locale ────────────────────────────────────────────────────────────
  const locale = {}
  for (const lang of ['en', 'zh']) {
    const file = path.join(dir, 'locale', `${lang}.json`)
    if (!fs.existsSync(file)) {
      problems.push(`缺少 locale/${lang}.json`)
      continue
    }
    const data = readJson(file)
    if (data.error !== undefined) {
      problems.push(`locale/${lang}.json 解析失败: ${data.error}`)
      continue
    }
    const meta = data.meta ?? {}
    if (typeof meta.title !== 'string' || meta.title.trim() === '') problems.push(`locale/${lang}.json 缺 meta.title`)
    if (typeof meta.description !== 'string' || meta.description.trim() === '') problems.push(`locale/${lang}.json 缺 meta.description`)
    // 插件页详情文档（docs/08 §9）：每个语言都必须声明 meta.detail，且文件存在、进 files 白名单。
    if (typeof meta.detail !== 'string' || meta.detail.trim() === '') {
      problems.push(`locale/${lang}.json 缺 meta.detail（插件页需要双语详情文档）`)
    } else {
      const detailPath = meta.detail.replace(/^\.\//, '')
      if (!detailPath.endsWith('.md') && !detailPath.endsWith('.markdown')) {
        problems.push(`locale/${lang}.json meta.detail 必须以 .md/.markdown 结尾：${meta.detail}`)
      } else if (!fs.existsSync(path.join(dir, detailPath))) {
        problems.push(`locale/${lang}.json meta.detail 指向的文件不存在：${meta.detail}`)
      }
    }
    locale[lang] = meta
  }
  if (canonical !== undefined) {
    if (locale.en?.title !== undefined && locale.en.title !== canonical.titleEn) {
      problems.push(`en 标题应为 "${canonical.titleEn}"，实际 "${locale.en.title}"`)
    }
    if (locale.zh?.title !== undefined && locale.zh.title !== canonical.titleZh) {
      problems.push(`zh 标题应为 "${canonical.titleZh}"，实际 "${locale.zh.title}"`)
    }
  } else if (!exempt) {
    problems.push('不在 docs/08 §3 的 canonical 表里：新增插件请先在文档里加一行，并同步本脚本 CANONICAL')
  }
  if ((locale.en?.description?.length ?? 0) > DESC_LIMIT_EN) {
    warnings.push(`en 描述 ${locale.en.description.length} 字符，建议 ≤ ${DESC_LIMIT_EN}`)
  }
  if ((locale.zh?.description?.length ?? 0) > DESC_LIMIT_ZH) {
    warnings.push(`zh 描述 ${locale.zh.description.length} 字，建议 ≤ ${DESC_LIMIT_ZH}`)
  }
  for (const lang of ['en', 'zh']) {
    const detail = locale?.[lang]?.detail
    if (typeof detail === 'string') {
      const rel = detail.replace(/^\.\//, '')
      if (!files.includes(rel)) problems.push(`package.json files 缺插件页详情文档 "${rel}"`)
    }
  }

  // ── 3. 组件（Loader 行）id ────────────────────────────────────────────────
  const rows = patchRows(path.join(dir, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml'))
  const rowIds = rows.map((row) => row.id)
  if (exempt === undefined) {
    const seen = new Set()
    for (const row of rows) {
      const { id } = row
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) {
        problems.push(`组件行 id "${id}" 不是 kebab-case（^[a-z][a-z0-9]*(-[a-z0-9]+)*$）`)
      }
      if (id.startsWith('dsh-')) {
        problems.push(`组件行 id "${id}" 带了 dsh- 前缀（dsh- 是包名前缀，行 id 默认 = 包名去 scope 与 dsh-）`)
      }
      if (seen.has(id)) problems.push(`组件行 id "${id}" 在同一 bundle 内重复`)
      seen.add(id)
      if (row.name === '@deepseek-ai/dsh-mcp-client') {
        if (row.serverName === undefined) problems.push(`MCP 组件行 "${id}" 缺少 config.serverName（行 id 应为 mcp-<serverName>）`)
        else if (id !== `mcp-${row.serverName}`) {
          problems.push(`MCP 组件行 id 应为 "mcp-${row.serverName}"（与 config.serverName 一致），实际 "${id}"`)
        }
      }
    }
    if (canonical !== undefined) {
      const expected = canonical.rowIds
      for (const id of rowIds) {
        if (!expected.includes(id)) problems.push(`组件行 id "${id}" 不在 docs/08 §3 canonical 期望里（${expected.join(', ') || '无'}）`)
      }
      for (const id of expected) {
        if (!rowIds.includes(id)) problems.push(`缺少 canonical 组件行 id "${id}"（docs/08 §3）`)
      }
    }
  }

  return { dirName, pkgName: pkg.name, problems, warnings, exempt, rows, rowIds, canonical, locale }
}

// ── 收集 ───────────────────────────────────────────────────────────────────
// root 可以是 bundle 目录本身（含 package.json），也可以是 bundles 的父目录。
// 父目录扫描时只收 bundle：有 dsh.bundle.patch，或是 docs/08 §2 canonical 里的插件
// （这样同工作区里的库包 operator-core 之类不会被误判成插件）。
const bundleDirs = []
for (const root of roots) {
  if (!fs.existsSync(root)) continue
  if (fs.existsSync(path.join(root, 'package.json'))) {
    bundleDirs.push(root)
    continue
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    const pkg = readJson(path.join(dir, 'package.json'))
    const isBundle = typeof pkg.dsh?.bundle?.patch === 'string'
    const isCanonical = canonicalByDir.has(entry.name) || canonicalByPkg.has(pkg.name)
    if (isBundle || isCanonical) bundleDirs.push(dir)
  }
}

const results = bundleDirs.map(auditBundle)
const active = results.filter((result) => result.exempt === undefined)
const exempted = results.filter((result) => result.exempt !== undefined)
const failing = active.filter((result) => result.problems.length > 0)
const warned = results.filter((result) => result.warnings.length > 0)
const totalProblems = failing.reduce((sum, result) => sum + result.problems.length, 0)

if (asJson) {
  console.log(JSON.stringify({
    bundles: results.map(({ dirName, pkgName, problems, warnings, exempt, rowIds, canonical, locale }) => ({
      dir: dirName,
      package: pkgName,
      exempt,
      titleEn: locale?.en?.title,
      titleZh: locale?.zh?.title,
      group: canonical?.group ?? null,
      rowIds,
      problems,
      warnings,
    })),
    compliant: failing.length === 0,
  }, null, 2))
  process.exit(totalProblems === 0 ? 0 : 1)
}

if (asMarkdown) {
  console.log('| 目录 | 包名 | 组件行 id | 标题 en / zh | 按需组 | 图标 | 合规 |')
  console.log('|---|---|---|---|---|---|---|')
  for (const result of results) {
    const icon = result.exempt ? '—' : (result.problems.some((p) => p.includes('图标') || p.includes('icon'))
      ? '✗' : '✓')
    const status = result.exempt !== undefined ? `豁免（${result.exempt}）` : (result.problems.length === 0 ? '✓' : `✗ ${result.problems.length} 项`)
    const rows = result.rowIds === undefined || result.rowIds.length === 0 ? '—' : result.rowIds.map((id) => `\`${id}\``).join('、')
    console.log(`| ${result.dirName} | \`${result.pkgName}\` | ${rows} | ${result.locale?.en?.title ?? '—'} / ${result.locale?.zh?.title ?? '—'} | ${result.canonical?.group ?? '—'} | ${icon} | ${status} |`)
  }
  process.exit(totalProblems === 0 ? 0 : 1)
}

// ── 人读输出 ───────────────────────────────────────────────────────────────
console.log(`插件展示规范审计（docs/08）—— ${results.length} 个 bundle\n`)
for (const result of results) {
  if (result.exempt !== undefined) {
    console.log(`– ${result.dirName}: 豁免（${result.exempt}）`)
    continue
  }
  const status = result.problems.length === 0 ? '✓' : '✗'
  console.log(`${status} ${result.dirName}  [${result.pkgName}]`)
  if (result.canonical !== undefined) {
    console.log(`    标题: ${result.locale?.en?.title ?? '—'} / ${result.locale?.zh?.title ?? '—'}；按需组: ${result.canonical.group ?? '—'}；行 id: ${result.rowIds.join(', ') || '—'}`)
  }
  for (const problem of result.problems) console.log(`    ✗ ${problem}`)
  for (const warning of result.warnings) console.log(`    · ${warning}`)
}
if (exempted.length > 0) console.log(`\n豁免 ${exempted.length} 个：${exempted.map((r) => r.dirName).join(', ')}`)
if (warned.length > 0) console.log(`建议项 ${warned.length} 个 bundle（不影响退出码）`)
if (totalProblems === 0) {
  console.log(`\n全部合规：${active.length} 个产品 bundle`)
  process.exit(0)
}
console.log(`\n有 ${totalProblems} 项不合规（${failing.length} 个 bundle）`)
process.exit(1)
