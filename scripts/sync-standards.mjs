#!/usr/bin/env node
/**
 * sync-standards.mjs — copy the official DSH plugin standards checkers from dsh-dev
 * and record exactly what was copied in `scripts/standards.lock.json`.
 *
 * Why this exists: the checkers are the executable form of the official standards
 * (docs/spec-matrix.md + docs/08 + docs/11). Keeping a hand-copied version without
 * provenance makes the repo drift silently whenever dsh-dev changes. This script is
 * the only sanctioned way to update the vendored copies; `check-standards.mjs`
 * fails when the copy and the lock disagree, or when upstream has moved.
 *
 * Usage:
 *   node scripts/sync-standards.mjs
 *   node scripts/sync-standards.mjs --source ../dsh-dev
 *   DSH_DEV_DIR=../dsh-dev node scripts/sync-standards.mjs
 *
 * Exit codes: 0 = synced; 2 = usage/IO error.
 *
 * @module sync-standards
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOCK = path.join(HERE, 'standards.lock.json')
const DEFAULT_SOURCE = path.join(os.homedir(), 'Documents', 'deepseek-harness', 'dsh-dev')

/** Files copied verbatim from dsh-dev. Fixtures are discovered below. */
const FIXED_FILES = [
  'scripts/check-plugin-compliance.mjs',
  'scripts/verify-plugin-meta.mjs',
]

/**
 * Parse `--source <dir>` and `--help`.
 * @param argv - Arguments after the script name.
 * @returns Parsed options.
 */
function parseArgs(argv) {
  const options = { source: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--source') {
      options.source = argv[index + 1]
      index += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * List regular files below a directory, using POSIX separators.
 * @param dir - Absolute directory.
 * @returns Relative paths.
 */
function walkFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const nested of walkFiles(absolute)) files.push(path.posix.join(entry.name, nested))
    } else if (entry.isFile()) {
      files.push(entry.name)
    }
  }
  return files.sort()
}

/**
 * SHA-256 of a file, hex encoded.
 * @param file - Absolute path.
 * @returns Digest.
 */
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Current dsh-dev commit, or null when the source is not a git checkout.
 * @param source - dsh-dev directory.
 * @returns Commit hash.
 */
function gitHead(source) {
  try {
    return execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * Read the DSH version baseline from dsh-dev's spec matrix.
 * @param source - dsh-dev directory.
 * @returns Version string, or null when the baseline is not found.
 */
function readDshVersion(source) {
  const matrix = path.join(source, 'docs', 'spec-matrix.md')
  if (!fs.existsSync(matrix)) return null
  const text = fs.readFileSync(matrix, 'utf8')
  const match = text.match(/版本基线：\*\*DSH\s+([^*]+)\*\*/)
  return match === null ? null : match[1].trim()
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/sync-standards.mjs [--source <dsh-dev-dir>]')
    return
  }

  const source = path.resolve(options.source ?? process.env.DSH_DEV_DIR ?? DEFAULT_SOURCE)
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`dsh-dev source not found: ${source}\nPass --source <dir> or set DSH_DEV_DIR.`)
  }

  const fixtureDir = path.join(source, 'scripts', 'fixtures', 'compliance')
  const fixtures = fs.existsSync(fixtureDir)
    ? walkFiles(fixtureDir).map((rel) => path.posix.join('scripts/fixtures/compliance', rel))
    : []
  const files = [...FIXED_FILES, ...fixtures]

  for (const rel of files) {
    if (!fs.existsSync(path.join(source, rel))) throw new Error(`missing upstream file: ${rel}`)
  }

  for (const rel of files) {
    const target = path.join(ROOT, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, rel), target)
  }

  const lock = {
    schema: 'dsh-standards-lock/1',
    source: {
      repo: 'dsh-dev',
      commit: gitHead(source),
      dshVersion: readDshVersion(source),
      syncedAt: new Date().toISOString().slice(0, 10),
    },
    files: Object.fromEntries(files.map((rel) => [rel, sha256(path.join(ROOT, rel))])),
  }
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`)

  console.log(`synced ${files.length} file(s) from ${source}`)
  console.log(`  dsh-dev commit: ${lock.source.commit ?? '(not a git checkout)'}`)
  console.log(`  DSH baseline:   ${lock.source.dshVersion ?? '(not found in docs/spec-matrix.md)'}`)
  console.log(`  lock:           ${path.relative(ROOT, LOCK)}`)
}

try {
  main()
} catch (error) {
  console.error(`sync-standards: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
