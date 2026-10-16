# Architecture

```
Copilot (VS Code) ──► abap:// VFS (ADT for VS Code: edit source)
                 ──► adt+ MCP (stdio, dist/mcp/server.js) ─┐
Copilot CLI ────────► adt+ MCP ───────────────────────────┤
terminal ───────────► adt+ CLI (dist/cli/index.js) ───────┤   thin clients
git ────────────────► git-remote-adtplus (dist/git/main.js) ┤
                                                           ▼   unix socket, 0600
                      daemon (dist/daemon/server.js) — one per user, idle-exit 30 min
                        gates: ADTPLUS_READONLY · ADTPLUS_DENY · session mirrors · writeAllowlist · allowRun · allowDataPreview · allowRuntimeLogs · allowTranslations · allowGitRemote · rate limit
                        capabilities/  package · transport · object · navigate · quality · run · datapreview · translations
                        backends:      adt-ls via @arc-mcp/adt-ls  →  rawadt (REST, fallback only)  →  odata-ui (UI_SMTR_PROJECT on rawadt's session)
                        sessions:      one adt-ls JVM per system + one REST cookie jar per system
```

## Design principles

- **Built to retire.** adt+ is a stopgap. adt-ls can already do more than SAP's tools expose;
  adt+ makes that usable now and steps aside once SAP ships it in ADT for VS Code or the ADT MCP
  Server.
