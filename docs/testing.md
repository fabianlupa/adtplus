# Testing

Three levels: unit (mocked), live against SAP, and chat routing (does Copilot
reach the right tool).

## Unit

```
npm test            # vitest, mocked LSP/HTTP fixtures only — never a live SAP call
npm run typecheck
npm run lint
```

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `typecheck`, `lint`, `test` and
`build` on pushes to `main` and on PRs, on Ubuntu only. The four `darwin`-only tests
(`askTrustDialog`, one in `handshake.test.ts`) are skipped there, so run `npm test` locally on macOS before merging. Mocked only:
no live test.

### Static checks

Both cover `src`, `test` and `dev`; a finding fails CI.

- `typecheck`: `tsc` with `strict`, `noUncheckedIndexedAccess`, and no unused locals or
  parameters (a parameter the code has to take but doesn't read starts with `_`), no switch
  fallthrough, `override` on an overridden member.
- `lint` (`eslint.config.js`): only what `tsc` can't see, with type information: a promise
  nobody awaits (`no-floating-promises`; `void` marks one deliberately left), an `async`
  function where a plain callback is expected (`no-misused-promises`), `await` or
  `Promise.all` on something that isn't a promise (`await-thenable`; an array mixing promises
  with plain values gets `Promise.resolve(undefined)` instead), and `any`. A disable comment
  needs a reason after `--`, and one that disables nothing is an error itself.
- No style rules and no formatter: the code keeps the style around it.

Payload fixtures come from real probe output. `test/mcp/` drives
the real `tools/list`/`tools/call` through an in-memory MCP client, including the
tool counts (11 by default, 12 with a system that sets `allowRun`, 6 read-only,
11 with the irreversible commands denied; `adtplus_data` only with a system that sets
`allowDataPreview`, `adtplus_runtime` only with one that sets `allowRuntimeLogs`, read-only mode included) and the annotation ↔ `READ_ONLY_CMDS` check.

### Public-safety gate

`npm run gate` (`dev/gate.sh`) fails when a tracked file names something on the denylist: real
systems, hosts, tenants, people, the employer (AGENTS.md, "Public repository"). Development only
and opt-in, not an adt+ setting: without a denylist it prints "skipped" and exits 0 (set
`ADTPLUS_GATE_STRICT=1` to make that a failure). The denylist names what it guards, so it isn't
committed: the gitignored `.denylist` in the main checkout's root, which worktrees use too. One Perl-compatible regex per
line, case-insensitive; `allow: <pathspec>` exempts paths (`package.json`
names the author). `git config core.hooksPath dev/hooks` runs it before each commit
(`--staged`) and on each commit message (`--message`). It runs locally only: once a commit is
pushed, a finding is public already. Credentials are GitHub push protection's job.

## Live

- **Throwaway objects only**, in an allowlisted package (`ZADTPLUS_TEST` or below),
  named `*_TST_<topic>*` so leftovers are findable. Delete them afterwards and
  confirm they're gone.
- **A refusal test targets a custom Z name outside the allowlist**, best one that doesn't
  exist (`ZADTPLUS_NO_SUCH_<type>` in a package outside it), never an SAP standard object and
  never a real object inside the allowlist (other work can sit in `ZADTPLUS_TEST`). If the
  gate failed, the write would land: on SAP's `XFELD`, used everywhere, its activation
  would cascade through the whole system (2026-10-14; the gate held). Check the package
  chain before the call.
- **Both systems** when a behaviour could differ (it often does: language version,
  publish timing, typed search).
- **Use the shipped build**: `npm run build`, then the `adtplus` CLI. The next call
  replaces a daemon started from an older build; `adtplus system status` shows the build
  stamp it runs.
- **Cross-check independently.** `onprem`: ARC-1 (`SAPRead`, `SAPSearch`,
  `SAPTransport history`, `SAPDiagnose object_state`). `cloud-erp`: ADT for VS Code, or
  adt+'s own read path.
- **State which version you read** (active/inactive) in every verification.
- **Gate changes without writing anything:** drive `createDaemonServer` in-process
  from a scratch `.mts` script (`npx tsx`) against the real `systems.json` with the
  allowlist swapped per case, and probe with `transport assign` to a nonexistent
  request (`DEVK000000`): a refusal comes from adt+; a pass reaches SAP and changes
  nothing (the assign read-back then refuses, or, for an object in no open
  request, the answer is `onNextWrite` and no write follows).
