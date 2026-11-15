# Release status (2026-11-09)

> **2026-11-15 status:** npm `latest` and `next` are both **0.2.0**. The daily Desktop profile
> is on 0.2.0 and passed the read/refusal dogfood. Git tag `v0.2.0` is pushed.

## 0.2.0 (published, 2026-11-15)

Behavior release: sensitive config writes are refused and read masking is unified.

- [x] **Sensitive config writes refused**: schema-first detection (`meta.role: "secret"`),
      `credential-ref` (e.g. `apiKeyEnv`) explicitly allowed, and a narrow field-name fallback
      when the schema has no role. `set`/`reset`/`revert` reject additions/changes, including
      inherited values pinned by a complete override; removal/unchanged values are allowed.
- [x] **`get` masks sensitive values**: `effective`/`override`/`inherited` are masked by the
      same schema+name resolver, so raw secrets no longer enter a tool result. The live
      `cordis_inspect_query` schema exposes `x-cordis.role` (`secret` / `credential-ref`) and
      the runtime schemastery schema exposes the same `meta.role` (verified on
      `dsh-web-search-deepseek`).
- [x] **Optional-service policy documented**: required services stay in `inject`; the other
      seven remain guarded `ctx.get` lookups; recorded as a reviewed exception in
      [`development.md`](./development.md#reviewed-policy-decisions).
- [x] `npm test`: 413/413 logic, 64/64 schema, A=0/B=0/C=2, presentation/meta pass,
      standards lock pass.
- [x] Version bump: `0.2.0`; CHANGELOG/README/tool page updated; tarball
      `dsh-host-ops-0.2.0.tgz` (13 files, 74 kB).
- [x] G1: clean `npm install` of the 0.2.0 tarball in an empty directory; `node --check` OK.
- [x] G2 (composition): installed the 0.2.0 tarball into an isolated staging profile
      (`DSH_HOME=/tmp/host-ops-staging-home`, created from the shipped `web` template);
      `dsh --profile staging --dump-config` shows the `host-ops` row and the profile registers
      `dsh-host-ops` from the tarball. Full runtime core-flow was not executed in staging
      because the isolated home has no model credentials.
- [x] G1.5: **N/A** — no new plugin-written startup document; config writes still use the
      official `configEditor.edit()`.
- [x] G2.5: same DSH `0.2.2-rc.3`; the 0.2.2-rc.1 → rc.3 review/ack still applies.
- [x] Publish `--tag next`: `dsh-host-ops@0.2.0`, integrity
      `sha512-K7Ak4ZnJsqJiXvktwFrBefWQusMkk5+YCKdy12mJ4JIuzMqSLAnUVMFfJMjt4xs8FZRVSqnCpMZVVjlWGuzp1g==`.
- [x] Registry install: clean `npm install dsh-host-ops@0.2.0`; version and `node --check` OK.
- [x] Daily profile: 0.1.2 → 0.2.0 via `plugin_manager`; profile dependency is 0.2.0.
- [x] Daily dogfood (read-only): `get` shows the new “敏感字段已掩码” output; `set apiKey` is
      refused with `拒绝写入敏感字段：apiKey`; `set apiKeyEnv` previews normally; a normal
      `host-ops` preview still works. No `apply: true` was used.
- [x] Git tag `v0.2.0` on `13cd3be`, pushed.
- [x] Promote `latest`: registry reports `latest` and `next` = 0.2.0; clean
      `npm install dsh-host-ops@latest` resolves 0.2.0.

## 0.1.2 (published, 2026-11-15)

- [x] Audit wording aligned: plugin page / READMEs / `dsh_config_manage` description now say
      the audit is runtime-scoped and the write receipt is the cross-reload recovery path;
      persistence deferred (backlog B1).
- [x] Full gate: `npm test` = host logic 404/404 + schema 64/64 + compliance A=0/B=0/C=2 +
      presentation/meta pass + standards lock pass.
- [x] Standards provenance: `scripts/standards.lock.json` (dsh-dev `0b04f11`, DSH `0.2.2-rc.3`).
- [x] Pack: 13 files, dev scripts/lock not included.
- [x] Version/peer metadata: `0.1.2`; peers now `>=0.2.1-rc.2 || >=0.2.2-rc.1` (matches
      `engines.dsh` and `0.2.2-rc.3`); README tested-version line updated.
- [x] Tarball `dsh-host-ops-0.1.2.tgz`: 13 files, clean install in an empty directory,
      `lib/index.js` passes `node --check`.
- [x] G2.5 upgrade gate (0.2.2-rc.1 → 0.2.2-rc.3): 6 hits reviewed in
      [`upgrade-review.md`](./upgrade-review.md), `--strict` passes with
      [`upgrade-ack.json`](./upgrade-ack.json); 0 code changes.
- [x] G1.5 cold boot: **N/A for 0.1.2** — the release adds no plugin-written startup
      document; config writes still use the official `configEditor.edit()`. Required when the
      persistent audit ledger (B1) lands.
- [x] G2 staging: **waived for 0.1.2** — docs/description-only patch, host-only (no UI); the
      only runtime delta since 0.1.0 is the 0.1.1 `ctx.sessionQuery` access fix, covered by
      the 64-check schema suite. Do not waive for the next functional release.
- [x] npm publish: `dsh-host-ops@0.1.2`, `next` and `latest` both point at it.
      Integrity `sha512-D4cyvFxFc7Cf/lLhR9iuzgbYle7R7VM4k2mnYHXCEoqBf6ASOtirBNWcBWep/qr5Pe47+hPElTE/dh8sUY4szg==`,
      shasum `cde18005db3d4eb5b00658728416c087969eb931`.
- [x] Registry install: clean `npm install dsh-host-ops@0.1.2` succeeded after a
      `--prefer-online` retry; installed version and peers match; `node --check` passes.
- [x] Daily profile: 0.1.0 → 0.1.2 via `plugin_manager` (`remove_bundle` → `install_bundle`);
      profile dependency and lock show 0.1.2; `dsh_config_manage history` answers after the
      hot replace. pnpm logged a peer-dependency warning (the DSH peers are resolved from the
      installation, not installed as profile dependencies); no action taken.
- [x] Git commit `04db302` + annotated tag `v0.1.2`, pushed to `origin/main`.
- [ ] Rollback command if 0.1.2 misbehaves: remove `dsh-host-ops`, install
      `dsh-host-ops@0.1.0` via `plugin_manager`.

## Done

- [x] Public name decided: `dsh-host-ops` (npm name available; checked 2026-11-09)
- [x] Renamed package, patch row, locale, docs, tests, scripts
- [x] package.json metadata: license MIT, repository/homepage/bugs, keywords, `private` removed
- [x] LICENSE (MIT, laughinbytes)
- [x] README.md (English, release quality) + README.zh.md
- [x] Release scanner fixed to audit **published files only**; current result: `WARN` (0 FAIL, 0 hard secrets, 0 hard paths)
- [x] `npm pack` verified: 9 files / ~68 kB (no tests or docs in the package)
- [x] Tests pass from the repository: 404/404 logic + 64/64 schema
- [x] GitHub public repo created and pushed: https://github.com/laughinbytes/dsh-host-ops (topics: dsh-plugin, dsh, deepseek-harness, agent, workspace, session, configuration)

## Pending

- [ ] npm publish `dsh-host-ops@0.1.0` — **blocked on npm login** (account not authenticated on this machine)
- [ ] Optional: screenshots/demo image (only affects awesome/market visibility)
- [ ] Optional: awesome-dsh-plugin submission (repo must be ≥1 day old; low priority per plan)
- [ ] Optional: post to DSH Discussions "Show Your Plugins" + X
- [x] Migrated the live profile to this repository via `link:` (bundle `dsh-host-ops`, row `host-ops`); old `@local/dsh-workbench` bundle removed
- [x] Registered this directory as its own DSH workspace (`dsh-host-ops`); staging copy archived; old local plugin dir archived (backup: `/tmp/dsh-workbench-2026-11-09.tar.gz`)
- [x] Official presentation alignment: locale en/zh value-oriented copy, icon slug-prefixed gradients, config schema enum dropdown (`approval`), English field descriptions, row id `host-ops`

## Scanner notes

- `A5 schemastery peer` WARN is a heuristic false positive: `@deepseek-ai/schemastery` is a stable 3.x peer, no prerelease branch needed.
- `C3b screenshots` WARN: the plugin has no UI; a demo image is optional.

## Install policy for our own daily use

- **Now (pre-release, active development):** `link:` to this repository — the live plugin reads
  this repo directly, so edits + reload are instant and there is exactly one source copy.
- **After the npm release:** switch the daily plugin to the **npm package** and update it via
  the Plugins page. That dogfoods the artifact users actually install.
- **While developing the next version after that:** temporarily re-link for manual verification,
  or (preferred) verify with the two test suites plus a scratch install of the packed tarball;
  do not leave an uncommitted/broken working tree as the daily install.

## Plugin page presentation (2026-11-10)

The Plugins page does **not** render README: it renders the plugin's *detail document*, chosen by
the official `dsh-plugin-detail` order — localized `locale/<lang>.json` `meta.detail` first,
package README second. We now ship:

- `docs/detail.md` (English) and `docs/detail.zh.md` (Chinese), declared via `meta.detail` in
  `locale/en.json` / `locale/zh.json`;
- `docs/detail-hero.svg`, a product-preview illustration referenced by both documents;
- README/README.zh stay as the GitHub/npm developer documentation.

The page is designed like official product pages: icon/title/description from locale metadata,
a preview image, concise benefit-oriented sections, no long technical tables.

## Published (2026-11-10)

- **npm**: `dsh-host-ops@0.1.0` published; `latest` = 0.1.0. Integrity
  `sha512-GmWg7aMoHtBPCg3dnmmsv5Fkg91DNlSe0f0c6bmbgjaDMh/ZcVMFRLWSp2pzu+GvNvuM00R9lLm09jVIleB9WA==`.
- **Git tag**: `v0.1.0` on commit `9e0528e` (pushed).
- **Clean install verified**: `npm install dsh-host-ops@0.1.0` in an empty directory → 12 files,
  `lib/index.js` passes `node --check`.
- **Daily-use switch**: the Desktop profile now installs `dsh-host-ops@0.1.0` from npm (the
  previous `link:` install was removed); tools verified working.
- **Placeholder cleaned**: the temporary `0.0.0-stage` version was unpublished; the registry now
  lists only `0.1.0` (its `latest`). A historical timestamp entry for the placeholder remains in
  npm's metadata `time` map, which is normal and harmless.
