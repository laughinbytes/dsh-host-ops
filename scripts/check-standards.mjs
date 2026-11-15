#!/usr/bin/env node
/**
 * check-standards.mjs — fail when the vendored official standards are not exactly
 * the reviewed version recorded in `scripts/standards.lock.json`.
 *
 * Two layers:
 *   1. local: every vendored file's SHA-256 matches the lock;
 *   2. upstream (only when a dsh-dev checkout is available): the same files and the
 *      DSH baseline version in `docs/spec-matrix.md` still match the lock.
 *
 * The second layer is the anti-drift alarm: when the official checkers or their DSH
 * baseline change, `npm test` fails and tells you to sync + review, instead of
 * silently checking against an outdated copy. CI has no dsh-dev checkout, so it
 * verifies the lock only (layer 1).
 *
 * Usage:
 *   node scripts/check-standards.mjs
 *   node scripts/check-standards.mjs --source ../dsh-dev
 *   node scripts/check-standards.mjs --local          # skip the upstream comparison
 *
 * Exit codes: 0 = match; 1 = drift or missing file; 2 = usage/IO error.
 *
 * @module check-standards
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

/**
 * Parse arguments.
 * @param argv - Arguments after the script name.
 * @returns Parsed options.
 */
function parseArgs(argv) {
  const options = { source: undefined, local: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--local') options.local = true
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
 * SHA-256 of a file, hex encoded.
 * @param file - Absolute path.
 * @returns Digest.
 */
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Current dsh-dev commit, or null when unavailable.
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
 * @returns Version string, or null.
 */
function readDshVersion(source) {
  const matrix = path.join(source, 'docs', 'spec-matrix.md')
  if (!fs.existsSync(matrix)) return null
  const match = fs.readFileSync(matrix, 'utf8').match(/版本基线：\*\*DSH\s+([^*]+)\*\*/)
  return match === null ? null : match[1].trim()
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/check-standards.mjs [--source <dsh-dev-dir>] [--local]')
    return
  }

  if (!fs.existsSync(LOCK)) throw new Error(`missing ${path.relative(ROOT, LOCK)}; run npm run sync:standards`)
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
  if (lock.schema !== 'dsh-standards-lock/1' || typeof lock.files !== 'object' || lock.files === null) {
    throw new Error('standards.lock.json has an unexpected shape; re-run npm run sync:standards')
  }

  const problems = []

  // Layer 1: the local copy must match the reviewed lock.
  for (const [rel, expected] of Object.entries(lock.files)) {
    const file = path.join(ROOT, rel)
    if (!fs.existsSync(file)) {
      problems.push(`missing: ${rel}`)
      continue
    }
    const actual = sha256(file)
    if (actual !== expected) problems.push(`changed: ${rel} (lock ${expected.slice(0, 12)}…, local ${actual.slice(0, 12)}…)`)
  }

  // Layer 2: upstream drift alarm (local development only).
  const source = path.resolve(options.source ?? process.env.DSH_DEV_DIR ?? DEFAULT_SOURCE)
  if (!options.local && fs.existsSync(source) && fs.statSync(source).isDirectory()) {
    for (const [rel, expected] of Object.entries(lock.files)) {
      const file = path.join(source, rel)
      if (!fs.existsSync(file)) {
        problems.push(`upstream removed: ${rel}`)
        continue
      }
      if (sha256(file) !== expected) problems.push(`upstream changed: ${rel}`)
    }

    const upstreamVersion = readDshVersion(source)
    if (lock.source?.dshVersion && upstreamVersion && lock.source.dshVersion !== upstreamVersion) {
      problems.push(`DSH baseline changed: lock ${lock.source.dshVersion}, dsh-dev ${upstreamVersion}`)
    }

    const head = gitHead(source)
    if (head && lock.source?.commit && head !== lock.source.commit) {
      console.log(`note: dsh-dev HEAD moved (${lock.source.commit.slice(0, 7)} → ${head.slice(0, 7)}); vendored files are compared above`)
    }
  } else if (!options.local) {
    console.log('note: dsh-dev checkout not found; verified the local lock only')
  }

  if (problems.length > 0) {
    console.error('standards drift detected:')
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    console.error('')
    console.error('Fix: run `npm run sync:standards`, review the diff, then re-run the tests.')
    console.error('Do not hand-edit the vendored checkers; the lock is the provenance record.')
    process.exit(1)
  }

  console.log(`standards ok: ${Object.keys(lock.files).length} file(s), DSH ${lock.source?.dshVersion ?? 'unknown'}, dsh-dev ${(lock.source?.commit ?? 'unknown').slice(0, 7)}`)
}

try {
  main()
} catch (error) {
  console.error(`check-standards: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