- **Smoke run after an adt-ls change** (an ADT for VS Code update, or an
  `adtplus_system` warning): `npm run smoke -- --system onprem|cloud-erp` builds, then runs
  status, connect, search, resolve, list, package read, transport
  find/list/check, navigate outline/whereUsed, quality syntax/format, lockStatus and the
  `transport assign` probe above (`test/live/smoke.ts`; without `--class` it picks a
  `ZCL_ADTPLUS*` class under `ZADTPLUS_TEST`). Read-only; exits non-zero
  on any failure. `update` and `publish`/`unpublish` need a
  write and stay manual. On `cloud-erp` `connect` opens the SSO window.
- **Transport tests need an object in no open request**: create it on its own
  request and release that. A class edit must change an include (a section or a
  method); text after the last `ENDCLASS.` changes none, so CTS records nothing.
  Check what a request holds over REST (`GET /sap/bc/adt/cts/transportrequests/<nr>`,
  object list per request and task), not from the lock check alone. A package
  whose objects were deleted can only be deleted after the request recording the
  deletions is released.
- **Protocol questions** (what does adt-ls really send?): read the adt-ls jars with
  ASM's `Textifier` and the JRE the extension ships — no JDK needed. What ADT for
  VS Code does with a call: its bundle `dist/_bundle/extension.js` (minified, but the
  `adtLs/…` method names are plain strings).
- Record the run in the PR text: what was run, on which system, what was
  created and cleaned up, with the names from `docs/README.md` ("Names"). Raw responses
  and logs stay in the gitignored `scratch/`.

## Parallel sessions and worktrees

Several sessions (people or agents) can work at once, each in its own git
worktree. Agent worktrees live under `.claude/worktrees/` (gitignored). Branch
new work from `origin/main`.

The socket, `~/.config/adtplus/systems.json` and `~/.cache/adtplus/calls.jsonl`
are per user, not per checkout. A client from another build or config
**replaces** the daemon on its socket. So a worktree that live-tests on the
default socket kills your own daemon (and VS Code's sessions on it), and
the next call from there replaces the worktree's daemon in turn. Give each
checkout a daemon of its own:

```
npm run build
env=$(dev/daemon-env.sh) && eval "$env" && node dist/cli/index.js status   # in the worktree
dev/daemon-env.sh --stop                                                    # when done
```

`dev/daemon-env.sh [name]` prints the three variables for the daemon at
`/tmp/adtplus-<name>/` (name defaults to the checkout's folder name plus a
hash of its path, so two checkouts never share one):

| Variable | Value | Why |
|---|---|---|
| `XDG_RUNTIME_DIR` | `/tmp/adtplus-<name>` | own socket. Under `/tmp` because macOS fails unix socket paths over ~104 chars, which a path inside a worktree often is |
| `ADTPLUS_CONFIG` | `/tmp/adtplus-<name>/systems.json` | a copy of your config, made once (relative `extraCaCerts` made absolute): edit it freely (a new field, another allowlist) without breaking a daemon on older code. The script warns when your config changed after the copy, which then still holds the old allowlists; delete it to copy again |
| `ADTPLUS_LOG` | `/tmp/adtplus-<name>/calls.jsonl` | own call log with params digests, separate from yours |

- **Every command needs the variables.** The daemon inherits them from the
  client that starts it, and the client finds it by them. In a tool that runs
  each command in a fresh shell (Claude Code's Bash), put the prefix in front
  of every command, as above. Keep the `env=$(…) &&` form: a bare
  `eval "$(dev/daemon-env.sh)" &&` goes on with an empty environment when the
  script fails, and the command then replaces your daemon.
- The variables reach the whole command, not only adt+: other XDG-aware tools
  in it put their runtime files in the same folder. macOS clears old files in
  `/tmp`; a lost config copy is copied afresh, without your edits.
- **Run the worktree's own build**: `node dist/cli/index.js` or `npm run cli`.
  An `adtplus` on `PATH` is another checkout's build.
- **Stop only your own daemon**: `--stop` kills whatever holds that socket,
  nothing else. Never `pkill -f daemon/server`.
- **Two configs side by side** (say, one with `allowRun`, one without): two
  names, `dev/daemon-env.sh run-on` and `dev/daemon-env.sh run-off`, then
  edit each `systems.json`.
- **VS Code against a worktree daemon**: set the same three variables in the
  `env` of the `adtplus` server entry in `mcp.json`, and point its `command` at
  the worktree's `dist/`.
- **`cloud-erp`** opens an SSO window per daemon logon; a new daemon means a new
  window. Keep one running for a series of calls.
- Keychain items, `~/.config/adtplus/trusted.json` and
  `~/.adtls/destinations.json` stay shared. The last is part of every daemon's
  config identity: editing it restarts every daemon on its next call, the
  your own included (on `cloud-erp`, a new SSO window each).
