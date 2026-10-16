# ADR-017: Formatting through SAP's formatter by default, abap-cleaner as an opt-in engine

- Status: accepted 2026-10-12

## Context

Probed read-only on `onprem` and `cloud-erp`:

- adt-ls formats although its static capabilities say `documentFormattingProvider: false` (it
  registers formatting per document on `didOpen`). The SDK's `format` covers ABAP and CDS,
  following the logon user's pretty printer settings on the system; it formats the text sent with
  `didOpen`, not the stored copy. The SDK sends only the stored text, and `raw.lsp` sends no
  notifications, so text not saved can't go through adt-ls today.
- ADT's REST pretty printer (`POST /sap/bc/adt/abapsource/prettyprinter`, text in, text out, no
  object) gives the same ABAP; it leaves CDS unchanged.
- Neither refuses broken syntax: both return the text with its indentation scrambled.
- abap-cleaner (SAP, Apache-2.0; the binary the VS Code extension bundles) formats ABAP and CDS
  locally in about 1.5 s cold, aligns more than the pretty printer, and stops on a parse error. Its
  default profile also rewrites code (`a = a + b` → `a += b`); a profile with its 47 layout rules
  only doesn't.

## Decision

- **One read action**, `adtplus_quality format` (CLI `quality format`): one object's stored
  source, or `source` text as that object's. It returns the formatted text with `\n` line ends;
  it never writes. Writing it back stays `update` (or a mirror push); a format that saves is a
  write path under ADR-003 and needs its own decision.
- **Engine per system**, `format.engine` in `systems.json`, merged by key (ADR-006):
  - `sap` (default): the stored source through the SDK's `format`; `source` text through the
    REST pretty printer (ABAP only, `via: "rest-fallback"`). Text in DDL syntax (CDS, BDEF, SRVD,
    TABL, DSFD …) is refused until the SDK can send text.
  - `abap-cleaner`: the text (stored source read through adt-ls, or `source`) through the
    abap-cleaner binary, locally. `format.abapCleaner.path` defaults to the newest binary of the
    abap-cleaner VS Code extension; `format.abapCleaner.profile` to adt+'s layout-only profile;
    `format.abapCleaner.release` (abap-cleaner's `--release`) is unset by default.
  Same engine for both inputs, so text formatted before a write and the stored source formatted
  after it agree.
- **Formatting never changes code.** ABAP: the input and the output must have the same abaplint
  tokens, keyword and identifier case aside, whitespace inside comments aside. DDL syntax: the same
  text once whitespace is removed and case ignored (comments included, which abaplint's CDS tree
  lacks), and for a data definition abaplint parses, the same literals. A result that doesn't is
  refused, naming the first difference. This holds for every engine and profile, and catches a
  rule a newer abap-cleaner adds and switches on by default.
- **The REST fallback has no runtime probe** (an exception to ADR-002): what it waits for is an SDK
  release whose `format` takes text, not a system feature. The SDK feature request is in the
  backlog; the `adtls-upgrade.md` checklist checks for it.
- **A project config that changes `format.abapCleaner.path` or `.profile` is marked ⚠** in the
  approval dialog: it names a program adt+ runs.

## Consequences

- Without configuration, nothing new is installed or run: SAP's formatter, as ADT's Format does it.
- abap-cleaner errors (no binary found, a parse error) fail the call with abap-cleaner's message;
  adt+ doesn't fall back to the other engine, which would format differently.
- abap-cleaner writes its own error log under `~/Library/Application Support/com.sap.adt.abapcleaner/`
  on a parse error; adt+ doesn't touch it.

## Changes

- 2026-10-15: restated as it holds today for the public release.
