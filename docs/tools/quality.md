# Quality

SAP's syntax check, formatting, ATC and local abaplint. Tool: `adtplus_quality` (CLI `adtplus quality
syntax|format|atc|atc-variants|abaplint`). ABAP Unit is in [test-and-run.md](test-and-run.md).
Backend and gate letters: [capabilities.md](../capabilities.md#legend).

| Action | Backend | Gate | Verified |
|---|---|---|---|
| [syntax](#syntax) | adt-ls (`source`, JSON types: REST) | — | both |
| [format](#format) | adt-ls (`source`: REST); abap-cleaner: local | — | both |
| [atcVariants, atc](#atcvariants-atc) | adt-ls | — | both |
| [abaplint](#abaplint) | local | — | both |

## Batch checks

`syntax`, `atc` and `abaplint` take `refs` (at most 50) or a `package` and answer with
one summary.

- Exactly one target: `name` + `objectType`, `refs` or `package`; more than one, or `name` without
  `objectType`, is refused, never narrowed to one of them.
- A package contributes its CLAS, INTF, PROG, FUGR, DDLS, DCLS, DDLX, BDEF, SRVD, TABL; subpackages
  on request; walked up to `mirror.maxObjects`, refused over 50 checkable.
- The summary: counts per severity and per check; findings errors first (at most 100, the rest
  counted as `omitted`) with object, file (`uri`, VS Code's namespace; abaplint: `file`) and line;
  the objects whose check failed.
- Per object, `rateLimit.concurrency` at a time; a cooldown fails the whole call (`throttled`,
  `retryAfterMs`).

## syntax

- Without `source`: the stored source, unactivated changes included (adt-ls). SAP reports the
  first error only.
- With `source` (one object; with `include`, a class include): that text instead, nothing saved.
  REST check run with the text as artifact (`via: "rest-fallback"`), because adt-ls checks only
  the stored source, whatever text it is sent. Findings in adt-ls's shape (0-based LSP ranges,
  severity 1 error (E, A, X), 2 warning); one in another include or object carries its `uri`. A
  check run SAP reports as not processed is an error, never a clean result. An SRVB is refused.
- An SRVB is not checked (no source): not sent, not counted in a batch's `checked`.
- CHDO, NROB, RONT, NONT, DESD (AFF JSON): always through the check run (`via: "rest-fallback"`,
  `nativeAvailable: null`), because adt-ls 1.1.2 checks nothing for them (known-issues). Stored:
  the inactive version, the active one when there is none. `source`: the JSON text as it would be
  saved. SAP checks the JSON syntax, field values and references (domain, table); a JSON syntax
  error hides the rest. A finding SAP reports on the object without a position is at line 1.
- Findings on an inactive or missing dependency ("does not exist or is not active", "has inactive
  parts") are counted with the hint to activate the chain in one call.
- English texts only.
- Batch over `refs` or a `package`: [Batch checks](#batch-checks).

## format

One object's source formatted, layout only, never saved (ADR-017): the stored source as last saved
(the logged-on user's draft included), or `source` text as the object's. Returns `formatted` (`\n`
line ends, ending in a newline when the input does), `changed`, `engine`, `input`
(`stored`/`source`). Writing it back is `adtplus_object_write update`.

- **Engine** per system, `format.engine` ([configuration](../configuration.md#format)):
  - `sap` (default): SAP's pretty printer and CDS formatter, with the logon user's settings on the
    system (keyword case, indentation; CDS columns aligned), as ADT's Format. The stored source
    through adt-ls; `source` through ADT's REST pretty printer (`via: "rest-fallback"`,
    `nativeAvailable: null`), ABAP only: text in DDL syntax (CDS, BDEF, SRVD, TABL, DSFD …) is
    refused before any call.
  - `abap-cleaner`: the abap-cleaner binary, locally, ABAP and CDS, with adt+'s layout-only profile
    unless one is configured; also aligns declarations, parameters and select lists and
    standardizes empty lines. `source` needs no SAP call; the stored source is read through adt-ls.
- **Layout only, checked:** ABAP: the input and the result must have the same abaplint tokens,
  keyword and identifier case aside, comments compared without whitespace and case. DDL syntax: the
  same text without whitespace and case (comments included), and a data definition's literals
  exactly where abaplint parses it. A result that differs is refused, naming the first line that
  changed; with engine `sap` on the stored source, a source saved meanwhile is named instead.
- **Broken syntax:** SAP's formatter returns it anyway, with the indentation after the error
  scrambled; `unparsedLines` names the lines abaplint can't parse, with a note. abap-cleaner refuses
  with its parse error ("expected ENDLOOP, but found ENDMETHOD").
- A class: its main source only, not its local test classes or other includes.
- An SRVB is refused (no source).
- Cost: `sap` stored 3 SDK calls; `sap` `source` 1 REST request; `abap-cleaner` about 1.5 s per call
  (a new process each time), plus 2 SDK calls for the stored source.

## atcVariants, atc

- ATC runs synchronously.
- A batch runs one ATC call per object: adt-ls has no multi-object run with lines.
- `timeoutMs` per object, default 180 s (the SDK's 60 s was too short for `onprem`'s default variant).
- A finding can lie in another object's file (SAP code).
- **`quickfixes: true`** runs ATC through SAP's worklist instead (adt-ls's `abap_atc_run` +
  `abap_atc_get_result`, polled every 2 s up to `timeoutMs` per object): one run for all `refs`, each
  finding with `quickfix` (a deterministic fix exists), no line numbers. The result's
  `worklistId` goes to [`applyQuickfixes`](objects.md#applyquickfixes).
- Which variant offers quick fixes depends on the system and the finding: on `onprem`
  `ABAP_CLOUD_READINESS` did (language-version findings), the default and `/CC4A/CODE_PAL_FULL`
  didn't; on `cloud-erp` `FUNCTIONAL_DB` and the cloud default did (UP TO n ROWS without ORDER BY).
- A name the backend can't find fails "Error executing tool: null"; adt+ adds that this means
  object not found. A run the backend ends with a text ("ATC run was cancelled. Check transaction
  ATC for details.", `onprem`'s `ABAP_CLOUD_DEVELOPMENT_DEFAULT`) fails with that text at once.

## abaplint

- Cloud/on-prem preset from `languageVersion`; the main source only.
- `mirror check`'s rules, error split (ADR-012) and per-type drops; `rules` switches more on or
  off.
- `no_comments_between_methods` isn't reported on an `ENDMETHOD` line, which SAP stores.
- Batch as atc, but all sources go into one registry, so with `check_syntax` switched on a call
  into another batch object is checked.

## Known issues

- **abaplint's `no_comments_between_methods` flags a comment on an `ENDMETHOD.` line**, which SAP
  stores in the method's include (`onprem`): filtered in `mirror check`, `quality abaplint` and the
  pre-write check; to be reported upstream (backlog).
- **A clean `syntax` check does not guarantee the save succeeds**: an indented `*` comment passed
  `syntax` and failed the native save.
- What abaplint misreads on AFF files: [mirror.md, "abaplint on AFF files"](mirror.md#abaplint-on-aff-files).
