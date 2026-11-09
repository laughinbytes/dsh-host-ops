**Host-side operations for DSH agents** — workspaces, sessions, and governed configuration changes.
Tools only: no UI, no client bundle, no direct filesystem writes.

> Unofficial community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
> Not affiliated with or endorsed by DeepSeek. "DeepSeek Harness" belongs to its respective owners.


## Why this plugin

An agent driving DSH can already read files and run commands, but it cannot normally
*operate DSH itself*: organize the sidebar, delegate work to another session and read the
answer back, or change a setting safely. This plugin exposes exactly that surface as three
host-side tools.

- **Organize the workspace/session surface** — list, create, rename, reorder, pin, archive.
- **Delegate across sessions** — start/send/steer/queue, then wait for a reply or a step and
  read only the new events using a cursor.
- **Change DSH configuration with governance** — preview, approval, apply, audit, revert;
  fail-closed, no silent writes.

Everything is implemented on top of DSH's own host services (`workspaceRegistry`,
`sessionController`, `sessionQuery`, `sessionTitle`, `agents`, `configEditor`, `approval`).
The plugin never edits `workspace.json`, session logs, or the profile patch file itself.

## Requirements

| Item | Value |
| --- | --- |
| DSH | `>=0.2.1-rc.2` or `>=0.2.2-rc.1` (tested against `0.2.2-rc.1`) |
| Node | `>=22.19.0` |
| Platform | macOS / Linux (Desktop and headless DSH) |
| Client half | none — this is a host-only plugin |

## Install

Install it as a profile bundle. Once published to npm, add it with DSH's own plugin CLI
(use `desktop` for the Desktop app, `web` for the Web UI):

```bash
dsh plugin --profile desktop add dsh-host-ops
# or, from a DSH checkout: dsh plugin --profile web add dsh-host-ops
```

Before the npm release, install straight from GitHub:

```bash
dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"
```

You can also use the **Plugins** page: **Add plugin** installs from an npm package name or a
Git-hosted spec. The official `@deepseek-ai/*` peer dependencies are resolved from your DSH
installation — do not install them yourself. After enabling the bundle, the three tools
appear on the next model request; no app restart is needed for host-only changes.

For local development you can link the checkout instead of installing from npm; the package
manifest already declares every peer dependency needed by a linked bundle.

## Tools

### `dsh_workspace_manage`

Manage project groups in the sidebar.

| Action | What it does |
| --- | --- |
| `list` / `get` | Workspaces in sidebar order, their paths, membership, directory status |
| `create` / `rename` / `reorder` | Register an existing directory, rename, move in the order |
| `remove` | Unregister only — files, sessions, and history stay on disk |

### `dsh_session_manage`

Manage sessions and drive them across turns.

| Action | What it does |
| --- | --- |
| `list` / `get` / `search` / `read` | Scope-aware listing, one session in detail, full-text search, event reading |
| `start` / `send` / `steer` / `queue` | Create and deliver instructions (`send` = next turn, `steer` = the running turn, `queue` = inspect pending only) |
| `wait` / `notify` | Wait until `done` / a new `reply` / a completed `step`, with partial output and `idleForMs` on timeout; register a wake-up instead of blocking |
| `fork` / `attach` / `rename` / `reorder` / `sort` / `pin` / `unpin` / `archive` / `unarchive` / `cancel` | The rest of the session lifecycle |

**Cursor semantics.** `send`, `steer`, `start`, `read`, and `wait` return a `cursor`
(an event sequence number). Pass it as `after` to `read`/`wait` to see only what happened
after that point — no guessing, no re-reading the whole log.

**`send` vs `steer` vs `queue`.** `send` delivers for the next turn (`queue` semantics: an
idle target starts immediately, a running target gets it after the current turn). `steer`
injects into the turn that is running now, adopted at its next step; on an idle target it
falls back to `queue` and says so. `queue` never sends — it only inspects or edits pending
messages.

### `dsh_config_manage`

Read and change DSH's own configuration through the same channel as the Settings forms
(`configEditor.edit`: full validation → profile file lock → atomic replace → Loader
reconciliation for that row). No hand-editing of `cordis.patch.yml`.

| Action | What it does |
| --- | --- |
| `list` / `get` | Editable rows, inherited/override/effective values |
| `set` / `reset` | Two-step write: preview first, then `apply: true` with the preview token |
| `revert` | Roll back one audited write by `auditId` (conflict-checked) |
| `history` | Recent config writes with their auditIds and field diffs |

A write goes through this chain:

1. **Preview** — per-field diff, consequences (will it interrupt anything / is a restart
   needed / can it be reverted), and a `previewToken`.
