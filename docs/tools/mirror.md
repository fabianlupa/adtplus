# Mirror

> **Experimental.** Less live-tested than the other areas; file layout and settings may still change.

Pull packages as AFF files into a local folder, check them offline, push them back (ADR-007;
checks ADR-012; bulk lane ADR-008; message classes ADR-014). Tools: `adtplus_mirror` (read),
`adtplus_mirror_write` (write). Settings: [configuration.md](../configuration.md#mirror). Backend
and gate letters: [capabilities.md](../capabilities.md#legend).

| Action | Backend | Gate | Verified |
|---|---|---|---|
| [init](#init) | adt-ls + local | — | both |
| [pull](#pull) | adt-ls + local | — | both |
| [status](#status) | local | — | — |
| [check](#check) | local | — | both |
| [push](#push) | adt-ls | A (each object, package from the system; a new object: its folder's package) | both |
| [activate](#activate) | adt-ls | A (each object) | both |
| [new](#new) | local | — | both |

## init

- One mirror root per system.
- Root package `Z*`/`Y*`/`$*` or a `mirror.namespaces` prefix; a package the system lacks is allowed
  with a note.
- Writes `.adtplus/mirror.json` and AFF's `.editorconfig`.
- The root must lie inside a workspace folder (MCP roots; CLI: the working folder).

## pull

**Reading.**

- Walks the package tree (subpackages unless `init --no-subpackages`) and reads every file under a
  shared object hold.
- Runs in the rate limit's bulk lane (ADR-008): up to 3 objects at once (`mirror.concurrency`,
  capped at 3 for adt-ls), no per-minute pacing.
- Files LF with a final newline, hashes over normalized content (ADR-007); `.jsonc`/`.properties`
  written `0444`.
- **Draft flag** per file from `abapStat`, sent only for objects the user's inactive list
  (`listInactive`, one call per pull) names. CLAS, PROG, INTF, DDLS, BDEF, TABL and SRVD objects it
  doesn't name have no draft and get no stat (P11); other types are stat'ed file by file; every file
  when the list fails.

**Message classes** (ADR-014):

- Read over REST instead of adt-ls's `.msagn.jsonc` stub, written as AFF's `<name>.msag.json`
  (`msag-v1`: description, original language, messages by number; master language; 1 request, 2
  when the logon language isn't the master language).
- An older pull's stub is dropped once the `.msag.json` replaces it (a pull of named objects falls
  back to a full pull while the manifest holds one).
- A pull of named objects reads it the same way and asks REST whether it still exists.

**Re-pull**, per file:

- system-only change taken, local-only change kept, both → `<file>.remote`;
- gone on the system → deleted if unchanged locally, else kept and reported;
- an object missing from the listing counts as gone only when a name search doesn't find it either
  (`onprem` leaves a view that was never activated out of the listing); otherwise it is kept and
  reported as `notListed`.

**Limits and cost.**

- Refused over `maxObjects` (500); a stopped pull resumes on the next call.
- ~6.8 units per object (ADR-008: folders 1, file reads 2, `abapStat` 0; `listInactive` 3,
  untraced), outside the interactive budget.
- No `--objects`/`--where-used`/`--active` yet (backlog M1b).

## status

Local changes against the manifest: modified, read-only files changed, deleted, new local files,
`.remote` files, read errors (a pull's, or the read-back after a push's write), unfinished pull,
adt-ls version change.

## check

No SAP call. abaplint lints each object at the language version its `.json` names
(`header.abapLanguageVersion`), one without at the system's (`cloud`: `cloudDevelopment`, `onprem`:
standard); abaplint takes one version per run, so each version is a run of its own and a reference
into another version is void. The result counts objects per version (`languageVersions`). `ok` = no
errors (CLI exit code 1 otherwise).

**What it runs on every file under `src/`:**

- **abaplint stage 1** (ADR-012): errors SAP's syntax check would refuse, likely bugs as warnings,
  style/naming/`check_syntax` off; `rules` switches more on or off; unknown references void.
  - Findings that misread AFF are dropped per type ([below](#abaplint-on-aff-files)); NONT/RONT
    and other unknown types aren't linted.
  - `no_comments_between_methods` isn't reported on an `ENDMETHOD` line.
  - A class frame comment the rule misses, between definition and implementation or after the last
    `ENDCLASS`, is the warning `class_frame_comment`, since push refuses it unless the system's
    version has it (ADR-012).
- **`.json` against AFF's schemas** (25 vendored, MIT, `msag-v1` among them; `.srvb.json`'s empty
  `serviceBuildVersion` excused, ADR-007).
- **AFF's `.editorconfig` rules** (reported, never fixed).

**Errors** (everything else is a warning):

- parse errors and schema violations;
- abapGit's class include names (`.clas.locals_imp.abap`/`.locals_def.abap`, rule
  `aff_file_name`, naming AFF's `.implementations`/`.definitions` file);
- a `.msag.json` push won't send (`msag_file`: a number twice or not three digits, a line break;
  ADR-014);
- the RAP rules of ADR-012 (text-level, over `.tabl.ddic`, `.bdef.abdl`, `.dcls.acds` with the
  local `.ddls.acds`; each message names the fix): `tabl_semantics_reference`,
  `bdef_strict_authorization`, `bdef_authorization_master`, `bdef_projection_strictness`,
  `bdef_implementation_type_first`, `dcls_unknown_element`.

**Output.**

- Findings as `path:line` + rule + message, at most 50 (errors first), counts per rule; never
  source.
- Files the manifest has that are missing on disk (a whole object, its folder, or one file) are
  listed as `deleted`, as `status` lists them: deletions a push never sends, not checked. A file
  deleted while the check runs (an `rm` beside it) is skipped, and listed there when the manifest
  has it.

**Not a server check:** function modules and tables aren't syntax-checked locally (the result says
so), and the RAP rules cover only what the M5 runs showed SAP refusing. No `--remote` (backlog).

## push

ADR-007. `complete: false` (CLI exit 1) when anything is left undone.

**Plan.**

- From local hashes: every file read and hashed on each call, no mtime/size shortcut or cache, so a
  file is planned once it is on disk. `status` and the plan share one scan of local changes
  (`mirror/scan.ts`).
- `dryRun` makes no SAP call.

**Per existing object.**

- Resolve by name, allowlist gate; refused when the system's package differs from the manifest's.
- **Conflict check:** a fresh read of every changed file must match its base (or, after a conflict,
  its `<file>.remote`: ADR-007, the `.remote` deleted once settled); else the object is a conflict
  and nothing of it is written.
- Writes in the system's line style (majority ending, final newline as there), source before
  `.json`; the new base comes from a refreshed read-back.
- Locks and other users' drafts → `blocked` with SAP's message.
- A class whose main source has a comment outside its sections and methods (the `update`
  rule, against the system's version push reads before writing; not on a dry run) is `blocked`,
  nothing of it written; a new one is `cannotCreate` (also on a dry run).
- One object at a time (adt-ls takes one lock attempt per session).

**Transport.** An object in no open request ("Object not assigned to a transport", code 1001): with
`transport` the written file is assigned to that request and written again, per file (adt-ls keeps
an assignment per file), the change recorded there; without, `blocked`.

**Activation.**

- One activation for everything written (batches of 50); diagnostics as local `path:line`
  (object-level on the `.json`, `line: 0`).
- `abapStat` decides what is active (a failed stat counts as inactive when the activation failed or
  reported an error on the object, else as active).
- Objects an earlier push left inactive go into the same activation (one failing object leaves a
  batch's non-DDIC objects inactive).
- An object this push wrote or created and then stopped writing partway (a failed write or
  read-back before its last file) is left out of the activation, never activated as a mix of old
  and new files; it stays in `unactivated` until a push writes the rest. `unactivated` doesn't list
  the `(was <package>)` entries a move leaves.

**New objects** (files no manifest object owns, grouped by folder and `<name>.<type>.`):

- Types: CLAS, INTF, PROG, DDLS, DCLS, DDLX, BDEF, SRVD, SRVB, TABL with their `.json`; anything
  else, or no `.json`/description, is `cannotCreate`.
- File names in lower case, as adt-ls serves them; another case is `cannotCreate` with the name to
  rename to, before the create.
- The package is the folder's (a folder the manifest doesn't know is accepted when the package's
  chain on the system ends with the folders below `src/`); allowlist gate.
- In a package that records changes only with `transport` (else `blocked`, no SAP call; `onprem`
  otherwise refuses some types and files others in a request it generates).
- Created with the description from the `.json` and the fields only the files say: BDEF root entity
  and implementation type from the source (refused when the name isn't the root entity's); SRVD
  `sourceType: "S"`; SRVB binding type and service definition from the `.json`.
- Then entered in the manifest with the system's templates as base and written like an existing
  object; a file the system keeps differently is replaced locally (`rewritten`).
- A name that exists, or is locked in another request, comes back with SAP's message
  (`conflicts`/`blocked`).
- **Read-back after activation:** the system completes a new object at activation (class include
  templates and `texts.en.properties`, a DDLS `.json`'s `sourceType`). An activated new object's
  folder is read back once under pull's per-file rule (`activation.readBack`: files taken; a local
  change kept and the system's version in `<file>.remote`, which leaves the push incomplete), so no
  pull is needed after a greenfield push.
- A created object not activated yet keeps a `created` mark in the manifest (across a pull too) and
  is read back by the push or `mirror activate` that activates it (~1 unit per object plus 2 per
  file).

**Message classes** (`.msag.json`, ADR-014) go through the REST path of a message class `update`, not
adt-ls:

- The file is checked (msag-v1's fields only, three-digit numbers once each, texts ≤ 73 and
  description ≤ 60 characters, no line break; else `failed`, nothing sent).
- The allowlist gate takes the package REST names; the conflict check compares the system's
  rendering with the base (or `.remote`); the original language must be the class's.
- Changed and new messages are sent (a changed one keeps its self-explanatory flag), live at once:
  never activated, never `unactivated`. The new base is the read-back's rendering, which the local
  file takes unless something was left out.
- Left out and listed in `leftOut` (the push incomplete): messages removed from the file
  (`deleteMessages` deletes them) and a changed description (refused, see
  [`update`](objects.md#update)).
- A new `.msag.json` is created through `create`'s REST path in the logon language (a file naming
  another original language is `cannotCreate`), then its messages written.
- `ADTPLUS_DENY` is checked for `object.update` when the plan holds a message class.
- ~6 requests per written class plus its reads.

**Never sent:** `.jsonc`/`.properties`, local deletes, files moved to another package folder,
abapGit's class include names (`misnamed`, the message naming AFF's file; the rest of the object is
sent). A changed file with no base (its last read failed: a pull's, or the read-back after a write)
is never sent: `failed`, until a pull leaves the system's version in a `.remote`.

**Failures and resumption.**

- An error on one object (a failed read of the system's version, of a new object's files right
  after its create) costs that object, `failed`, not the push. A created object is in the manifest
  before anything after the create can fail.
- In the bulk lane like pull, resumable (manifest saved per file), refused over `maxObjects`; one
  call-log line per write.
- No stale-manifest check against git history yet (backlog).

## activate

- The objects a push wrote and didn't activate (`activate: false`, or an error), gated again.
- The same call and mapping as push, and the same read-back of created objects.

## new

- Skeleton files (main source + `.json`, LF, final newline) for CLAS, INTF, PROG (not on a cloud
  system), DDLS, DCLS, DDLX, BDEF, SRVD, SRVB (`.json` only), TABL, and MSAG (`.msag.json` only, no
  messages, the logon language as original language).
- In the package's folder (default: the mirror's root package; a subpackage only when the manifest
  knows its folder).
- `.json` as adt-ls serves a fresh object: `abapLanguageVersion` `cloudDevelopment` on a `cloud`
  system, none on `onprem` (the create gives the package's default; the push's read-back writes it).
- A BDEF is named after its root entity (ADR-007).
- Customer names only; refuses an existing object or file.
- Not added to the manifest: `status` shows the files as added, `push` creates the object.
- Every skeleton passes `check`.

## Known issues

- **Function groups** (`cloud-erp` and `onprem`, 2026-10-13): push writes an edited function module (or
  function group include) but activates the group through its main program, which leaves it inactive (`notActivated` names the
  group, no diagnostic; `object activate` on the module activates it). `mirror check` flags
  adt-ls's `.func.json` (no `includeNumber`) and `.reps.json` (no `header`) against AFF's
  schemas, so a mirror with a function group is never `ok` (backlog).
- **`onprem` leaves a view that was never activated out of its package's listing** (M5 VS Code run:
  three DDLS whose first activation failed were missing from the repotree folder while the BDEFs,
  equally inactive, were listed; `cloud-erp` lists such a view). A name search still finds them, under
  `Uncategorized Types/DDLSDF`. Mirror pull counted them as deleted and removed their files; it now
  asks the search before treating a missing object as gone (`notListed`).
- **`cloud-erp` can't serialize some stubs**: `zadtp_custcol_ui5r.uiadtyp.jsonc` in `ZADTPLUS_DEMO_2508_DRAFT`
  fails with "An error occurred during serialization in the simple transformation program
  SADT_BASIC_OBJECT" on every read. A mirror pull records it as the file's read error and goes on.

Cross-cutting ones that shape the mirror (no change date or ETag from adt-ls, `abapStat` on
`.jsonc` stubs, one lock attempt per session): [known-issues.md](../known-issues.md).

### abaplint on AFF files

`@abaplint/core` 2.120.54. `mirror check` (`mirror/lint.ts`) works around abaplint reading AFF only
in part. Retire an entry when abaplint reads that part of AFF (re-check each entry on an
upgrade).

- **Descriptions and texts:** abaplint looks for them in XML, AFF keeps them in `.json` and
  `.properties`: `description_empty`, `check_text_elements`, `selection_screen_texts_missing`
  misreport. Off by default (ADR-012); a caller who switches them on gets the false positives.
- **TABL:** `.tabl.ddic` doesn't parse (`check_ddic` "parser error", `tabl_enhancement_category`);
  both dropped for tables, so tables get only the schema and `.editorconfig` checks.
- **PROG includes** are taken for reports (`main_file_contents`); dropped for programs.
- **FUGR:** `.func.abap` fails to parse (`parser_error`, `structure` on `FUNCTION`) and the includes
  aren't found (`check_include`); dropped for function groups, so function modules aren't
  syntax-checked locally (the result says so).
- **MSAG:** neither the name nor the messages are read from `.msag.json` (`msag_consistency`:
  "Message class name "undefined""; rechecked 2026-10-10); dropped. `mirror check` applies push's
  own file check instead (`msag_file`: a number twice, a line break).
- **DTEL:** `findIssues` throws on AFF's DTEL example (`getRawRows`); a throwing object becomes one
  `abaplint_crash` warning and the others are still linted. DTEL is a stub in a mirror.
- **Unknown types** (NONT, RONT on `cloud-erp`): parser error "Unknown object type" and `cloud_types`; such
  objects aren't linted, the result counts them per type.
