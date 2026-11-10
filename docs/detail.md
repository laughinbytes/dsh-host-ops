![Host Ops: the agent operates DSH itself, through governed tool calls](./detail-hero.svg)

**Your agent can finally work inside DSH.** Workspaces, sessions, and configuration — the same
operations a person has in the app, exposed as tools the agent can use safely.

## What it changes

Before this plugin, the agent could read files and run commands but had to leave DSH to organize
anything. With it, the agent can:

- **Shape the workspace** — group, rename, reorder and archive the sidebar it works in.
- **Run work in other sessions** — hand a task to another session, wait for a reply or a step,
  and read back only what is new.
- **Change DSH settings** — with a preview first, your approval, an audit trail, and a revert.

## Try asking

- “Group the ungrouped sessions under the workspaces that match their directories, then report back.”
- “Go to session-xxx, ask it to run the tests, and bring me the summary when it finishes.”
- “Change session-query-sqlite's openAt to never — show me the preview first.”

## Install

```bash
dsh plugin --profile desktop add dsh-host-ops
```

Not on npm yet? `dsh plugin --profile desktop add "github:laughinbytes/dsh-host-ops#main"`.

## Settings

Nothing to configure up front. Three advanced options (`approval`, `requirePreview`,
`strictErrors`) are changed by asking the agent — it previews the change, asks for approval, and
records it. The Plugins page keeps the normal on/off switch.

## Safe by design

- Configuration writes are fail-closed: preview, then approval, then a recorded change you can revert.
- Secret values are masked everywhere they could be shown.
- Risky rows (those DSH needs to start) get an explicit warning with recovery steps.
- Everything goes through DSH's own services — the plugin never edits DSH's files directly.

*DSH `>=0.2.1-rc.2` or `>=0.2.2-rc.1`; Node `>=22.19.0`; macOS tested. Unofficial community plugin.*
