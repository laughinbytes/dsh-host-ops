# Development and release

## Test suites

```bash
node scripts/verify-dsh-host-ops.mjs         # logic suite (fake DSH services), 413 checks
node scripts/verify-dsh-host-ops-schema.mjs  # schema suite (real @deepseek-ai/dsh-tools), 64 checks
```

The logic suite stubs the DSH services and the in-process event bus; the schema suite compiles
the three tool definitions with the real `@deepseek-ai/dsh-tools`/schemastery packages extracted
from the installed DSH app (macOS), so it needs DSH installed.

## Compliance gate

`npm test` is the single local gate. It runs, in order:

1. the two host suites above;
2. `check-plugin-compliance.mjs --root . --strict` (spec-matrix A/B rules);
3. the repository's own presentation check (`scripts/verify-presentation.mjs`) plus the
   official `verify-plugin-meta.mjs` reader check;
4. `check-standards.mjs`, which verifies the vendored checkers against
   `scripts/standards.lock.json`.

This is an independently published repository, so it owns its display identity and is **not**
registered in dsh-dev's canonical table. The `audit-plugin-presentation.mjs` checker is
dsh-dev-internal; this repo uses its own `verify-presentation.mjs` plus the generic
`verify-plugin-meta.mjs`. Only the generic checkers are vendored.

The vendored checkers are **not hand-written**. `scripts/standards.lock.json` records
the dsh-dev commit, the DSH baseline version, and the SHA-256 of every vendored file. When
dsh-dev changes its checkers or its DSH baseline:

```bash
npm run sync:standards    # copy the new checkers and rewrite the lock
git diff scripts/         # review what changed
npm test                  # re-run everything
```

`npm test` verifies the **local lock only** (`check-standards.mjs --local`), so unrelated work in
the dsh-dev checkout cannot turn this repository red. Upstream review is explicit:
`npm run check:standards:upstream` compares the lock with dsh-dev; `npm run sync:standards`
updates the vendored copies only after that review. Do not edit the vendored checkers by hand.

The vendored `verify-plugin-meta.mjs` is pinned to dsh-dev `8f01fdb`. Later dsh-dev revisions
may make it workspace-specific (the 2026-11-16 revision started reading a generated
`scripts/registry.json`), so do **not** sync it blindly; adapt or freeze it deliberately.

Known advisory finding: the compliance checker reports two C-level `R-EVT-04` entries
(`wait` and `notify` subscribe to `session/event` for one-shot side effects, not for derived
state). A/B are the blocking levels; the C entries are reviewed and intentionally kept.

## Reviewed policy decisions

- **Optional services stay on `ctx.get`** — the plugin declares only `tools`,
  `workspaceRegistry` and `sessionQuery` in `inject`; `sessionController`, `sessions`,
  `agents`, `sessionTitle`, `sessionProjections`, `configEditor` and `approval` are looked up
  with `ctx.get` and guarded at the call site. This keeps one missing service from disabling
  every tool in a reduced profile; the official Host Service contract supports optional access
  this way. This is a deliberate exception to the simplified "optional services go in
  inject/ctx.inject" wording in `docs/11`; do not move them without testing a reduced profile.
- **Sensitive detection is schema-first** — the same resolver is used for write blocking and
  display masking. A schema `meta.role: "secret"` field is sensitive regardless of its name;
  `meta.role: "credential-ref"` (e.g. `apiKeyEnv`) is explicitly not secret. When the schema
  is missing or has no role, a narrow field-name rule (`apiKey`, `token`, `password`, …) is
  the fallback. The tool never inspects value contents. Writes that add or change a sensitive
  value are refused before preview/approval, including inherited values that a complete
  override would pin into the profile; removing a secret or leaving it unchanged is allowed.
  `get`, previews, receipts and audit mask the same paths.

## Repository layout

```text
lib/index.js            host-side tools (single file, no client half)
cordis.patch.yml        bundle patch (inserts the host-ops row)
locale/                 en/zh tool descriptions
scripts/                verification suites, vendored standards checkers + lock/sync helpers
docs/                   governance, error-handling discipline, release status
```

## Install policy for daily use

- **Pre-release / active development:** install with `link:` to this repository so the live
  plugin reads the repo directly (one source copy, instant reload after edits).
- **After the npm release:** switch the daily plugin to the npm package and update through the
  Plugins page, so daily use matches what users install.
- **Developing the next version:** run both test suites first; for manual verification either
  temporarily re-link, or verify a packed tarball (`npm pack`) in a scratch profile. Do not
  leave a broken working tree as the daily install.

## Release scanning

`inbox/dsh-engage/scripts/release-audit.mjs` (outside this repo) audits the files that
`npm pack` would actually publish for secrets, absolute paths and metadata; current result:
`WARN` with no FAIL findings.
