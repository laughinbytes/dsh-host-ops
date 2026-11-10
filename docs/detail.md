**Let your agent operate DSH itself** — organize the workspace, delegate work across sessions,
and change configuration with preview, approval and rollback.

An agent can already read files and run commands. This plugin adds the missing layer: it lets
the agent work *inside DSH* — the same workspace, session and configuration operations a
person has in the UI, made safe for autonomous use.

## Ask for things like

- “Group the ungrouped sessions under the workspaces that match their directories.”
- “Go to session-xxx, ask it to run the plugin tests, and bring me the summary when it finishes.”
- “Change session-query-sqlite's openAt to never — show me the preview first.”

## What the agent gets

- **Workspace control** — list, create, rename, reorder, pin and archive sidebar project groups.
- **Session control** — start, send, steer, queue, wait for a reply or a step, read only new
  events with a cursor, fork, attach, rename, archive and cancel.
- **Governed configuration** — edit the config of any editable row in the current profile
  (DSH core rows and installed plugin rows alike): preview → approval → apply → audit →
  revert, with conflict-checked rollback.

## Install

```bash
dsh plugin --profile desktop add dsh-host-ops
```

Before the npm release: `dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"`.
You can also use **Plugins → Add plugin**.

## Settings

Three set-once options (`approval`, `requirePreview`, `strictErrors`) are managed by asking the
agent: it uses `dsh_config_manage` with preview, approval and audit. The Plugins page keeps the
usual enable/disable switch; there is no separate settings form.

## Safety

- Config writes are fail-closed: preview token + approval required.
- Sensitive values are masked in previews, receipts, approvals and history.
- Startup-required rows get a warning with emergency recovery steps.
- Core failures throw actionable errors; optional enrichment degrades visibly.

## Compatibility

DSH `>=0.2.1-rc.2` or `>=0.2.2-rc.1` (tested on `0.2.2-rc.1`); Node `>=22.19.0`; macOS
Desktop verified, other platforms untested.

Full documentation, including configuration governance and error-handling discipline:
<https://github.com/laughinbytes/dsh-host-ops#readme>.
