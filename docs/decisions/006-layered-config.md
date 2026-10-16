# ADR-006: Layered configuration — project folders on top of the user config

- Status: accepted 2026-09-28

## Context

People keep one folder per customer or project and want that project's systems defined there,
next to the work, instead of in one global `systems.json`. Three things constrain how:

- **One daemon serves every client.** It reads its config once and carries a config stamp
  (`daemon/identity.ts`); a client that sees another stamp replaces it. If the daemon's config
  depended on the client's folder, two VS Code windows in different project folders would replace
  each other's daemon, and the SAP sessions with it.
- **A folder config is untrusted input.** A cloned repository could carry one with a foreign
  `systemUrl` and the name of the user's real Keychain item, and adt+ would send that password
  there. An agent edits workspace files without asking, so it could widen `writeAllowlist` or set
  `allowRun: true` around ADR-003 and ADR-005.
- **The MCP server has no meaningful working directory.** Clients tell it the workspace folders
  through MCP roots.

## Decision

### Files and merge

- The user config is `~/.config/adtplus/systems.json` (`ADTPLUS_CONFIG` overrides the path).
- A **project config** is `.adtplus/systems.json` in any folder from the start folder up to, but
  not including, `$HOME`. None are read outside `$HOME`.
- **Union:** every user-level system is available in every folder. A project config adds systems
  or overrides them.
- **Override by key:** for a system defined in more than one file, each field comes from the
  nearest file that sets it. An object (`mirror`, `rateLimit`, `format`) merges key by key at every
  depth; a scalar or a list (`writeAllowlist`, `extraCaCerts`, `mirror.namespaces`) replaces the
  inherited one and is never appended. A project takes an inherited setting away only by setting
  it (`"allowGitRemote": false`, `"namespaces": []`), never by leaving it out.
- Every field may be set at either level, the gate fields included.
- Relative paths in a project config resolve against the folder holding its `.adtplus/`.

### Trust

- A project config is used only after the user approved its exact content. The approval is a
  SHA-256 of the file, stored in `~/.config/adtplus/trusted.json` with its path. Any edit revokes
  it.
- **Approval goes through a native dialog the daemon shows** (macOS), not a terminal command: an
  agent that can edit the file can also run a command in a terminal, but it can't click the
  dialog. The dialog names the file and lists what it adds or overrides, the connection fields
  (`systemUrl`, `client`, `user`, `keychainService`) and any widened gate first. An object field
  shows what it becomes after the merge beside what it was; a setting that names a program adt+
  runs is marked ⚠.
- Denied or not yet approved: every system that file touches is refused, with an error naming the
  file. Nothing falls back silently to the user-level values.
- `adtplus config trust` exists as the fallback where no dialog can be shown, and says it is the
  weaker route.

### Who reads what

- **The client finds, the daemon reads.** The CLI starts from its working directory; the MCP
  server from its MCP roots, then `ADTPLUS_PROJECT`, then its working directory. It sends the
  **paths** of the project configs it found with each request, never their content.
- The daemon reads those files itself, checks the trust hash, merges, and caches by path and
  mtime. Project configs aren't part of the daemon's identity stamp, so a project folder never
  replaces the daemon.
- **Sessions are keyed by the connection fields**: where a system connects, as whom and trusting
  which CAs (`kind`, `auth`, `client`, `systemUrl`, `reentranceUrl`, `user`, `keychainService`,
  `extraCaCerts`, the logon language; `connectionHash` in `src/core/session.ts`). A project that
  changes only policy fields shares the user-level session; one that changes the connection gets
  its own. Two projects may use the same system id.
- Several MCP roots whose chains resolve one system id differently: that system is refused, with
  an error naming both files.
- `status`, `config show` and the call log name the files a system was merged from.

## Why

- Leaving a key out of a project config keeps the inherited value, at every depth: a project that
  sets `mirror.maxObjects` must not drop the user's `mirror.namespaces` without a word.
- Lists replace so a project can narrow the write allowlist; every key a project sets is shown in
  the dialog before it applies, so it can't widen a gate unseen.

## Consequences

- ADR-003's rule is unchanged; only where its inputs come from widens. The trust dialog keeps an
  edited project config from widening it.
- The MCP server registers the switched tools (`adtplus_run`, …) from the effective config, so the
  tool list depends on the roots and changes through `tools/list_changed`.
- The dialog is macOS-only for now; elsewhere only the CLI fallback exists.

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADRs it absorbed merged in.
- 2026-10-16: the git opt-in moved out of `mirror` to the flat gate `allowGitRemote` (ADR-011); `ssoUrl` renamed `reentranceUrl`; an approval no longer records the merge rule it was given under (no approval predates the public release).
