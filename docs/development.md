# Development and release

## Test suites

```bash
node scripts/verify-dsh-host-ops.mjs         # logic suite (fake DSH services), 404 checks
node scripts/verify-dsh-host-ops-schema.mjs  # schema suite (real @deepseek-ai/dsh-tools), 64 checks
```

The logic suite stubs the DSH services and the in-process event bus; the schema suite compiles
the three tool definitions with the real `@deepseek-ai/dsh-tools`/schemastery packages extracted
from the installed DSH app (macOS), so it needs DSH installed.

## Compliance gate

`npm test` is the single local gate. It runs, in order:

1. the two host suites above;
2. `check-plugin-compliance.mjs --root . --strict` (spec-matrix A/B rules);
3. the official presentation/meta checks (`audit-plugin-presentation.mjs`,
   `verify-plugin-meta.mjs`);
4. `check-standards.mjs`, which verifies the vendored checkers against
   `scripts/standards.lock.json`.

The official checkers are **vendored, not hand-written**. `scripts/standards.lock.json` records
the dsh-dev commit, the DSH baseline version, and the SHA-256 of every vendored file. When
dsh-dev changes its checkers or its DSH baseline:

```bash
npm run sync:standards    # copy the new checkers and rewrite the lock
git diff scripts/         # review what changed
npm test                  # re-run everything
```

`check-standards.mjs` fails until that sync happens; do not edit the vendored checkers by hand.
On a machine without a dsh-dev checkout (CI), it verifies the local lock only.

Known advisory finding: the compliance checker reports two C-level `R-EVT-04` entries
(`wait` and `notify` subscribe to `session/event` for one-shot side effects, not for derived
state). A/B are the blocking levels; the C entries are reviewed and intentionally kept.

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
