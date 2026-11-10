# Development and release

## Test suites

```bash
node scripts/verify-dsh-host-ops.mjs         # logic suite (fake DSH services), 404 checks
node scripts/verify-dsh-host-ops-schema.mjs  # schema suite (real @deepseek-ai/dsh-tools), 64 checks
```

The logic suite stubs the DSH services and the in-process event bus; the schema suite compiles
the three tool definitions with the real `@deepseek-ai/dsh-tools`/schemastery packages extracted
from the installed DSH app (macOS), so it needs DSH installed.

## Repository layout

```text
lib/index.js            host-side tools (single file, no client half)
cordis.patch.yml        bundle patch (inserts the host-ops row)
locale/                 en/zh tool descriptions
scripts/                the two verification suites + asar extractor helper
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
