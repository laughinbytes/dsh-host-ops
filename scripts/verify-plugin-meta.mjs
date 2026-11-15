#!/usr/bin/env node
/**
 * verify-plugin-meta.mjs —— 只读模拟官方 Plugins 页展示元数据读取器。
 *
 * 为什么需要它：Plugins 页的标题 / 描述 / 图标由 `@deepseek-ai/dsh-app-boot` 的
 * `readPluginMeta()`（经 `ctx.pluginPackages.metaOf()` / `resolvePluginResource()`）读取，
 * 它**不加载插件代码**，只通过 Node `exports` 解析 `<pkg>/package.json` 与
 * `<pkg>/locale/<lang>.json`，再读 manifest `icon` 并转成 data URL。本脚本按同一语义
 * 在本地只读复算一遍，用来证明"插件在 Plugins 页会显示成什么"，不依赖浏览器。
 *
 * 依据（按优先级）：
 *   1. `reference/extracted/dsh-app-boot/README.md` §Reading plugin display metadata；
 *   2. `reference/tmp/pm-readme/README.md`（Plugins 页 "Installed bundles ... display
 *      their own title and description ..." 段落）；
 *   3. `reference/extracted/boot/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
 *      的 `readPluginMeta` / `dictionariesOf` / `localizedText` / `iconOf`（语义逐条对齐）。
 *
 * 解析规则（与官方一致）：
 *   - 包根 specifier：locale 字段缺失时回退到可导出的 `package.json` 的 name/description；
 *     `exports` 解析不到 `./package.json` 时没有回退文本，也没有图标；
 *   - locale 目录：从能解析的 `<pkg>/locale/en.json` 所在目录 readdir 所有 `*.json`，
 *     文件名必须是语言 id，每个文件都要能按 `<pkg>/locale/<name>` 通过 exports 解析；
 *   - title 最终回退是完整模块 specifier（这里用包名），description 最终回退是空串；
 *   - icon：manifest `icon` 为 manifest 目录内的相对路径，扩展名限 SVG/PNG/JPEG/WebP，
 *     realpath 后仍须在 manifest 目录内，普通文件且 ≤ 256 KiB，输出 `data:<mime>;base64,...`。
 *
 * 用法：
 *   node scripts/verify-plugin-meta.mjs                    # 默认解析 plugins/
 *   node scripts/verify-plugin-meta.mjs --root <dir> ...   # 可重复；<dir> 是 bundle 目录或其父目录
 *   node scripts/verify-plugin-meta.mjs --help
 *
 * bundle 判定（--root 指向父目录时生效）：目录自身有 package.json → 整个 root 当单个 bundle；
 * 否则扫描一级子目录，只取「有 dsh.bundle.patch 的 bundle」；docs/08 §2 canonical 表里的
 * 目录名/包名是例外，即使缺 patch 也照常检查（把问题暴露成 ✗，而不是静默跳过）。
 * 库包（如 operator/operator-core，没有 dsh.bundle.patch）不是插件，不参与展示元数据检查。
 *
 * 退出码：0 = 全部 bundle 的标题/描述/图标都能被读取器解析；1 = 有解析失败。
 *
 * @module verify-plugin-meta
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** 语言 id：与官方 `LANGUAGE_ID` 一致（en / zh / zh-CN / en-US ...）。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** 图标最大字节数：与官方 `MAX_ICON_BYTES` 一致。 */
const MAX_ICON_BYTES = 256 * 1024

/** 图标扩展名 → MIME：与官方 `ICON_MEDIA_TYPES` 一致。 */
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/**
 * 非产品插件豁免（docs/08 §5）：不是产品插件，不参与展示元数据检查。
 * @type {Record<string, string>}
 */
const EXEMPT = {
  'hello-dsh': '官方起点模板抄本，不是产品插件',
}

/**
 * docs/08 §2 canonical 表的目录名与包名（唯一真源）：即使目录缺 `dsh.bundle.patch`，
 * 也照常当 bundle 检查，让缺失字段以 ✗ 暴露，而不是被当成"非 bundle 目录"静默跳过。
 * @type {Set<string>}
 */
const CANONICAL_DIRS = new Set([
  'dsh-attention-center',
  'dsh-balance-hud',
  'dsh-privacy-guard',
  'dsh-google-workspace',
  'dsh-channels',
])

