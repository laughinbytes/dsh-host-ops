#!/usr/bin/env node
/**
 * dsh-asar-extract.mjs — 从 DSH 的 app.asar 里列出或提取文件。
 *
 * 为什么需要它：app.asar 是 asar 归档，不是目录。`ls` / `cat` / `cp` / `rg` /
 * `find` / `node:fs` 读它的内部路径**全部失败**——操作系统层面它只是一个文件。
 * 本脚本把 asar 当扁平文件，解析归档头部拿到每个条目的偏移，再按偏移读字节，
 * 因此不需要 Electron、也不需要任何第三方依赖。
 *
 * 归档格式（本脚本依赖并自检的部分）：
 *   偏移 0  : uint32  = 4                      外层 pickle 的载荷长度
 *   偏移 4  : uint32  = header pickle 总长度     ← 数据区起点 = 8 + 该值
 *   偏移 8  : uint32  = header pickle 载荷长度
 *   偏移 12 : uint32  = 头部 JSON 字符串长度
 *   偏移 16 : UTF-8 JSON 头部（内含每个条目的 size 与相对数据区偏移）
 *
 * 三类条目：
 *   1. 普通条目       —— 带数字 offset，从归档体内按偏移读。
 *   2. `unpacked:true` —— 实体被放在 `<archive>.unpacked/<路径>`，归档体内没有数据。
 *                        本机 12973 个条目里有 1493 个属于此类，直接从并列目录复制。
 *   3. `link`          —— 符号链接，重建为软链。
 *
 * 用法：
 *   node dsh-asar-extract.mjs list    [pattern] [--archive PATH]
 *   node dsh-asar-extract.mjs extract [pattern] [--out DIR] [--strip PREFIX] [--archive PATH]
 *   node dsh-asar-extract.mjs info    [--archive PATH]
 *
 * pattern 是对"去掉前导斜杠的归档内路径"做匹配的正则，例如 'dsh-tool-todo/.*\\.js$'。
 * 省略 pattern 时匹配全部。
 *
 * @module dsh-asar-extract
 */

import fs from 'node:fs'
import path from 'node:path'

/** 默认归档路径：桌面端 DSH 的 app.asar。 */
const DEFAULT_ARCHIVE = process.env.DSH_ASAR
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/**
 * 解析归档头部，返回文件描述符、数据区起点与条目表。
 * @param archive - app.asar 的绝对路径。
 * @returns 归档句柄；调用方负责 close。
 */
function openArchive(archive) {
  const fd = fs.openSync(archive, 'r')

  const prefix = Buffer.alloc(16)
  if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error(`asar: ${archive} too short`)

  const pickleSize = prefix.readUInt32LE(4)
  const stringSize = prefix.readUInt32LE(12)
  const dataStart = 8 + pickleSize

  // 自检：数据区起点必须正好落在"16 + 头部字符串按 4 字节对齐后"的位置。
  // 头部布局一旦变化就立刻失败，而不是静默地把文件读偏几个字节。
  const padded = stringSize + ((4 - (stringSize % 4)) % 4)
  if (dataStart !== 16 + padded) {
    throw new Error(
      `asar: unexpected header layout (dataStart=${dataStart}, expected=${16 + padded}); `
      + 'refusing to extract shifted bytes',
    )
  }

  const json = Buffer.alloc(stringSize)
  fs.readSync(fd, json, 0, stringSize, 16)

  return { fd, dataStart, header: JSON.parse(json.toString('utf8')) }
}

/**
 * 深度优先展开条目表。
 * @param node - 当前目录节点。
 * @param prefix - 已累积的路径前缀（不含前导斜杠）。
 * @returns 扁平化的 [归档内路径, 元数据] 列表。
 */
function flatten(node, prefix = '') {
  const out = []
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (value.files) out.push(...flatten(value, full))
    else out.push([full, value])
  }
  return out
}

/**
 * 把归档内路径映射为安全的磁盘路径。
 * @param outDir - 输出根目录。
 * @param archivePath - 去掉前导斜杠的归档内路径。
 * @param strip - 需要剥离的路径前缀（可选）。
 * @returns 绝对目标路径；被 strip 过滤掉时返回 undefined。
 */
function destination(outDir, archivePath, strip) {
  let relative = archivePath
  if (strip) {
    if (!relative.startsWith(strip)) return undefined
    relative = relative.slice(strip.length).replace(/^\/+/, '')
  }
  if (relative === '') return undefined
  const target = path.resolve(outDir, relative)
  const root = path.resolve(outDir)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`asar: refusing to write outside output dir: ${archivePath}`)
  }
  return target
}

