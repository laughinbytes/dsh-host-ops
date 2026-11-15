#!/usr/bin/env node
/**
 * verify-presentation.mjs — this repository's own display-identity check.
 *
 * Why this exists: an independently published plugin owns its identity (package name,
 * row id, locale title/description, icon, detail docs). It must not depend on another
 * repository's canonical table. This script checks the local files only; the official
 * `verify-plugin-meta.mjs` separately proves the reader resolves them the way the
 * Plugins page does.
 *
 * It does not duplicate dsh-dev's full naming audit (canonical title table, icon palette):
 * those are for plugins owned by dsh-dev. Here the source of truth is `package.json` +
 * `locale/*.json` + `cordis.patch.yml`.
 *
 * @module verify-presentation
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const problems = []
const check = (ok, label) => { if (!ok) problems.push(label) }
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

const pkg = readJson('package.json')
const en = readJson('locale/en.json')
const zh = readJson('locale/zh.json')
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

check(pkg.name === 'dsh-host-ops', 'package name is dsh-host-ops (not @local/...)')
check(pkg.private !== true, 'package is publishable (private is not true)')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch is ./cordis.patch.yml')
check(exists('cordis.patch.yml'), 'cordis.patch.yml exists')
check(/^\s*-\s*insert:\s*$/m.test(patch) && /^\s*-\s*id:\s*host-ops\s*$/m.test(patch),
  'bundle patch inserts row id host-ops')
check(pkg.icon === './icon.svg' && exists('icon.svg'), 'icon.svg is declared and exists')
check(!/currentColor/i.test(fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8')),
  'icon.svg does not use currentColor')

for (const [lang, locale] of [['en', en], ['zh', zh]]) {
  check(typeof locale.meta?.title === 'string' && locale.meta.title.trim() !== '',
    `locale/${lang} meta.title is non-empty`)
  check(typeof locale.meta?.description === 'string' && locale.meta.description.trim() !== '',
    `locale/${lang} meta.description is non-empty`)
  check(locale.meta?.description.length <= 200,
    `locale/${lang} meta.description is <=200 chars`)
}
check(en.meta?.detail === 'docs/detail.md', 'locale/en meta.detail = docs/detail.md')
check(zh.meta?.detail === 'docs/detail.zh.md', 'locale/zh meta.detail = docs/detail.zh.md')
check(exists('docs/detail.md') && exists('docs/detail.zh.md'), 'both detail documents exist')
check(exists('docs/detail-hero.svg'), 'detail hero exists')
check(exists('README.md') && exists('README.zh.md'), 'bilingual READMEs exist')
check(exists('LICENSE'), 'LICENSE exists')
check(exists('lib/index.js'), 'lib/index.js exists')
check(pkg.exports?.['.'] === './lib/index.js', 'exports["."] = ./lib/index.js')
check(pkg.exports?.['./package.json'] === './package.json', 'exports includes ./package.json')
check(pkg.exports?.['./locale/*.json'] === './locale/*.json', 'exports includes ./locale/*.json')

const included = (file) => (pkg.files ?? []).some((pattern) => {
  if (pattern === file) return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(file)
})
for (const file of [
  'CHANGELOG.md',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'lib/index.js',
  'cordis.patch.yml',
  'docs/detail.md',
  'docs/detail.zh.md',
  'docs/detail-hero.svg',
]) check(included(file), `files includes ${file}`)

if (problems.length > 0) {
  console.error('✗ presentation problems:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('presentation ok: local identity files (package/locale/icon/detail) are consistent')