/** docs/08 §2 canonical 包名（目录名 ≠ 包名 / 历史例外时兜底）。 */
const CANONICAL_PACKAGES = new Set([
  '@local/dsh-attention-center',
  '@local/dsh-balance-hud',
  '@local/dsh-privacy-guard',
  '@local/dsh-google-workspace-bundle',
  '@local/dsh-channels',
  '@local/browser-use',
  '@local/computer-use',
  '@local/dsh-exhibits',
])

// ── 参数 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: node scripts/verify-plugin-meta.mjs [--root <bundle 目录或父目录>] ...')
  console.log('默认 root: <repo>/plugins。--root 可重复：目录含 package.json → 当成单个 bundle；')
  console.log('否则扫描其一级子目录，只取有 dsh.bundle.patch 的 bundle（docs/08 §2 canonical 目录/包名例外，照常检查）。')
  process.exit(0)
}
const roots = []
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--root') {
    console.error(`未知参数: ${args[i]}（只支持 --root）`)
    process.exit(2)
  }
  const value = args[++i]
  if (value === undefined || value.startsWith('--')) {
    console.error('--root 需要一个目录参数')
    process.exit(2)
  }
  roots.push(path.resolve(value))
}
if (roots.length === 0) roots.push(path.join(REPO, 'plugins'))

// ── 通用读取工具（对应官方 package-meta.js 的 readObject / objectOf / textOf）──

/** 读取并解析 JSON；失败时抛出带路径的错误。 */
function readJson(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${file}: ${String(error?.message ?? error)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file}: ${String(error?.message ?? error)}`)
  }
}

/** 校验对象。 */
function objectOf(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} 必须是对象`)
  }
  return value
}

/** 校验非空字符串字段；undefined 直接放行（官方 textOf 语义）。 */
function textOf(value, where) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where} 必须是非空字符串`)
  }
  return value
}

/** 展示回退文本：非空字符串才用。 */
function fallbackText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

// ── exports 解析（Node 子路径 exports 语义；官方走真实 Node ESM resolver）────────

/** 取条件导出的第一个可用目标（default / import / node / require）。 */
function pickTarget(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = pickTarget(item)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    for (const key of ['default', 'import', 'node', 'require']) {
      if (Object.hasOwn(value, key)) {
        const target = pickTarget(value[key])
        if (target !== undefined) return target
      }
    }
  }
  return undefined
}

/** 把 exports 字段归一成「子路径 → 目标」表；整体为条件对象时视为 "." 导出。 */
function exportsMapOf(exportsField) {
  if (exportsField === undefined || exportsField === null) return {}
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return { '.': exportsField }
  const object = objectOf(exportsField, 'package.json: exports')
  const keys = Object.keys(object)
  if (keys.length > 0 && keys.some((key) => key.startsWith('.'))) return object
  return { '.': exportsField }
}

/**
 * 按 exports 解析子路径，返回包内相对目标（如 "./locale/en.json"）。
 * 只支持官方示例会用到的形态：精确键 + 单 `*` 模式键。
 */
function resolveExportsTarget(exportsField, subpath) {
  const map = exportsMapOf(exportsField)
  if (Object.hasOwn(map, subpath)) {
    const target = pickTarget(map[subpath])
    if (target === undefined) throw new Error(`exports["${subpath}"] 没有可用目标`)
    return { target, matchedBy: subpath }
  }
  // 模式键：key 含一个 `*`；Node 选前缀最长的匹配。
  let best
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*')
    if (star < 0) continue
    if (key.indexOf('*', star + 1) !== -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (subpath.length < prefix.length + suffix.length) continue
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length)
    if (best === undefined || prefix.length > best.prefixLength) {
      best = { key, target: pickTarget(map[key]), matched, prefixLength: prefix.length }
    }
  }
  if (best === undefined || best.target === undefined) {
    throw new Error(`exports 未导出子路径 "${subpath}"`)
  }
  if (!best.target.includes('*')) {
    throw new Error(`exports["${best.key}"] 的目标 "${best.target}" 不含 *，无法映射 "${subpath}"`)
  }
  return { target: best.target.replace('*', best.matched), matchedBy: best.key }
}

/**
 * 模拟 `resolvePluginResource('<pkg><subpath>')`：解析 exports → 包内文件必须在包目录内且存在。
 * 返回绝对文件路径；失败抛错（对应官方 ERR_PACKAGE_PATH_NOT_EXPORTED / MODULE_NOT_FOUND）。
 */
function resolvePackageResource(bundleDir, manifest, subpath) {
  let resolved
  try {
    resolved = resolveExportsTarget(manifest.exports, subpath)
  } catch (error) {
    throw new Error(`${subpath}: ${String(error?.message ?? error)}`)
  }
  const target = resolved.target
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`${subpath}: exports 目标必须是 "./" 开头的相对路径，实际 ${JSON.stringify(target)}`)
  }
  const segments = target.split('/')
  if (segments.includes('..') || segments.includes('node_modules')) {
    throw new Error(`${subpath}: exports 目标不能跳出包目录，实际 ${target}`)
  }
  const file = path.resolve(bundleDir, target)
  const relative = path.relative(bundleDir, file)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${subpath}: exports 目标跳出包目录: ${target}`)
  }
  if (!fs.existsSync(file)) {
    throw new Error(`${subpath}: exports 目标在磁盘上不存在: ${target}`)
  }
  if (!fs.statSync(file).isFile()) {
    throw new Error(`${subpath}: exports 目标不是普通文件: ${target}`)
  }
  return file
}