2. **Token check** — the token is recomputed from the current state on apply. If the row
   changed since the preview, the write is refused (TOCTOU protection).
3. **Approval** — `approval.request(...)`; only `allowed-once` continues. Missing approval
   channel or missing agent/callId means **refused, no write** (fail-closed).
4. **Write** — official `configEditor.edit()`.
5. **Audit + receipt** — the result includes the original override values, the revert
   command, and the audit id. Sensitive fields (`key`/`token`/`secret`/`password`/
   `credential`/`env`, including nested keys such as `providers[].apiKey`) are masked in
   previews, receipts, approvals, and history.

Additional behavior:

- **Startup-required rows** (`agent-loop`, `webserver`, `connection`, `modules`, …) get a
  strong warning: a bad change can stop DSH from booting, not just disable a feature. The
  warning includes emergency recovery steps.
- **Conflicts are rejected.** `revert` checks the current values first and lists every
  conflict instead of overwriting someone else's change.
- **Audit is in-memory for now** (last 100 entries; cleared on plugin reload/restart). The
  receipt in the tool result is the durable fallback for recovery. Durable audit storage is
  on the roadmap.

## Quick start

```text
# Organize the sidebar
"Group the ungrouped sessions under the workspaces that match their directories."

# Delegate and read the answer back
"Go to session-xxx, ask it to run the plugin test suite, and bring me a summary when it finishes."

# Change a setting with governance
"Change session-query-sqlite openAt to never — show me the preview first."
# (agent previews, you agree)
"...confirmed, apply"

# Roll one write back
"Revert the config change you just made."
```

## Configuration

The plugin accepts this config on its profile row:

```yaml
- id: host-ops
  name: dsh-host-ops
  config:
    strictErrors: false   # true = every degradation path throws (development/testing)
    approval: ask         # ask = every config write needs approval | never = read-only
    requirePreview: true  # apply requires the preview token (default)
```

`approval: never` turns the whole config tool read-only. There is deliberately no
"auto-approve" switch: in headless/unattended deployments without an approval answerer,
config writes fail closed and only read/preview actions work.

## Safety model

- **Host-only**: no `dsh.client` half, so no extra UI or client bundle.
- **No direct filesystem writes**: all state changes go through DSH host services; config
  writes go through the official config editor (atomic, locked, schema-validated).
- **Fail-closed writes**: config changes cannot be applied without preview and approval.
- **Visible degradation**: optional enrichment (titles, summaries, UI refresh frames)
  degrades with a message in the tool output; core failures throw actionable errors.
  Programming errors (`TypeError`/`RangeError`/`ReferenceError`) are always rethrown.
- **Sensitive data**: config values are masked in previews/receipts/approvals/history;
  the plugin stores no credentials.

## Compatibility and limitations

- Built against DSH `0.2.2-rc.1` APIs. DSH is a developer preview and APIs change; if a new
  release breaks something, the fix belongs in a new plugin release, not in a restart.
- Audit history is in-memory (last 100 writes); see above.
- Config writes are limited to existing top-level fields; adding new patch rows/entries and
  nested field edits are out of scope.
- No UI on purpose: everything is model-facing tools.

## Uninstall and rollback

1. Disable/remove the `dsh-host-ops` bundle in the Plugins page (uninstall the npm package if
   you installed it). The plugin creates no files and leaves no state behind.
2. Config changes made through the tool live in your DSH profile patch layer. Revert them via
   `dsh_config_manage` with `revert`/`reset`, or by removing the row's override in the
   Settings UI.
3. If a startup-required row was changed and DSH no longer boots: quit DSH, rename
   `~/.dsh/profiles/<profile>/cordis.patch.yml` to `.bak-<timestamp>`, then start DSH again
   (the Desktop app also has a native fatal-recovery path). The original values are in the
   tool receipt.

## Development

```bash
# Logic suite (fake DSH services): 404 checks
node scripts/verify-dsh-host-ops.mjs

# Schema suite (compiles the tool definitions with real @deepseek-ai/dsh-tools): 64 checks
node scripts/verify-dsh-host-ops-schema.mjs
```

Repository layout:

```text
lib/index.js            all host-side tools (single file, no client half)
cordis.patch.yml        bundle patch (inserts the host-ops row)
locale/                 en/zh tool descriptions
scripts/                the two verification suites
docs/                   error-handling discipline, config governance, backlog
```

## License

[MIT](./LICENSE) © 2026 laughinbytes

Unofficial community project. DSH itself is licensed by its authors; this plugin is not
affiliated with or endorsed by DeepSeek.

Chinese translation of this file: [README.zh.md](./README.zh.md).
