**Host-side DSH tools for agents** — workspaces, sessions, and configuration, with preview,
approval, audit and revert for writes.

For [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

This is the developer-facing README. The page users see inside DSH is generated from the
localized detail documents in [`docs/detail.md`](./docs/detail.md) /
[`docs/detail.zh.md`](./docs/detail.zh.md) through the official `meta.detail` mechanism.

## What it provides

Three host-side tools that expose DSH's own operations to an agent. All calls go through DSH
services (`workspaceRegistry`, `sessionController`, `sessionQuery`, `sessionTitle`, `agents`,
`configEditor`, `approval`); the plugin never edits DSH's files directly.

| Tool | Operations |
| --- | --- |
| `dsh_workspace_manage` | `list`, `get`, `create`, `rename`, `reorder`, `remove` (remove only unregisters — files, sessions and history stay) |
| `dsh_session_manage` | `list`, `get`, `search`, `read`, `start`, `send`, `steer`, `queue`, `wait`, `notify`, `fork`, `attach`, `rename`, `reorder`, `sort`, `pin`, `unpin`, `archive`, `unarchive`, `cancel`, `model` |
| `dsh_config_manage` | `list`, `get`, `set`, `reset`, `revert`, `history` — config of any editable row in the current profile (DSH core rows and installed plugin rows alike) |

### Delivery semantics

- `send` delivers for the next turn: an idle target starts now, a running target receives it
  after the current turn (non-disruptive).
- `steer` injects into the turn currently running, adopted at its next step; on an idle target
  it falls back to `queue` and says so.
- `queue` only inspects or edits pending messages; it never sends new text.
- `send`, `steer`, `start`, `read` and `wait` return a `cursor`; pass it as `after` to
  `read`/`wait` to get only what happened after that point. `wait` supports
  `until: done | reply | step` and returns partial content plus `idleForMs` on timeout.

## Install

```bash
dsh plugin --profile desktop add dsh-host-ops
```

From GitHub instead: `dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"`.

`desktop` is the Desktop app profile (the Web UI profile is `web`). You can also use
**Plugins → Add plugin**. Declare/install no `@deepseek-ai/*` packages yourself: they are
`peerDependencies` resolved from the DSH installation.

## Configuration

The plugin row accepts three options (defaults shown):

| Option | Default | Meaning |
| --- | --- | --- |
| `approval` | `ask` | `ask` = approval required for every config write; `never` = config writes read-only |
| `requirePreview` | `true` | writes require the preview token |
| `strictErrors` | `false` | throw on every degradation path (development/testing only) |

Change them through the agent (`dsh_config_manage`, with preview/approval/audit). Host-only
plugins have no editable form on the Plugins page; that page only shows the component
on/off switch.

## Write governance

- **Preview token**: a write must carry the token returned by its preview; the token is
  recomputed from current state, so changes made in between refuse the write (TOCTOU).
- **Approval**: `approval.request` must return `allowed-once`; a missing approval channel
  fails closed.
- **Audit**: every applied write is recorded (last 100, in memory) with the before/after
  overrides; the tool result also contains a receipt with original values and recovery steps.
- **Revert**: conflict-checked rollback by `auditId`; mismatched current values refuse the
  revert and list the conflicts.
- **Masking**: sensitive fields (key/token/secret/password/credential/env, including nested
  keys such as `providers[].apiKey`) are masked in previews, receipts, approvals and history.
- **Startup-required rows** (`agent-loop`, `webserver`, `connection`, `modules`, …) carry a
  warning with emergency recovery instructions.
- Core failures throw actionable errors; optional enrichment degrades visibly; programming
  errors are rethrown (see [error handling](./docs/error-handling.md)).

## Compatibility and limits

DSH `>=0.2.1-rc.2` or `>=0.2.2-rc.1` (tested on `0.2.2-rc.1`); Node `>=22.19.0`; verified on
macOS Desktop, other platforms untested. Audit history is in-memory (last 100 writes). Config
edits cover existing rows' top-level fields only. The plugin cannot install/enable plugin
bundles, edit agent presets, or write DSH storage files directly.

## Verify

```bash
node scripts/verify-dsh-host-ops.mjs         # logic suite (fake DSH services), 404 checks
node scripts/verify-dsh-host-ops-schema.mjs  # schema suite (real @deepseek-ai/dsh-tools), 64 checks
```

In an installed profile, ask the agent to “list my workspaces” — the tools answering without
errors is the end-to-end smoke test.

## Uninstall

Disable or remove the `dsh-host-ops` bundle on **Plugins** (or
`dsh plugin --profile desktop remove dsh-host-ops`). Config overrides made through the tool
remain in the profile patch layer — revert them with `dsh_config_manage` (`revert`/`reset`).
If a startup-required row was changed and DSH no longer boots: quit DSH, rename
`~/.dsh/profiles/<profile>/cordis.patch.yml` to `.bak-<timestamp>`, start DSH again; original
values are in the tool receipt.

## Development

Repository layout, install policy for daily use and release scanning:
[`docs/development.md`](./docs/development.md).

## License

[MIT](./LICENSE) © 2026 laughinbytes. Chinese: [README.zh.md](./README.zh.md).
