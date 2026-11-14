# Changelog

All notable changes to `dsh-host-ops` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