- **adt-ls first, REST only as a fallback that retires itself.** Where adt-ls lacks a feature,
  adt+ calls the ADT REST API directly. Each such call is tagged in its result, states when it
  goes, and is probed at runtime so `adtplus system status` shows when adt-ls could take over
  ([ADR-002](decisions/002-rest-fallbacks.md), [current fallbacks](known-issues.md#rest-fallbacks)).
- **Fix upstream, don't reimplement.** What the SDK lacks goes to `arc-mcp/adt-ls`; a local
  workaround is tracked until it can go ([ADR-004](decisions/004-sdk-strategy.md)). ABAP is
  never parsed by hand: local checks use [abaplint](https://abaplint.org)
  ([ADR-012](decisions/012-local-abap-checks-through-abaplint.md)).
- **Gates live in adt+, not in the client.** The write allowlist, `ADTPLUS_DENY` and
  `ADTPLUS_READONLY` hold whatever a client's approvals say
  ([ADR-003](decisions/003-write-gates.md)).
- **SAP's terms, one name everywhere.** A tool, CLI command and setting carries SAP's name for the
  thing, the same in every layer ([ADR-018](decisions/018-names-and-grouping.md)).

## Processes

- **MCP server, CLI and git remote helper are thin clients.** They translate tool calls / argv /
  git's remote-helper commands into
  daemon requests (`src/daemon/protocol.ts`) and send them over a user-only socket
  (`$XDG_RUNTIME_DIR/adtplus.sock`, else `~/.cache/adtplus/adtplus.sock`). The
  first client spawns the daemon. One JSON line each way; a request with `progress: true` gets
  `{"progress": …}` lines before its answer from `mirror.changes` and `mirror.push` (stage, done of
  total, units; at most every 250 ms), which the git helper shows on git's progress line.
- **Daemon commands only the git helper sends** (`GIT_ONLY_CMDS` in `src/daemon/protocol.ts`;
  no MCP tool, no CLI subcommand), all reads in the bulk lane and REST fallbacks (ADR-011):
  `mirror.changes` (a change stamp per object of a mirror root), `swc.packages` (a software
  component's root packages), `history.versions` (released versions from each source file's
  version feed, kept as blobs in the shadow), `history.released` (the requests released in the
  last two weeks, with their objects). Besides these the helper uses `mirror.init`, `pull`, `push`
  and `activate` like the CLI.
- **The daemon holds all sessions** (ADR-001's caching requirement): an adt-ls
  session cannot be persisted and a reentrance ticket is single-use, so without a
  long-lived process every CLI call would restart adt-ls and open a `cloud-erp` SSO window.
  It exits after 30 min idle; idle disposal drops adt-ls sessions but keeps the REST
  cookie jar, so the next connect stays headless.
- **The daemon reads `systems.json` and its environment once, at start**, and
  outlives MCP server restarts. So every client connect starts with a handshake
  (`src/daemon/identity.ts`): `ping` returns the daemon's identity, i.e. stamps
  over the build (`dist/**/*.js`, or `src/**/*.ts` before a build, plus
  `package-lock.json`) and the config (`systems.json`, `~/.adtls/destinations.json`)
  taken at its start. On a mismatch the client sends `shutdown` and spawns a fresh
  daemon. The old daemon gives up the socket path immediately, lets requests already
  running finish, and exits. `shutdown` carries the caller's identity and is a no-op
  on a daemon that already matches, so two clients racing can't kill the fresh one.
  The environment isn't part of the identity; see
  [known-issues.md](known-issues.md#operations).
- **A wrapper script** (optional, e.g. `~/.local/bin/adtplus`): sets
  `NODE_EXTRA_CA_CERTS`, picks the Node version, runs the MCP server with no args or the CLI
  with args. No secrets pass through it.

## Sessions and auth (ADR-001)

- **`onprem`** (on-prem): Basic auth from Keychain → reentrance ticket (with
  `sap-client` appended) → adt-ls. REST: Basic per request. Never retry a 401.
- **`cloud-erp`** (Cloud Public): REST logs on first through one browser SSO
  window; adt-ls's `requestBrowserBasedLogon` is then answered by minting a fresh
  reentrance ticket from that REST session, headlessly. One window per session for
  both channels. A REST call that gets a 401 there re-logs on and runs again only when none
  of its writes had been done on SAP (a validation, lock or query is no write); otherwise its
  error says it was not repeated.
- A REST call's requests count against the rate limit of the command that makes them, also
  when commands under different `rateLimit`s share one REST session.
- CA trust has two halves: `NODE_EXTRA_CA_CERTS` for Node, `extraCaCerts` for the
  adt-ls JVM.
- adt-ls itself comes from the installed `sapse.adt-vscode` extension: the SDK takes
  the **newest** version under `~/.vscode/extensions` (`ADT_LS_PATH` or
  `vendor/adt-ls/` override) and checks only a minimum version (1.1.2).

## Configuration

`~/.config/adtplus/systems.json` (untracked, no secrets), plus approved
`.adtplus/systems.json` project configs merged field by field on top, objects key by key (ADR-006;
clients send their paths per request, the daemon reads them). Every field, its default and the
environment variables: [configuration.md](configuration.md#systems). A clone's own preferences live
in its git config (`adtplus.*`). Destinations are also read from ADT for VS Code's
`~/.adtls/destinations.json`.

## Code layout

| Path | Role |
|---|---|
| `src/core/destinations.ts` | user + project configs + adt-ls destinations → `Destination`; the JSON Schema |
| `src/core/project-config.ts` | project config discovery, SHA-256 approvals in `trusted.json` |
| `src/core/trust-dialog.ts` | the approval summary and the macOS dialog (NSAlert via JXA) |
| `src/core/config-check.ts` | `config validate`'s checks beyond loading: Keychain item, CA files |
| `src/core/session.ts` | `SessionProvider`s (basic, interactive), `SessionManager` |
| `src/core/reentrance.ts` | ticket minting for the one-window `cloud-erp` logon |
| `src/core/resolve.ts` | strict resolve (name + type → URI, confirmed by a read) |
| `src/core/placement.ts` | package chain from a repotree URI (write gate input) |
| `src/core/capabilities.ts` | native-support probe for REST fallbacks |
| `src/core/clock.ts` | the system clock (ADR-016): both offsets measured, times to UTC and back |
| `src/core/udiff.ts` | unified diff by line (Myers), for `transport diff`'s own diffs |
| `src/core/format-guard.ts` | a format changed layout only: the same abaplint tokens before and after (ADR-017) |
| `src/core/abap-cleaner.ts` | the abap-cleaner binary (configured, or the VS Code extension's), adt+'s layout-only profile, one run per format |
| `src/capabilities/*.ts` | pure `(adt, input) → result` functions, shared by MCP and CLI |
| `src/capabilities/policy.ts` | the write rule (ADR-003) |
| `src/capabilities/format.ts` | `quality format`: engine `sap` (adt-ls; REST pretty printer for text) or `abap-cleaner`, the token guard (ADR-017) |
| `src/capabilities/versions.ts` | `object versions` and `object read` of a released version (REST): an object's version feeds, found from adt-ls's AFF file name |
| `src/capabilities/transport-diff.ts` | `transport read` (REST) and `transport diff`: adt-ls's `getDiff` plus diffs from the version feeds (`mirror/history.ts`'s feed parsing) for what it leaves out |
| `src/capabilities/rest-form-object.ts` | the REST lifecycle of a form-based DDIC object (read, SAP's name check, create, locked PUT, delete, activation gate, read-back), one for every type; `domain.ts` and `dataelement.ts` each give a kind (path, media type, XML, what SAP stores and refuses). The daemon routes every kind through one branch per command (`REST_FORMS` in `daemon/server.ts`) |
| `src/backends/rawadt.ts` | REST: cookie jar, CSRF, stateful lock sequences, a timeout per request |
| `src/backends/odata-ui.ts` | OData UI fallback (ADR-019): JSON calls to `UI_SMTR_PROJECT` on the REST session, `sap-message`, the `$metadata` service check |
| `src/capabilities/translations.ts` | `object translations` and `read TRPR`: projects covering an object, XLIFF, status, narrowing and paging |
| `src/core/languages.ts` | BCP 47 tags ↔ SAP language codes (AFF's table) |
| `src/daemon/` | socket server, protocol, deny/readonly, call log, per-object lock, rate limit (interactive lane with a per-minute budget; bulk lane for mirror commands, bounded by calls in flight, ADR-008) |
| `src/daemon/config.ts` | per-request config: user + the client's project configs, cached by mtime; the approval dialog |
| `src/mirror/` | mirror mode (ADR-007): layout and path safety, manifest, normalization, walk, `init`/`pull` (also of named objects only), `changes` (change stamps over REST, for the git helper), `component` (a software component's root packages over REST, for the git helper's `swc/` addresses), `history` (released versions from the version feeds and the released-request list over REST, for the git helper's transport commits), local `status`; local `check` (`lint.ts` abaplint stage 1, `schema.ts` AFF schemas with `ajv` against the schemas vendored in `aff-schemas/` (MIT, source commit in its README), `editorconfig.ts` format rules); `new` skeletons; `held.ts` (does a mirror the session used hold an object, ADR-009); `msag.ts` (message classes as AFF `.msag.json` over REST for pull and push, ADR-014); `push` (`push.ts`: plan, gate, conflict check, write, base from a read-back) and activation (`activate.ts`) |
| `src/mcp/server.ts` | the tool surface (ADR-018); `adtplus_run` only with `allowRun`, `adtplus_data` only with `allowDataPreview`, `adtplus_runtime` only with `allowRuntimeLogs`, all three following the MCP roots |
| `src/mcp/roots.ts` | workspace folders (MCP roots) → project config lists, the local folders a mirror may use; the run systems they allow |
| `src/cli/index.ts` | `adtplus <area> <action> --system … --flag value` |
| `src/cli/config.ts` | `adtplus config show\|validate\|schema\|trust`, local, no daemon |
| `src/cli/mirror.ts` | `adtplus mirror init\|pull\|status\|check\|new\|push\|activate` requests; the working folder is the workspace folder |
| `src/git/` | `git-remote-adtplus` (ADR-011): the remote-helper protocol loop (`protocol.ts`), the address (`package/` or `swc/`, `address.ts`), `import` bringing a shadow mirror in `$GIT_DIR/adtplus/<remote>/` up to date (change stamps, then a pull of the objects whose stamp moved, or a full one) and answering with transport commits and one sync commit (`fetch.ts`; which objects to re-read, `incremental.ts`; the shadow's `state.json`/`stamps.json`, `state.ts`; transport commits, `history.ts`), `push` through the shadow and `mirror push` (`push.ts`), the fast-import stream, git plumbing, stderr progress (`output.ts`); a daemon client of kind `git`, which the daemon refuses on systems without `allowGitRemote` |
| `dev/` | development scripts: parallel daemons, the public-safety gate, the README logo (ADR-020) |

## Design rules that recur

- **Resolve strictly, confirm with a read.** The quickSearch index can be stale.
- **Put facts in result fields, not notes.** Given `sourceScan.matches`,
  `version` and `diverged`, the model reported all callers; given a note asking it
  to look, it talked past the note in 3 of 4 runs. Notes are for what adt+ cannot
  compute (a cold index, a CDS locator).
- **Say which version was read.** The VFS and `source.read` serve the
  logged-on user's inactive draft; the where-used index reflects the active
  version. The active version is read with the SDK's `source.read({version:
  'active'})`, which switches adt-ls to it for the read; the daemon holds the
  object exclusively meanwhile (`src/daemon/objectlock.ts`).
- **A write is verified by a read-back**, not by the call's own success flag (the
  SDK has reported false successes).