// ── locale 词典（对应官方 dictionariesOf）─────────────────────────────────────

/**
 * 读一个 bundle 的 locale 词典。
 * @returns {{ dictionaries: Map<string, {title?: string, description?: string}>, localeDir?: string, englishPath?: string, problems: string[] }}
 */
function readDictionaries(bundleDir, manifest) {
  const problems = []
  const dictionaries = new Map()
  let englishPath
  try {
    englishPath = resolvePackageResource(bundleDir, manifest, './locale/en.json')
  } catch (error) {
    problems.push(`locale 锚点不可读：${String(error?.message ?? error)}`)
    return { dictionaries, problems }
  }
  const localeDir = path.dirname(englishPath)
  const seen = new Set()
  for (const entry of fs.readdirSync(localeDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const language = entry.name.slice(0, -5)
    try {
      if (!LANGUAGE_ID.test(language)) {
        throw new Error(`locale 文件名 "${entry.name}" 不是合法语言 id`)
      }
      const id = language.toLowerCase()
      if (seen.has(id)) throw new Error(`locale/${entry.name} 与已有语言重复（${id}）`)
      seen.add(id)
      const resource = `./locale/${entry.name}`
      const file = resolvePackageResource(bundleDir, manifest, resource)
      if (path.dirname(file) !== localeDir) {
        throw new Error(`${resource}: 解析到 ${file}，必须与 locale/en.json 同目录 ${localeDir}`)
      }
      const parsed = objectOf(readJson(file), file)
      const meta = parsed.meta === undefined ? undefined : objectOf(parsed.meta, `${file}: meta`)
      dictionaries.set(id, {
        title: textOf(meta?.title, `${file}: meta.title`),
        description: textOf(meta?.description, `${file}: meta.description`),
      })
    } catch (error) {
      problems.push(`locale/${entry.name} 解析失败：${String(error?.message ?? error)}`)
    }
  }
  return { dictionaries, localeDir, englishPath, problems }
}

/**
 * 对应官方 `localizedText`：有翻译时返回 { en: 回退, ...按语言 }, 否则返回回退值。
 */
function localizedText(field, dictionaries, fallback, finalFallback) {
  const entries = []
  for (const [language, fields] of dictionaries) {
    const value = fields[field]
    if (value !== undefined) entries.push([language, value])
  }
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}

// ── 图标（对应官方 iconOf）────────────────────────────────────────────────────

/**
 * 读 manifest 声明（或 `./icon` 导出回退）的图标，复算官方 data URL 并解码验证。
 * @returns {{ mime: string, bytes: number, dataUrlLength: number, decodedBytes: number, source: string, file: string }}
 */
function readIcon(bundleDir, manifest, manifestPath) {
  const icon = textOf(manifest.icon, 'package.json: icon')
  if (icon === undefined) {
    // 官方 README：包根在 manifest 省略 icon 时用 `<package>/icon`（导出的子路径）。
    let fallbackFile
    try {
      fallbackFile = resolvePackageResource(bundleDir, manifest, './icon')
    } catch (error) {
      throw new Error(`package.json 缺 icon 字段，且无法回退到导出的 ./icon：${String(error?.message ?? error)}`)
    }
    return iconFromFile(fallbackFile, manifestPath, 'exports "./icon" 回退')
  }
  if (path.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) {
    throw new Error('package.json: icon 必须是相对文件路径')
  }
  const mediaType = ICON_MEDIA_TYPES.get(path.extname(icon).toLowerCase())
  if (mediaType === undefined) {
    throw new Error('package.json: icon 必须是 SVG、PNG、JPEG 或 WebP')
  }
  const directory = fs.realpathSync(path.dirname(manifestPath))
  let file
  try {
    file = fs.realpathSync(path.resolve(directory, icon))
  } catch (error) {
    throw new Error(`package.json: icon 指向的文件不存在（${icon}）：${String(error?.message ?? error)}`)
  }
  const local = path.relative(directory, file)
  if (local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) {
    throw new Error('package.json: icon 必须留在 manifest 目录内')
  }
  return iconFromFile(file, manifestPath, 'manifest icon', mediaType)
}

/** 读取图标文件并生成/解码 data URL。 */
function iconFromFile(file, manifestPath, source, knownMediaType) {
  const mediaType = knownMediaType ?? ICON_MEDIA_TYPES.get(path.extname(file).toLowerCase())
  if (mediaType === undefined) {
    throw new Error(`${file}: 图标必须是 SVG、PNG、JPEG 或 WebP`)
  }
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error(`${manifestPath}: icon 必须是普通文件`)
  if (stat.size > MAX_ICON_BYTES) {
    throw new Error(`${manifestPath}: icon 超过 256 KiB（${Math.round(stat.size / 1024)} KiB）`)
  }
  const bytes = fs.readFileSync(file)
  if (bytes.length > MAX_ICON_BYTES) {
    throw new Error(`${manifestPath}: icon 超过 256 KiB（${bytes.length} B）`)
  }
  const base64 = bytes.toString('base64')
  const dataUrl = `data:${mediaType};base64,${base64}`
  // 复算 base64 data URL：前缀格式 + 字符集 + 解码字节数与内容一致。
  const prefix = `data:${mediaType};base64,`
  if (!dataUrl.startsWith(prefix)) throw new Error('icon data URL 前缀不正确')
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) throw new Error('icon base64 内容含非法字符')
  const decoded = Buffer.from(base64, 'base64')
  if (decoded.length !== bytes.length || Buffer.compare(decoded, bytes) !== 0) {
    throw new Error('icon data URL base64 解码后与源文件不一致')
  }
  return {
    mime: mediaType,
    bytes: bytes.length,
    dataUrlLength: dataUrl.length,
    decodedBytes: decoded.length,
    source,
    file,
  }
}

