# Changelog

All notable changes to `dsh-host-ops` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
