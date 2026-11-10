**Let your agent operate DSH itself** — organize the workspace, delegate work across sessions,
and change configuration with preview, approval and rollback.

> Unofficial community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
> Not affiliated with or endorsed by DeepSeek.

An agent can already read files and run commands. This plugin adds the missing layer: it lets
the agent work *inside DSH* — the same workspace, session and configuration operations a
person has in the UI, made safe for autonomous use. Writes are governed (preview → approval →
apply → audit → revert), and nothing is edited behind DSH's back.

## Ask for things like

- “Group the ungrouped sessions under the workspaces that match their directories.”
- “Go to session-xxx, ask it to run the plugin tests, and bring me the summary when it finishes.”
- “Change session-query-sqlite's openAt to never — show me the preview first.”

## Three tools

| Tool | What the agent can do |
| --- | --- |
| `dsh_workspace_manage` | Sidebar project groups: list, create, rename, reorder, remove (removing only unregisters — files, sessions and history stay) |
| `dsh_session_manage` | Sessions: list/search/read, start, send vs steer vs queue, wait for a reply or a step, notify, fork, attach, rename, reorder, pin, archive, cancel — with cursor-based incremental reads |
| `dsh_config_manage` | The config of any editable row in the current profile (DSH core rows and installed plugin rows alike): preview, approval, audit, revert, conflict-checked rollback |

Every operation uses DSH's own host services (`workspaceRegistry`, `sessionController`,
`sessionQuery`, `sessionTitle`, `agents`, `configEditor`, `approval`).

## Install

```bash
# after the npm release
dsh plugin --profile desktop add dsh-host-ops

# before the npm release: install straight from GitHub
dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"
```

`desktop` is the Desktop app profile (the Web UI profile is `web`). You can also use
**Plugins → Add plugin**. Official `@deepseek-ai/*` peer dependencies come from your DSH
installation — do not install them yourself.

## Configuration

Three options, set once:

| Option | Default | Meaning |
| --- | --- | --- |
| `approval` | `ask` | ask before every config write, or `never` for read-only writes |
| `requirePreview` | `true` | require the preview token before applying a write |
| `strictErrors` | `false` | throw on every degradation path (development/testing only) |

These are managed **by asking the agent** — it uses `dsh_config_manage` with preview,
approval and audit. The Plugins page keeps the usual on/off switch for the plugin; there is
no separate settings form.

## Safety

- Config writes are fail-closed: preview token + approval are required, and a missing approval
  channel refuses the write.
- Sensitive values (keys, tokens, secrets, nested `providers[].apiKey`-style fields) are masked
  in previews, receipts, approvals and history.
- Changes to startup-required rows get a warning with emergency recovery steps.
- Core failures throw actionable errors; optional enrichment degrades visibly; programming
  errors are never swallowed.
- The plugin creates no files and stores no credentials.

## Requirements and limits

DSH `>=0.2.1-rc.2` or `>=0.2.2-rc.1` (tested on `0.2.2-rc.1`); Node `>=22.19.0`; verified on
macOS Desktop — other platforms are untested. Audit history is in-memory (last 100 writes);
the receipt in the tool result is the recovery fallback. Config edits cover existing top-level
fields only. The plugin cannot install/enable plugins or edit agent presets; session and workspace
operations go through DSH's normal services, and it never edits DSH's storage files directly.

## Uninstall

Disable or remove the `dsh-host-ops` bundle on **Plugins** (or
`dsh plugin --profile desktop remove dsh-host-ops`). Config overrides made through it remain
in your profile patch layer — revert them with `dsh_config_manage` (`revert`/`reset`).
If a startup-required row was changed and DSH no longer boots: quit DSH, rename
`~/.dsh/profiles/<profile>/cordis.patch.yml` to `.bak-<timestamp>`, start DSH again; the
original values are in the tool receipt.

## Documentation

- [Configuration governance](./docs/config-governance.md) — preview, approval, audit, revert
- [Error-handling discipline](./docs/error-handling.md) — fail-fast vs visible degradation
- [Development and release](./docs/development.md) — test suites, repository layout, install policy

## License

[MIT](./LICENSE) © 2026 laughinbytes. Chinese: [README.zh.md](./README.zh.md).