// ── 单 bundle 验证 ──────────────────────────────────────────────────────────

/** 截断展示文本。 */
function clip(text, max = 78) {
  if (text === undefined) return '—'
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * 验证一个 bundle。
 * @returns {{ dirName: string, packageName?: string, ok: boolean, problems: string[], warnings: string[], lines: string[] }}
 */
function verifyBundle(bundleDir) {
  const dirName = path.basename(bundleDir)
  const problems = []
  const warnings = []
  const lines = []
  const pkgFile = path.join(bundleDir, 'package.json')

  let manifest
  try {
    manifest = objectOf(readJson(pkgFile), pkgFile)
  } catch (error) {
    return {
      dirName,
      ok: false,
      problems: [`package.json 解析失败：${String(error?.message ?? error)}`],
      warnings,
      lines,
    }
  }
  const packageName = typeof manifest.name === 'string' ? manifest.name : undefined

  // 1) exports：包根 package.json（回退文本 + icon 的来源）必须可解析。
  let manifestPath
  try {
    manifestPath = resolvePackageResource(bundleDir, manifest, './package.json')
    if (path.resolve(manifestPath) !== path.resolve(pkgFile)) {
      warnings.push(`exports "./package.json" 解析到 ${manifestPath}，不是包根 package.json`)
    }
  } catch (error) {
    problems.push(`exports 解析 "./package.json" 失败：${String(error?.message ?? error)}`)
  }
  if (manifest.exports === undefined) {
    problems.push('package.json 缺 exports：官方读取器无法导出 ./package.json 与 ./locale/*.json')
  } else if (!Object.hasOwn(exportsMapOf(manifest.exports), './locale/*.json')) {
    problems.push('exports 缺 "./locale/*.json": "./locale/*.json"')
  }

  // 2) locale 词典。
  const { dictionaries, englishPath, problems: localeProblems } = readDictionaries(bundleDir, manifest)
  problems.push(...localeProblems)
  const localeFiles = [...dictionaries.keys()].sort()
  for (const lang of ['en', 'zh']) {
    if (!dictionaries.has(lang)) {
      if (lang === 'en') problems.push('locale 缺 en（官方读取器以 locale/en.json 为锚点）')
      else warnings.push('locale 缺 zh（中文界面会回退到英文）')
    }
  }

  // 3) 展示文案回退链：locale meta → package.json name/description。
  const nameFallback = fallbackText(manifest.name)
  const descriptionFallback = fallbackText(manifest.description)
  const title = localizedText('title', dictionaries, nameFallback, packageName ?? dirName)
  const description = localizedText('description', dictionaries, descriptionFallback, '')
  const titleEn = typeof title === 'string' ? title : title?.en
  const descEn = typeof description === 'string' ? description : description?.en
  const localeEnTitle = dictionaries.get('en')?.title
  const localeEnDescription = dictionaries.get('en')?.description
  if (typeof titleEn !== 'string' || titleEn.trim() === '') {
    problems.push('最终 title 为空（Plugins 页会显示完整模块 specifier）')
  } else if (localeEnTitle === undefined) {
    warnings.push('en title 未来自 locale，回退到 package.json name')
  }
  if (typeof descEn !== 'string' || descEn.trim() === '') {
    problems.push('最终 description 为空（回退链 locale meta.description → package.json description 都没有值）')
  } else if (localeEnDescription === undefined) {
    warnings.push('en description 未来自 locale，回退到 package.json description')
  }
  const titleZh = typeof title === 'object' ? title.zh : undefined
  const descZh = typeof description === 'object' ? description.zh : undefined

  // 4) icon：manifest icon → 存在 / 目录内 / ≤256 KiB / data URL base64 可解码。
  let icon
  if (manifestPath !== undefined) {
    try {
      icon = readIcon(bundleDir, manifest, manifestPath)
    } catch (error) {
      problems.push(`icon 解析失败：${String(error?.message ?? error)}`)
    }
  } else {
    problems.push('icon 无法读取：exports 解析不到 ./package.json')
  }

  // 5) 组装"Plugins 页会显示成什么"。
  const localeSource = localeFiles.length > 0
    ? `locale/${localeFiles.map((lang) => `${lang}.json`).join(' + locale/')}`
    : '（无 locale 文件）'
  const titleLine = typeof title === 'string'
    ? `${title}  ← package.json name（回退；${localeSource} 无 title）`
    : (() => {
        const parts = []
        if (title?.en !== undefined) parts.push(`en「${title.en}」`)
        if (typeof titleZh === 'string') parts.push(`zh「${titleZh}」`)
        const extra = [...dictionaries.keys()].filter((lang) => lang !== 'en' && lang !== 'zh')
        if (extra.length > 0) parts.push(`${extra.join(', ')} 词典`)
        return parts.length > 0 ? `${parts.join('  ')}  ← ${localeSource}` : `（空）  ← ${localeSource}`
      })()
  const descLine = typeof description === 'string'
    ? `${clip(description)}（${description.length} 字符）  ← package.json description（回退）`
    : (() => {
        const parts = []
        if (typeof description?.en === 'string') parts.push(`en ${clip(description.en)}（${description.en.length} 字符）`)
        if (typeof descZh === 'string') parts.push(`zh ${clip(descZh)}（${descZh.length} 字符）`)
        return parts.length > 0 ? `${parts.join('  ')}  ← ${localeSource}` : `（空）  ← ${localeSource}`
      })()
  const iconLine = icon === undefined
    ? '✗ 不可用（Plugins 页回退默认图）'
    : `${path.relative(bundleDir, icon.file) || icon.file} → ${icon.mime} ${icon.bytes} B；` +
      `data URL ${icon.dataUrlLength} 字符 → base64 解码 ${icon.decodedBytes} B ✓（${icon.source}）`
  const exportsLine = `${manifestPath ? '✓' : '✗'} ./package.json   ` +
    `${englishPath ? '✓' : '✗'} ./locale/*.json` +
    (localeFiles.length > 0 ? `（${localeFiles.map((lang) => `${lang}.json`).join(', ')}）` : '')

  lines.push(`    title        ${titleLine}`)
  lines.push(`    description  ${descLine}`)
  lines.push(`    icon         ${iconLine}`)
  lines.push(`    exports      ${exportsLine}`)

  return { dirName, packageName, ok: problems.length === 0, problems, warnings, lines }
}

// ── 收集 bundle + 主流程 ─────────────────────────────────────────────────────

/** 读目录里的 package.json；解析失败返回 undefined（交给 verifyBundle 报解析失败）。 */
function tryReadManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * bundle 判定：有 `dsh.bundle.patch` 才是插件 bundle（库包不是）；
 * docs/08 §2 canonical 表的目录名/包名是例外，照常检查。
 */
function isBundleDir(dir, manifest) {
  if (manifest?.dsh?.bundle?.patch !== undefined) return true
  if (CANONICAL_DIRS.has(path.basename(dir))) return true
  return typeof manifest?.name === 'string' && CANONICAL_PACKAGES.has(manifest.name)
}

/**
 * 展开 root：root 自身有 package.json → 整个 root 当单个 bundle；
 * 否则扫描一级子目录，只收 bundle（库包 / 非插件目录跳过）。
 */
function collectBundles(root) {
  if (!fs.existsSync(root)) return []
  if (fs.existsSync(path.join(root, 'package.json'))) return [root]
  const bundles = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    const manifest = tryReadManifest(dir)
    // package.json 解析失败：canonical 目录照常进检查（会报解析失败），其它目录跳过。
    if (manifest === undefined) {
      if (CANONICAL_DIRS.has(entry.name)) bundles.push(dir)
      continue
    }
    if (!isBundleDir(dir, manifest)) continue
    bundles.push(dir)
  }
  return bundles.sort()
}

