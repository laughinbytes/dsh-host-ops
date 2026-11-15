# Upgrade review — DSH 0.2.2-rc.1 → 0.2.2-rc.3

The G2.5 gate (`dsh-dev/scripts/check-upgrade-impact.mjs`) matches upgrade-guide tokens
against the plugin source. It is a heuristic: a hit means “read the guide”, not “broken”.
This file records the review behind `docs/upgrade-ack.json`.

Command (from `dsh-dev`):

```bash
node scripts/check-upgrade-impact.mjs \
  --from 0.2.2-rc.1 \
  --guide reference/tmp/asar-dsh/docs/upgrade-guide \
  --plugins /tmp/host-ops-plugins \
  --ack <this-repo>/docs/upgrade-ack.json \
  --strict
```

| Guide entry | Matched token(s) | Where it appears | Review |
|---|---|---|---|
| `v0.2.2-rc.1/account-remote-provider` | `deepseek-account` | `lib/index.js:2179`, an example provider id inside the `dsh_session_manage` tool description | Not an API use. The plugin does not import the account package or resolve account services. No change. |
| `v0.2.2-rc.1/attachment-error-codes` | `tool/result`, `turn/end` | Event-type reads in `read` / `wait` / `notify` | The plugin consumes event names and data fields, not `AttachmentError`. The guide changes error-code propagation in tool failures; the event shape used here is unchanged. Re-check after a future change to the rendering path. |
| `v0.2.2-rc.1/cua-native-platform` | `run_code` | `lib/index.js:2190`, a preset description (`cordis` / `ptc` / `minimal`) | Not a CUA call. No change. |
| `v0.2.2-rc.1/plugin-update-method` | `plugin_manager` | `lib/index.js:2188`, a preset description | The plugin does not manage bundles or call `plugin_manager`. No change. |
| `v0.2.2-rc.1/runtime-context-reminders` | `user/message` | `read` renders user messages | Event type and text field used by `read` are unchanged. No change. |
| `v0.2.2-rc.1/web-search-billing` | `deepseek-account` | Same tool-description example as above | The plugin does not call web search/fetch or choose credentials by billing. No change. |

Result: **6 entries reviewed, 0 code changes required** for this release. Re-run the gate
when the supported DSH version changes; update `engines.dsh`, the README compatibility line,
and `scripts/standards.lock.json` in the same change.
