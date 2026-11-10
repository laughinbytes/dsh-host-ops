# Release status (2026-11-09)

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