const bundles = []
const seenDirs = new Set()
for (const root of roots) {
  for (const bundleDir of collectBundles(root)) {
    const real = fs.realpathSync(bundleDir)
    if (seenDirs.has(real)) continue
    seenDirs.add(real)
    bundles.push(bundleDir)
  }
}

console.log(`展示元数据解析（模拟官方 readPluginMeta / Plugins 页读取器）—— ${bundles.length} 个 bundle`)
console.log(`root: ${roots.map((root) => path.relative(REPO, root) || '.').join(', ')}\n`)

const results = []
for (const bundleDir of bundles) {
  const dirName = path.basename(bundleDir)
  const exempt = EXEMPT[dirName]
  if (exempt !== undefined) {
    console.log(`– ${dirName}: 豁免（${exempt}）`)
    continue
  }
  const result = verifyBundle(bundleDir)
  results.push(result)
  const status = result.ok ? '✓' : '✗'
  const name = result.packageName === undefined ? '?' : result.packageName
  console.log(`${status} ${result.dirName}  [${name}]`)
  for (const line of result.lines) console.log(line)
  for (const problem of result.problems) console.log(`    ✗ ${problem}`)
  for (const warning of result.warnings) console.log(`    · ${warning}`)
  console.log('')
}

const failing = results.filter((result) => !result.ok)
const totalProblems = failing.reduce((sum, result) => sum + result.problems.length, 0)
if (failing.length === 0) {
  console.log(`全部可解析：${results.length} 个 bundle 的 title / description / icon 都能被官方读取器读出（Plugins 页无需回退默认图）。`)
  process.exit(0)
}
console.log(`✗ ${failing.length}/${results.length} 个 bundle 有解析问题（共 ${totalProblems} 项）：${failing.map((result) => result.dirName).join(', ')}`)
process.exit(1)
