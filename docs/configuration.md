# Configuration

## Systems

Configure systems in `~/.config/adtplus/systems.json`. Keep it out of any repo.
`ADTPLUS_CONFIG=<path>` reads another file instead; a daemon started from
another path is replaced like after a config save.
It holds no secrets, only the name of a Keychain service:

```json
{
  "onprem": {
    "kind": "onprem",
    "auth": "basic",
    "client": "100",
    "systemUrl": "https://<host>:<port>",
    "user": "<user>",
    "keychainService": "<keychain service name>",
    "extraCaCerts": ["~/certs/corp-ca.pem"],
    "writeAllowlist": ["ZADTPLUS_TEST"]
  },
  "cloud-erp": {
    "kind": "cloud",
    "auth": "interactive",
    "client": "100",
    "adtlsDestinationId": "cloud-erp-100",
    "writeAllowlist": ["ZADTPLUS_TEST"]
  }
}
```

All fields are listed in [architecture.md](architecture.md#configuration).
`extraCaCerts` paths may start with `~/` or be relative to the file's folder.
An invalid file fails with its path and one line per bad field
(`onprem.writeAllowlist.0: …`). An unknown field is an error too, so a typo such as
`writeAllowList` can't be silently ignored.

`adtplus config` reads the files locally, without the daemon:

- `adtplus config show [--dir <folder>] [--json]` prints the effective systems
  and where each value comes from (`user`, a project folder, or the `~/.adtls`
  entry the URL was looked up in).
- `adtplus config validate [--dir <folder>] [--json]` also checks what loading doesn't: that a
  basic-auth system names a `user` and a Keychain item that exists (looked up
  without reading the secret), and that each `extraCaCerts` file reads and holds
  a certificate. Exit code 1 on any problem.
- `adtplus config schema` prints a JSON Schema of the file, with each field
  described. Save it next to the file and point the file at it for completion
  and hover help in the editor:

  ```sh
  adtplus config schema > ~/.config/adtplus/systems.schema.json
  ```

  ```json
  { "$schema": "./systems.schema.json", "onprem": { … } }
  ```

  `$schema` is the one top-level key that isn't a system. Regenerate the file
  after an adt+ update adds a field.
adt+ also reads destinations from ADT for VS Code's `~/.adtls/destinations.json`.

adt+ refuses the SAP-reserved clients `000` and `066` (ADR-005): a system
configured with either makes loading `systems.json` fail with an error naming
the system, before any logon. `"0"` and `"66"` count as the same clients.

## Project configs

A `.adtplus/systems.json` in a project folder adds systems or overrides them
there ([ADR-006](decisions/006-layered-config.md)). adt+ reads every one from
the start folder up to, but not including, `$HOME`; none outside `$HOME`.

- Systems from the user config stay available in every folder.
- For a system defined in several files, each field comes from the nearest file
  that sets it. A list (`writeAllowlist`, `extraCaCerts`, `mirror.namespaces`)
  replaces the inherited one; it is not appended. An object (`mirror`, `rateLimit`)
  merges key by key, at every depth: `{"onprem": {"mirror": {"maxObjects": 2000}}}`
  keeps the inherited `mirror.git` and `mirror.namespaces` ([ADR-006](decisions/006-layered-config.md)).
  To take one away, set it (`"git": {"enabled": false}`). A file setting an object
  field that was approved before this rule is asked for again once.
- Every field may be set in a project config, the gates included. A project
  config may set a single field, e.g. `{"onprem": {"writeAllowlist": ["ZCUST"]}}`.
- Relative `extraCaCerts` resolve against the folder holding `.adtplus/`.

**Approval.** adt+ uses a project config only once you approved its exact
content, because it can point a Keychain password at another host or widen a
gate, and an agent edits workspace files without asking:

- `adtplus config trust [--dir <folder>]` shows one macOS dialog (a native
  alert, through `osascript -l JavaScript`) for every unapproved file found
  there, listing what each adds or overrides. Connection changes, opened gates
  and a system reusing another system's Keychain password are marked ⚠. Deny is
  the default: Return and five minutes without an answer deny, and Allow takes a
  mouse click.
- Allow records the file's SHA-256 with its path in
  `~/.config/adtplus/trusted.json`. Any edit revokes it.
- Every system that an unapproved file sets is refused, with an error naming the
  file. adt+ never falls back to the user config's values for it.
- Where no dialog can be shown, `trust` asks on the terminal instead and says
  that is weaker: anything that can type in that terminal can approve.

**Which folder counts.** Each CLI or MCP request carries the paths of the
project configs its client found; the daemon reads and checks those files itself
and accepts only `.adtplus/systems.json` paths below `$HOME`. So the same
daemon serves two VS Code windows in different customer folders, each with its
own systems.

- The CLI looks from `ADTPLUS_PROJECT` if set, else from its working folder.
- The MCP server looks from each of the window's workspace folders, which VS Code
  reports as MCP roots, and follows changes to them. Roots that aren't local
  folders (ADT system folders) are skipped. Without roots (another client, or
  no local folder open) it falls back like the CLI.
- Every tool call waits (up to 5 s) until a client that offers roots has named its
  folders. If it doesn't, or `roots/list` fails, the call is refused with an error
  and the next call asks again; it never runs on the user config alone.
- **Several workspace folders:** a system resolved the same way in every folder
  that has it is used, one only some folders define is available, and one that
  resolves differently between folders is refused, naming the files
  (`it differs between the workspace folders (…)`).

**In the daemon.** The first command on a system that an unapproved file sets
opens the approval dialog, and waits for it; commands arriving meanwhile wait
for the same answer. Allow records the approval as `trust` does. A Deny is
remembered until the file changes, so a retrying agent doesn't bring the dialog
back; `adtplus config trust` asks again. Until then the command fails with
`adt+ system "…" refused: …`, naming the file. `status` never asks.

**Sessions.** Systems that differ only in policy fields (allowlist, gates,
`vfsMount`) share one SAP session and one rate-limit budget. A project config
that changes a connection field (`kind`, `auth`, `client`, the URLs, `user`,
`keychainService`, `extraCaCerts`, `language`) gets its own session; `status` then still
lists it under its system id. A project config's own `rateLimit` gets its own
budget.

`adtplus system status` lists the project configs of the folder it runs in, marks each
system that comes from one (`[from ~/projects/my-app/.adtplus/systems.json]`),
and lists refused systems. The call log records them per request (`config`).

## Write allowlist

Every write goes through one rule (`src/capabilities/policy.ts`): adt+ allows it
when an entry of the system's `writeAllowlist` covers the package the write
lands in. The rule covers:

- object create, update, activate, delete, publish and unpublish
- transport create and assign
- package create, update and delete (a package lands in its superpackage)
- `run` and ABAP Unit (`test`), because executing code is as
  consequential as changing it

Entries come in two forms:

- `"ZADTPLUS_TEST"` covers that package only.
- `{ "package": "ZADTPLUS_TEST", "subpackages": true }` covers its whole subtree.

An object lands in its own package, read off the resolved `abap:` path
(`src/core/placement.ts`); `$TMP` objects count as package `$TMP`. A package
lands in its superpackage. So an exact entry lets adt+ create, edit and delete
the packages directly under it, while the listed package itself stays
untouchable. adt+ refuses anything whose package it cannot read.

`confirm: true` on delete, release, publish and run is not a gate. It only
prompts the model, and the model sends it itself.

## Run (off by default)

`adtplus_run` executes arbitrary ABAP, which can read data anywhere, so it is
off unless the system sets `"allowRun": true` in `systems.json` or an approved
project config (ADR-005, ADR-006).

- The daemon refuses `run.application` on any other system before it opens a
  session, with an error naming the setting. That covers the CLI (`adtplus run`)
  as well as the MCP server.
- The MCP server offers `adtplus_run` only while at least one system of its
  workspace folders allows it, and the tool's `system` parameter lists only
  those systems. It works this out at its start and again whenever VS Code
  reports other workspace folders, and tells VS Code (`tools/list_changed`).
  If the config doesn't load, the tool is left out.
- On an allowed system, the write allowlist and `confirm: true` still apply.

After changing `allowRun` in a file, restart the MCP server (VS Code also
caches the tool list; see [known-issues.md](known-issues.md#operations)).

## Publishing services (on by default)

`adtplus_object_write publish` and `unpublish` (CLI `adtplus object publish|unpublish`) are on
unless the system sets `"allowPublishService": false` in `systems.json` or an approved project
config (ADR-003).

- With it set, the daemon refuses both on that system before any SAP call, with an error naming
  the setting. The tool keeps the actions; only that system refuses them.
- Where publishing is on, the write allowlist (on the binding's package) and `confirm: true` still
  apply.
- The daemon reads the setting per request; no restart needed.

## Data preview (off by default)

`adtplus_data` runs one SQL SELECT through ADT's data preview and returns the
rows. It reads whatever the SAP user may read on that system, SAP tables
included, so it is off unless the system sets `"allowDataPreview": true` in
`systems.json` or an approved project config (ADR-013). Switch it on only where
reading that data is acceptable: adt+ can't tell test data from business data,
for example on a copy of a production system.

- The daemon refuses `data.query` on any other system before it opens a
  session, with an error naming the setting (CLI `adtplus data` too).
- The MCP server lists `adtplus_data` only while a system of its workspace
  folders allows it, with only those systems, like `adtplus_run`. It changes
  nothing on the system, so `ADTPLUS_READONLY` keeps it; `ADTPLUS_DENY=data.query`
  takes it out.
- What it reads is limited by the system, not by adt+: a cloud system (ABAP
  Cloud) answers for released and own objects only, an on-premise system for
  any table. adt+ refuses a statement that reads another client.

After changing `allowDataPreview` in a file, restart the MCP server.

## Runtime logs (off by default)

`adtplus_runtime` reads the runtime logs: ABAP runtime errors (short dumps, ST22) and the gateway
error log (/IWFND/ERROR_LOG). A dump can hold the values a program held, a gateway error the
values of a request, business data among them, so both are off unless the system sets
`"allowRuntimeLogs": true` in `systems.json` or an approved project config (ADR-015).
System messages (SM02, `adtplus_system messages`) hold no program data and need no switch
(ADR-018).

- The daemon refuses every `runtime.*` command on any other system before it opens a session,
  naming the setting (CLI `adtplus runtime` too).
- The MCP server lists `adtplus_runtime` only while a system of its workspace folders allows it,
  with only those systems. `ADTPLUS_READONLY` keeps it; `ADTPLUS_DENY=runtime.*` takes it out.
- The dump and gateway error lists show the logon user's own unless the call names another user
  or `"*"`; a dump's variables come only when asked for by chapter.

After changing `allowRuntimeLogs` in a file, restart the MCP server.

## Translations (off by default)

`adtplus_object translations` and the translation project type `TRPR` go through
`UI_SMTR_PROJECT`, the OData UI service behind SAP's Fiori app "Maintain Translations". The
service isn't released (ADR-005's channels don't include it), so all of it is off unless the
system sets `"allowTranslations": true` in `systems.json` or an approved project config
(ADR-019). Built and verified on `cloud-erp` only.

- The daemon refuses `object.translations` and every action on `TRPR` on any other system before
  it opens a session, naming the setting.
- The action stays listed in `adtplus_object`; its description says it needs the switch.
  `ADTPLUS_READONLY` keeps it (it reads); `ADTPLUS_DENY=object.translations` takes it out.
- `update` of a `TRPR` writes texts (gate A as well: the project's package and every translated
  object's); `create` and `deleteObject` on it are refused for now, with or without the switch.

No restart needed: the daemon reads the switch per request.

## Rate limit

The daemon limits adt+'s calls to each system (ADR-005): every SDK call,
`raw.lsp` included, and every REST request. The budget counts **estimated
backend requests** (ADR-008): a REST request is one; an SDK call weighs what
the probes traced for its method, e.g. 0 for `abapStat`, 1 for a directory
listing, 2 for a file read, 6 for a source write or a create, 3 per object for
an activation, and 3 for a method not traced yet (the table is `unitsOf` in
`src/daemon/ratelimit.ts`). adt-ls reports no request count itself, so this is
an estimate. Logon calls aren't counted. Defaults, per system in
`systems.json`:

```json
"rateLimit": { "concurrency": 4, "perMinute": 600 }
```

- **`concurrency`:** at most this many calls run at once, and the rest wait
  in order. A command arriving while more than 4 × `concurrency` calls wait is
  refused.
- **`perMinute`:** estimated requests of the calls started in the last 60 s,
  mirror commands' calls aside (their bulk lane, see "Mirror").
  This is checked only when a
  command starts. A command already running always finishes, so it never
  leaves a write half done; whatever it goes over the budget delays the next
  command.
- **SAP's 429/503:** every command and call to that system is refused until
  the response's `Retry-After`, or for 30 s without one. Nothing is retried.

A refused command returns
`{"ok": false, "throttled": true, "retryAfterMs": …, "error": "…"}` and isn't
queued. `system.status` and `system.connect` are never refused. Tools that fan out are
bounded: `activate` takes at most 50 objects, `list` reads at most 200
directories, `search` returns at most 100 hits, and the `whereUsed` source
scan reads at most 5 includes in each version.

## REST timeout

Per system in `systems.json`, optional:

```json
"restTimeout": 120
```

Seconds a REST request has for SAP's whole answer before adt+ gives it up: the REST fallbacks
([known issues](known-issues.md#rest-fallbacks)) and the OData UI service of translations. One
limit covers a request's CSRF fetch, the request and its retry. Whole seconds from 1 to 3600,
default 120; the longest commands seen take under a minute. adt-ls calls don't use it (publishing
a service binding, for one, waits up to 5 minutes for its state on its own). A project config may
set it; the approval dialog shows it. The daemon reads it per command, so no restart is needed.

## Mirror

Mirror mode (ADR-007) pulls packages as AFF files into a local folder. Per
system in `systems.json`, all optional:

```json
"mirror": { "concurrency": 3, "maxObjects": 500, "namespaces": ["/NSPC/"], "git": { "enabled": true } }
```

- **`concurrency`:** calls the mirror commands and the git helper keep in flight
  on the system (ADR-008): default 3; more than 5 counts as 5. REST requests (a fetch's change
  stamps) use it in full; adt-ls calls (a pull's reads) at most 3, since adt-ls
  runs one call at a time per session and more would only queue.
- **`maxObjects`:** most objects one mirror root may hold (default 500). A pull
  that would hold more is refused; `--max-objects` on the call raises it.
- **`namespaces`:** customer namespaces whose packages may be mirrored. Without
  them only packages starting with `Z`, `Y` or `$` can be a mirror's root
  package.
- **`git.enabled`:** `true` lets `git clone adtplus::<system>/package/<PKG>`
  (or `…/swc/<SWC>`) use the system (ADR-011); off unless set. Without it every request of the git
  remote helper is refused: "git remote not enabled for <system>".

A clone's own settings are git config (`git clone -c …` or `git config` in the
clone): **`adtplus.maxObjects`** raises the object ceiling for its fetches and pushes, like
`--max-objects` on a pull (for a software component also its search, which is refused above it); **`adtplus.transport`** is the request a push records in when
`-o transport=` doesn't name one; **`adtplus.fullFetch`** `true` (that spelling only) makes every fetch a full read
instead of re-reading only the objects whose change stamp moved; **`adtplus.history`**
`transports` (default `none`) adds one commit per released transport request (ADR-011), from
**`adtplus.since`** on (a date, default one year before the clone). History is fixed at the clone:
both count when the clone is made (`git clone -c adtplus.history=transports …`); switched on
later, history starts with that fetch.

Mirror commands (`mirror.init`, `pull`, `push`, `activate`) and the git helper's own
(`mirror.changes`, `swc.packages`, `history.versions`, `history.released`) run in a **bulk lane** of the rate limit (ADR-008): bounded by
`mirror.concurrency` calls in flight, not paced per minute, never refused for
budget, and their units don't count against `perMinute`, so a clone running at
full speed leaves the interactive budget to other commands. A 429/503 cooldown
stops them like any command; running them again carries on. Their results still
report `units` next to `calls` (a pull weighs about 6.8 units per object).

## Format

What `quality format` formats with (ADR-017). Per system in `systems.json`, all optional; without
it, SAP's formatter:

```json
"format": { "engine": "abap-cleaner", "abapCleaner": { "path": "~/bin/abap-cleaner", "profile": "~/team.cfj", "release": "758" } }
```

- **`engine`:** `sap` (default) formats as ADT's Format does, with the logon user's pretty printer
  settings on the system; nothing to install. `abap-cleaner` runs the abap-cleaner binary locally:
  more alignment, and CDS text that isn't saved yet.
- **`abapCleaner.path`:** the binary, absolute or `~/`. Default: the newest one of VS Code's
  abap-cleaner extension (`saposs.abap-cleaner`) across `~/.vscode`, `~/.vscode-insiders` and
  `~/.vscode-server` (remote), looked up once per daemon. Without either, a format fails naming
  this setting.
- **`abapCleaner.profile`:** an abap-cleaner profile (`.cfj`, exported from its profile editor),
  absolute or `~/`. Default: adt+'s own, abap-cleaner's 47 layout rules (empty lines, spaces,
  indentation, case, alignment, CDS line breaks) with their default settings and every rule that
  rewrites code off. A team profile with rewriting rules on is refused call by call: a result whose
  code changed is never returned.
- **`abapCleaner.release`:** the newest ABAP release whose syntax a rule may use
  (`--release`, e.g. `"758"`). Default: any; the layout rules introduce no syntax.

A project config that changes `abapCleaner.path` or `.profile` is marked ⚠ in the approval dialog: it
names a program adt+ runs, or what it runs it with.

## Deny list

`ADTPLUS_DENY` names daemon commands to refuse. Separate them with commas; each
may end in `*`: `ADTPLUS_DENY=object.delete,transport.release,run.*`.

- It takes effect on the daemon side and the client side, like
  `ADTPLUS_READONLY` (below).
- The MCP server leaves denied actions out of its tool schemas and doesn't
  register a tool that has no actions left.
- A pattern that matches no command makes the daemon refuse everything, naming
  the pattern, so a typo or a name from before a rename (ADR-018) can't leave the
  command it was meant to deny running.
- Packages and message classes go through the object commands (`object.read`,
  `object.validate`, `object.create`, `object.update`, `object.delete` for
  `DEVC/K` and `MSAG/N`), message classes also `object.deleteMessages`, so
  `object.delete` denies deleting a class, not its messages.
- A mirror write is refused as a whole, before anything is written, when the
  list denies a command it runs underneath: `mirror.push` checks
  `object.update`, `object.activate` (unless it doesn't activate),
  `transport.assign` (with a transport), `object.create` (when it would
  create an object) and `object.update` (when it would write a
  message class, ADR-014);
  `mirror.activate` checks `object.activate` (ADR-007).

The command names are the `cmd` values in `src/daemon/protocol.ts` (`ALL_CMDS`).
Use the deny list in VS Code: *Allow all* and *Autopilot* auto-approve every
tool call, even one set to `chat.tools.eligibleForAutoApproval: false`.

## Read-only mode

With `ADTPLUS_READONLY=1`, adt+ refuses every command outside a read allowlist
(`src/daemon/readonly.ts`) with `{"ok":false}`, before it touches any SAP
session. It takes effect from either side:

- A daemon started with it refuses for everyone.
- A client (MCP server or CLI) running with it stamps `readOnly` on each
  request, so the client stays read-only even on a daemon that another,
  unrestricted client started.

`status` reports the daemon's own mode, and the full call log
(`ADTPLUS_LOG=1`, below) shows the stamp per request. Read-only mode is meant for driving adt+ from a client that can't deny
single actions, such as an unattended agent run with every tool allowed.

## Call log (on by default)

The daemon appends one JSONL line per request to `~/.cache/adtplus/calls.jsonl`
(ADR-005). `ADTPLUS_LOG` in the daemon's environment sets what it holds:

| `ADTPLUS_LOG` | File | A line holds |
|---|---|---|
| unset or empty | `~/.cache/adtplus/calls.jsonl` | metadata only: time, `client` (`mcp` or `cli`), `cmd`, system, `config` (the project configs used, when any), duration, `ok` |
| `1` | `~/.cache/adtplus/calls.jsonl` | the metadata, the error text and a size-capped digest of the params |
| a file path | that file | as for `1` |
| `0` | — | off: adt+ opens and writes nothing |

The params digest is for checking what a client sent, including the `readOnly` stamp. Source
bodies and anything that looks secret are never logged, in either form.

The daemon reads the variable at start, so restart the daemon and the MCP
server after changing it.
