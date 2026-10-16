# ADR-018: 14 tools, one risk tier each, named after SAP's terms; AFF JSON for form-based objects

- Status: accepted 2026-10-12

## Context

- **The tool is the only unit a person can approve** in the clients adt+ targets: VS Code approves
  a tool once, per session, per workspace or always; terminal agents allow or deny tools by name.
  None approves an action. A tool that mixes reads and writes makes approving a search also
  approve a delete, and can't carry an honest `readOnlyHint`.
- VS Code honours `readOnlyHint`, so split read tools cost no prompt at the default approval level.
  Terminal agents ignore annotations; there only the split and per-tool rules count. Under Allow
  all or Autopilot nothing client-side holds, hence ADR-003.
- Action names copied from the SDK (`documentSymbols` → `symbols`, `findReferences` →
  `references`) mean nothing to someone who knows ABAP tooling. A tool boundary that follows a
  backend (packages went through REST, so they had their own tool) means nothing either: a
  package is a repository object.
- Daemon command names are user-facing: `ADTPLUS_DENY` takes them.

How SAP names the same things (ADT for VS Code and VS Code, Eclipse ADT and SAP's ADT MCP server):
Outline; Where-Used List; Type Hierarchy; Check; Format; ABAP Test Cockpit; Publish / Unpublish;
Run ABAP Application (Console); Run ABAP Unit Tests; ABAP Runtime Errors (ST22).

## Decision

### One risk tier per tool

Each tool is read, write, execute or irreversible, never a mix, so approving a tool grants exactly
one kind of risk.

- Annotations come from one table; a test derives `readOnlyHint` from the read-only commands and
  checks both directions.
- `ADTPLUS_READONLY` registers only the tools that don't change the system; `ADTPLUS_DENY` drops
  denied actions from the enums and a tool left with none (ADR-003).
- Unit tests have their own tool, so a review agent can hold them without `run`.
- No MCP elicitation as confirmation: Autopilot answers it itself.

### Naming rule

- **SAP's term where the concept is ABAP-specific** (where-used, check variant, publish, runtime
  error, validate, quick fix as SAP's API spells it); **VS Code's term where it is a generic
  editor function** (definition, declaration, hover, outline, format).
- **Never a name only because the SDK's method has it.**
- A description leads with SAP's term where the action name is a shorter one (`dumps`: "ABAP
  runtime errors (short dumps, ST22)").
- **One name through every layer:** a daemon command is `<area>.<action>`, the area being the MCP
  tool's name without `adtplus_` and `_write`; the CLI is the same in kebab case, `adtplus <area>
  <action>`; irreversible actions sit under their area (`object.delete`). A tool without an
  `action` has one implied action in the daemon (`test.unit`, `run.application`, `data.query`),
  and the CLI leaves it out: `adtplus test`, `adtplus run`, `adtplus data`.
- **`ADTPLUS_DENY` refuses a name it doesn't know**: a stale name can't silently deny nothing. A
  later rename keeps a table of old names, and the error names the new one.
- **Parameters:** `transport` for a request or task everywhere, `package` everywhere
  (`superPackage` is SAP's term and stays), `maxResults` for every result cap.
- The git helper's internal commands (`mirror.changes`, `swc.packages`, `history.versions`,
  `history.released`) and `ping`/`shutdown` are on no surface.

### The 14 tools

| Tier | Tool | Actions |
|---|---|---|
| read | `adtplus_system` | status, connect, messages |
| read | `adtplus_object` | search, resolve, read, translations, list, versions, diff, listInactive, lockStatus, validate, generators, generatorSchema, serviceInfo |
| read | `adtplus_navigate` | whereUsed, definition, declaration, hover, outline, typeHierarchy |
| read | `adtplus_quality` | syntax, format, atc, atcVariants, abaplint |
| read | `adtplus_transport` | list, find, check, read, diff |
| read | `adtplus_mirror` | init, pull, status, check, new |
| read, switched | `adtplus_runtime` | dumps, dump, gatewayErrors, gatewayError |
| read, switched | `adtplus_data` | (query) |
| write | `adtplus_object_write` | create, update, activate, publish, unpublish, generate, applyQuickfixes |
| write | `adtplus_transport_write` | create, assign |
| write | `adtplus_mirror_write` | push, activate |
| irreversible | `adtplus_irreversible` | deleteObject, deleteMessages, releaseTransport |
| execute | `adtplus_test` | (unit) |
| execute, switched | `adtplus_run` | (application) |

- **Packages are objects** (`DEVC/K`): read, validated, created, updated and deleted like any
  object; the write gate keeps its rule that a package lands in its superpackage (ADR-003), and
  only an empty package is deleted.
- **`syntax` and `format` are in `adtplus_quality`**: neither takes a locator, both are checks or
  layout, and a review agent holding `adtplus_quality` gets them. `adtplus_navigate` keeps the
  actions that take a locator (`symbol`, or `line` + `character`).
- **`validate` takes any type** once the SDK's creation validation is probed for it; packages
  today, other types refused until then.
- **System messages (SM02) are `adtplus_system messages`, without a switch**: operational notices
  an administrator writes (maintenance windows, imports), no program data. `status` never opens a
  session; `messages`, like `connect`, does.
- **`publish` and `unpublish`**, not a toggle: each reads the binding's state first and is refused
  when it is already there; the gates are the write allowlist, `confirm: true` and
  `allowPublishService`.

### `update`: source, or the type's AFF JSON

- `update` takes `source` for a source-based object (CLAS, INTF, DDLS, BDEF …; `include` for class
  includes), or `properties` for a form-based one (MSAG, DEVC, DOMA, DTEL, TRPR). Never both.
- **`properties` is the type's AFF JSON** (`msag-v1`, `devc-v1`, `doma-v1`, `dtel-v1`): SAP's field
  names, the shape `object read` returns for the type and a mirror's `<name>.<type>.json` holds,
  validated against AFF's schema. A key the schema doesn't have is refused with the type's fields.
  A type without an AFF format gets adt+'s own shape, decided with the type (TRPR, ADR-019).
- **Merged by key, never replaced:** objects key by key, lists by their key field (`messages` by
  `number`, `fixedValues` by `fixedValue`). What isn't sent stays as it is; leaving an entry out
  never deletes it. Deleting stays in `adtplus_irreversible`.
- **Read-only keys are refused:** `formatVersion`, `header.originalLanguage`, and for DEVC what the
  write gate reads (`generalInformation.superPackage`, the language version).
- **Type rules stay with the type:** a changed message class description is refused (ADR-014).
  AFF's `msag-v1` has no self-explanatory flag, so an update keeps each message's flag and a new
  message gets SAP's default.
- `create` takes the same `properties` for a form-based type. A source-based type takes
  `additionalFields`, the SDK's creation fields (`rootEntity`, `bindingType` …), which are not AFF.

## Consequences

- More tools means a larger routing choice for a cheap model; tool descriptions carry the user's
  phrasing, since routing follows them, not the action names. Routing is checked with evals outside
  the repo (ADR-020).
- VS Code caches tool schemas: a surface change needs an MCP server restart.
- Where future work lands: source code search in `adtplus_navigate`; table types, class changes
  (add a method, change a signature) and BAdI implementations in `adtplus_object_write`;
  transport reassign in `adtplus_transport_write`, transport delete in `adtplus_irreversible`;
  test discovery in `adtplus_quality`; local format and local unit tests in `adtplus_mirror`; an
  SQL notebook in `adtplus_data`; system information in `adtplus_system`.
- Not adopted: Claude Code's `_meta["anthropic/requiresUserInteraction"]` to force a prompt on
  `adtplus_irreversible` and `adtplus_run`; it would apply to every Claude Code user, and other
  clients ignore it.

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADR it absorbed merged in.
