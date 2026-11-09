**Host-side operations for DSH agents** — workspaces, sessions, and governed configuration changes.
Tools only: no product UI, no client bundle, no direct filesystem writes.

> Unofficial community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
> Not affiliated with or endorsed by DeepSeek.

## What you get

An agent driving DSH can read files and run commands, but it cannot normally *operate DSH
itself*. This plugin exposes exactly that surface as three host-side tools:

- **Organize the workspace/session surface** — list, create, rename, reorder, pin, archive.
- **Delegate across sessions** — start/send/steer/queue, then wait for a reply or a step and
  read only the new events with a cursor.
- **Change DSH configuration with governance** — preview → approval → apply → audit →
  revert. Fail-closed; no silent writes.

All operations go through DSH's own host services (`workspaceRegistry`,
`sessionController`, `sessionQuery`, `sessionTitle`, `agents`, `configEditor`, `approval`).

## Tools

| Tool | What it does |
| --- | --- |
| `dsh_workspace_manage` | Sidebar project groups: list/get/create/rename/reorder/remove (remove unregisters only — files, sessions and history stay) |
| `dsh_session_manage` | Sessions: list/get/search/read, start/send/steer/queue, wait/notify, fork/attach/rename/reorder/sort/pin/archive/cancel, cursor-based reads |
| `dsh_config_manage` | DSH configuration: list/get/set/reset/revert/history, two-step writes with preview token, approval, audit and conflict-checked rollback |

`send` delivers for the next turn (idle target starts now, running target gets it after the
current turn); `steer` injects into the running turn; `queue` only inspects pending messages.
Config writes require a preview token and an approval; sensitive values are masked in
previews, receipts, approvals and history. Startup-required rows get an extra warning with
emergency recovery steps.

## Install

```bash
# after the npm release
dsh plugin --profile desktop add dsh-host-ops

# before the npm release: install straight from GitHub
dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"
```

Or use the **Plugins** page → **Add plugin**. (`desktop` is the Desktop app profile; the
Web UI profile is `web`.) Official `@deepseek-ai/*` peer dependencies are resolved from your
DSH installation — do not install them yourself.

## Configuration

Three options, set once on the plugin row:

| Option | Default | Meaning |
| --- | --- | --- |
| `approval` | `ask` | `ask` = every config write needs approval; `never` = config writes read-only |
| `requirePreview` | `true` | require the preview token before a write is applied |
| `strictErrors` | `false` | throw on every degradation path (development/testing only) |

Change them by asking the agent (it uses `dsh_config_manage`, with preview, approval and
audit), or from the plugin row's form on the Plugins page.

## Safety model

- **Host-only**: no client half, no extra UI surface.
- **No direct filesystem writes**: writes go through DSH host services; config writes use the
  official config editor (atomic, locked, schema-validated).
- **Fail-closed writes**: preview token + approval are required; a missing approval channel
  refuses the write.
- **Visible degradation**: optional enrichment failures say so in the tool output; core
  failures throw actionable errors; programming errors are always rethrown.
- **Sensitive data**: config values are masked in previews/receipts/approvals/history; the
  plugin stores no credentials.

## Requirements and limits

DSH `>=0.2.1-rc.2` or `>=0.2.2-rc.1` (tested against `0.2.2-rc.1`); Node `>=22.19.0`;
macOS/Linux Desktop and headless DSH. Audit history is in-memory (last 100 writes); the
receipt in the tool result is the recovery fallback. Config edits cover existing top-level
fields only. No custom settings page on purpose (see Design notes below).

## Uninstall

Disable or remove the `dsh-host-ops` bundle on the **Plugins** page (or
`dsh plugin --profile desktop remove dsh-host-ops`). The plugin creates no files and leaves
no state behind. Config overrides made through it live in your DSH profile patch layer —
revert them with `dsh_config_manage` (`revert`/`reset`) or remove the override in Settings.
If a startup-required row was changed and DSH no longer boots: quit DSH, rename
`~/.dsh/profiles/<profile>/cordis.patch.yml` to `.bak-<timestamp>`, start DSH again; the
original values are in the tool receipt.

## Development

```bash
node scripts/verify-dsh-host-ops.mjs         # logic suite (fake DSH services)
node scripts/verify-dsh-host-ops-schema.mjs  # schema suite (real @deepseek-ai/dsh-tools)
```

Design notes live in `docs/`: error-handling discipline, config governance, release status.
The plugin is intentionally host-only: model-facing tools plus a schema-driven form are
enough for three set-once options; a custom client settings page would add a client bundle
and a restart requirement for no real benefit.

## License

[MIT](./LICENSE) © 2026 laughinbytes.
Chinese translation: [README.zh.md](./README.zh.md).
