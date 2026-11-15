# Release checklist

Adapted from `dsh-dev/docs/09-插件开发与发布分层验证.md` for this repository. Copy the
evidence into [`docs/release-status.md`](./release-status.md) for each release; a release is
not “done” until every gate is either green or explicitly waived here with a reason.

## G0 · Code and manifest (every commit)

- [ ] `npm test` passes:
  - host logic `404/404`;
  - schema `64/64` (needs the Desktop DSH app for `app.asar`);
  - compliance `A=0 B=0` (`--strict`; C-level findings are reviewed in
    [`development.md`](./development.md#compliance-gate));
  - presentation + meta checks pass;
  - standards lock matches (`scripts/standards.lock.json`).
- [ ] `node --check lib/index.js` and `git diff --check` pass.
- [ ] No version/peer metadata drift from the tested DSH version (`engines.dsh`,
      `peerDependencies`, README compatibility line).

## G1 · Artifact (before publish)

- [ ] `npm pack --dry-run --json` lists exactly the runtime files (no `scripts/`, no
      `reference/`, no tests). Expected count for 0.1.x: 13.
- [ ] `npm pack` then install the tarball in an empty directory; `lib/index.js` passes
      `node --check`; the installed `package.json` version is the release version.
- [ ] `files`, `exports`, `locale`, `icon`, `meta.detail` are all present in the tarball.

## G1.5 · Persistent-write cold boot

Triggered only when the release adds or changes a document that DSH parses at startup
(credentials, profile patch, storage documents).

- [ ] If triggered: isolated `DSH_HOME` + real state snapshot, write, then start again; prove
      the next boot parses the written document. Use `dsh-dev/scripts/check-cold-boot.mjs`
      where it applies.
- [ ] If not triggered: record **N/A + why** (e.g. “config writes still go through the official
      `configEditor.edit()`; no plugin-owned startup document was added”).

## G2 · Composition and UI (before publish)

- [ ] Staging profile with the same composition as daily; install the candidate tarball; run
      the core flows (workspace list, session read/send, config preview).
- [ ] UI: N/A for this host-only plugin (no client half).
- [ ] If waived: record **N/A + why**; the next functional (runtime) release must not waive it.

## G2.5 · Upgrade gate

When the supported DSH version changes:

- [ ] From the previous tested version to the installed one, run:
      `node dsh-dev/scripts/check-upgrade-impact.mjs --from <old> --guide <guide dir>
      --plugins <copy of this repo> --ack docs/upgrade-ack.json --strict`.
- [ ] Review every hit in [`upgrade-review.md`](./upgrade-review.md); update
      `docs/upgrade-ack.json` only after reading the guide.
- [ ] Update `engines.dsh`, the README compatibility line, `scripts/standards.lock.json`, and
      `docs/upgrade-review.md` in the same change.

## G3 · Publish and dogfood

- [ ] `npm publish --access public --tag next`.
- [ ] Verify the registry version and install `@next` in a clean directory.
- [ ] Dogfood the candidate (daily profile or isolated instance), keep the rollback command.
- [ ] Promote: `npm dist-tag add dsh-host-ops@<version> latest`.

## G4 · Post-release

- [ ] Daily profile updated through `plugin_manager` (remove → install), not by hand-editing
      profile files.
- [ ] Rollback command recorded in the release notes.
- [ ] `docs/release-status.md` and `CHANGELOG.md` updated with the published version.

## Evidence template

| Gate | Command / check | Result | Date |
|---|---|---|---|
| G0 | `npm test` | 404/404, 64/64, A=0/B=0/C=2, presentation OK, standards OK | |
| G1 | `npm pack` + clean install | 13 files, `node --check` OK | |
| G1.5 | cold boot or N/A | | |
| G2 | staging or N/A | | |
| G2.5 | upgrade gate + ack | | |
| G3 | `npm publish --tag next` + promote | | |
| G4 | daily install + rollback | | |