/**
 * 把一个条目写到磁盘。
 * @param fd - 归档文件描述符。
 * @param dataStart - 归档数据区起点。
 * @param archive - 归档路径（用于定位并列的 `.unpacked` 目录）。
 * @param full - 归档内路径（原始，未 strip）。
 * @param meta - 条目元数据。
 * @param target - 目标磁盘路径。
 * @returns `written` 或 `skipped`。
 */
function writeEntry(fd, dataStart, archive, full, meta, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })

  if (typeof meta.link === 'string') {
    fs.rmSync(target, { force: true })
    fs.symlinkSync(meta.link, target)
    return 'written'
  }

  if (meta.unpacked === true) {
    // 实体不在归档体内，而在并列的 <archive>.unpacked/<路径>。
    const external = path.join(`${archive}.unpacked`, full)
    if (!fs.existsSync(external)) return 'skipped'
    fs.copyFileSync(external, target)
    return 'written'
  }

  const offset = Number(meta.offset)
  const size = Number(meta.size)
  if (!Number.isFinite(offset) || !Number.isFinite(size)) return 'skipped'

  const buffer = Buffer.alloc(size)
  if (size > 0) fs.readSync(fd, buffer, 0, size, dataStart + offset)
  fs.writeFileSync(target, buffer)
  return 'written'
}

/**
 * 解析命令行参数。
 * @param argv - process.argv.slice(2)。
 * @returns 归一化后的选项。
 */
function parseArgs(argv) {
  const options = { command: undefined, pattern: undefined, out: undefined, strip: undefined, archive: DEFAULT_ARCHIVE }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') options.out = argv[++i]
    else if (arg === '--strip') options.strip = argv[++i]
    else if (arg === '--archive') options.archive = argv[++i]
    else if (arg === '-h' || arg === '--help') options.command = 'help'
    else rest.push(arg)
  }
  if (options.command === undefined) options.command = rest.shift() ?? 'help'
  options.pattern = rest.shift()
  return options
}

function usage() {
  console.log(`Usage:
  node dsh-asar-extract.mjs list    [pattern] [--archive PATH]
  node dsh-asar-extract.mjs extract [pattern] [--out DIR] [--strip PREFIX] [--archive PATH]
  node dsh-asar-extract.mjs info    [--archive PATH]

  pattern  正则，匹配去掉前导斜杠的归档内路径（省略 = 全部）
  --out    提取输出目录（默认 ./reference/extracted）
  --strip  提取前剥离的路径前缀
  --archive  归档路径（默认 $DSH_ASAR 或桌面端 app.asar）

Examples:
  node dsh-asar-extract.mjs list 'dsh-tool-todo/'
  node dsh-asar-extract.mjs extract 'dsh-persona/(package\\.json|lib/index\\.js)$' --out /tmp/peek`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.command === 'help') {
    usage()
    return
  }
  if (!fs.existsSync(options.archive)) {
    console.error(`asar not found: ${options.archive}`)
    process.exit(2)
  }

  const { fd, dataStart, header } = openArchive(options.archive)
  try {
    const entries = flatten(header)

    if (options.command === 'info') {
      const unpacked = entries.filter(([, meta]) => meta.unpacked === true).length
      const packed = entries.length - unpacked
      const bytes = entries.reduce((sum, [, meta]) => sum + (Number(meta.size) || 0), 0)
      console.log(JSON.stringify({
        archive: options.archive,
        entries: entries.length,
        packedEntries: packed,
        unpackedEntries: unpacked,
        totalBytes: bytes,
        dataStart,
      }, null, 2))
      return
    }

    const matcher = options.pattern ? new RegExp(options.pattern) : undefined
    const matched = entries.filter(([full]) => !matcher || matcher.test(full))

    if (options.command === 'list') {
      for (const [full, meta] of matched) {
        const tag = meta.unpacked === true ? '\t[unpacked]' : meta.link !== undefined ? '\t[link]' : ''
        console.log(`/${full}\t${meta.size ?? '-'}${tag}`)
      }
      console.error(`# ${matched.length} of ${entries.length} entries`)
      return
    }

    if (options.command === 'extract') {
      const outDir = path.resolve(options.out ?? 'reference/extracted')
      let written = 0
      let skipped = 0
      const skippedPaths = []
      for (const [full, meta] of matched) {
        const target = destination(outDir, full, options.strip)
        if (target === undefined) { skipped++; continue }
        if (writeEntry(fd, dataStart, options.archive, full, meta, target) === 'written') written++
        else { skipped++; skippedPaths.push(full) }
      }
      console.error(`# wrote ${written} file(s) to ${outDir}${skipped ? `, skipped ${skipped}` : ''}`)
      for (const missed of skippedPaths.slice(0, 10)) console.error(`#   skipped: /${missed}`)
      if (skippedPaths.length > 10) console.error(`#   … and ${skippedPaths.length - 10} more`)
      return
    }

    usage()
    process.exit(2)
  } finally {
    fs.closeSync(fd)
  }
}

main()
