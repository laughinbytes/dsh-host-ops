# Changelog

All notable changes to `dsh-host-ops` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-11-16

Tooling/packaging release: **no runtime behavior change**. Only the repository's presentation
check and development scripts changed; `lib/index.js` is unchanged.

### Changed

- **Presentation identity is repo-owned** — removed the vendored dsh-dev
  `audit-plugin-presentation.mjs` and its canonical-table dependency; added
  `scripts/verify-presentation.mjs` and kept the generic `verify-plugin-meta.mjs`. `npm test`
  now checks this repository's own package/locale/icon/detail identity. dsh-dev no longer
  registers this independently published repo in its canonical table.
- **Standards are pinned, not chased** — `npm test` verifies the local lock only
  (`check-standards.mjs --local`); `npm run check:standards:upstream` is the explicit review
  step. The vendored `verify-plugin-meta.mjs` stays pinned to dsh-dev `8f01fdb` because later
  dsh-dev revisions make it workspace-specific (`scripts/registry.json`).

## [0.2.0] — 2026-11-15

Behavior release: sensitive config writes are refused and read masking is unified. This is a
runtime behavior change; publish only after G2 staging.

### Changed

- **Sensitive config writes are refused** — detection is schema-first: `meta.role: "secret"`
  is sensitive regardless of the field name; `meta.role: "credential-ref"` (e.g. `apiKeyEnv`)
  is explicitly a reference and stays allowed; a missing schema/role falls back to a narrow
  field-name rule. The same resolver drives write blocking and display masking; value contents
  are never inspected. Writes that add or change a sensitive value are rejected (including
  inherited values a complete override would pin into the profile). `reset`/`revert` follow
  the same rule; removing a secret or leaving it unchanged is allowed. Use
  Settings/credentials or a `${credential:...}` reference instead. This is a deliberate
  privacy/safety behavior change, not a bug fix.
- **`get` masks sensitive values** — the read action now returns masked values for `effective`,
  `override` and `inherited`, matching previews/receipts/audit/history. Raw secrets are no
  longer echoed into a tool result.
- **Optional-service policy documented** — the three required services stay in `inject`; the
  other seven remain guarded `ctx.get` lookups so a reduced profile loses only the affected
  action, not the whole plugin. Recorded as a reviewed exception in `docs/development.md`.

## [0.1.2] — 2026-11-15

Patch release: **no runtime behavior change** (documentation, tool description, and the
development gate only). This is the next npm release after 0.1.0; the 0.1.1 git tag was not
published separately.

### Changed

- **Audit wording matches behavior** — the plugin page, READMEs and the
  `dsh_config_manage` description now say the audit log is runtime-scoped (cleared when the
  plugin reloads) and that every write leaves a receipt with the original values (sensitive
  fields masked) and recovery steps. Persisting the audit is deferred (backlog B1); the previous “revert it later” page
  copy overstated what the implementation does.
- **Full test gate** — `npm test` now runs the two host suites, the compliance checker, the
  official presentation/meta checks, and the standards lock check. Previously it only ran the
  compliance checker.
- **Standards provenance** — the vendored official checkers are recorded in
  `scripts/standards.lock.json`; `npm run sync:standards` updates them and
  `npm run check:standards` fails when the local copy or the dsh-dev baseline drifts.

### Compatibility

- `peerDependencies` for `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-workspace` now use
  `>=0.2.1-rc.2 || >=0.2.2-rc.1`, matching `engines.dsh` and the tested `0.2.2-rc.3`
  prerelease (the old `^0.2.0-rc.2` range excluded 0.2.2 prereleases).

## [0.1.1] — 2026-11-14

Patch release: **no runtime behavior change**.

### Changed

- **Dependency contract** — `sessionQuery` is now read directly as `ctx.sessionQuery`,
  matching the required service already declared in `inject`. The contradictory
  `ctx.get('sessionQuery')` fallback is gone; the preset-read path still falls back to
  `header.agentPreset` when the projection is unreadable.
- **Compliance gate** — vendored the plugin compliance checker
  (`scripts/check-plugin-compliance.mjs` and `scripts/fixtures/compliance/`) and wired it
  into `npm test` as `test:compliance` (`--strict`, `A=0 B=0`). The existing host suites
  remain under `test:host`. These scripts are development-only and are not part of the
  published package.

## [0.1.0] — 2026-11-10

- Initial public release.
