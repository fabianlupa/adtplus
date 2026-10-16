# ADR-012: Local checks — abaplint for ABAP, additions upstream

- Status: accepted 2026-10-10

## Decision

### ABAP only through abaplint

- adt+ never parses or tokenizes ABAP itself: no regex over statements, no hand-written state
  machine over the text. A local check of ABAP source (before a write, in `mirror check`, in
  `quality abaplint`, a data preview statement) runs abaplint: one of its rules, or its parsed
  statements and structures.
- A check abaplint doesn't have yet is proposed upstream (an abaplint issue or PR) and recorded in
  `backlog.md`. Until it is released, a stopgap may read abaplint's parsed statements (never the raw
  text) and is deleted when the release has it.
- A rule that is wrong against the system (a false positive found live) is filtered where adt+
  runs it, with the evidence recorded, and reported upstream the same way.
- Opening the upstream issue or PR is the maintainer's step: it publishes under their name.

### The default rule set: errors and likely bugs, style on request

`mirror check` and `quality abaplint` run the same rules (`mirror/lint.ts`):

- **errors:** what SAP's syntax check would refuse and abaplint finds without the system's objects
  (parser errors, mismatched begin/end names, a method implemented twice, comments between
  methods, …);
- **warnings:** likely bugs (unused variables and types, a missing `sy-subrc` check, unreachable
  code, identical conditions, …);
- **off:** everything else (style, naming, whitespace, documentation, abapGit XML) and the rules
  that need the system's objects (`check_syntax`, `implement_methods`, `unknown_types`). Unknown
  references stay void.
- A caller switches any rule on or off with `rules`; a rule switched on reports as a warning, an
  unknown rule name is refused.

### RAP files abaplint doesn't parse

`mirror check` adds rules over `.tabl.ddic`, `.bdef.abdl` and `.dcls.acds` (with the local
`.ddls.acds`) for mistakes SAP's activation refuses, reported as errors, each naming the fix
(`mirror/rap-rules.ts`): an amount or quantity field without its currency or unit reference, a
`strict` behavior definition without an authorization master, a projection stricter than its
base, `strict` before the implementation type, an access control naming an element its view
lacks. A rule that can't read a file reports nothing. These are files in CDS and BDEF syntax, not
ABAP; each rule goes when abaplint covers the case.

## Why

- A second ABAP parser drifts from abaplint, which the rest of adt+ already uses: a first
  hand-written class-region check disagreed with `mirror check` on comments on `ENDMETHOD` lines.
  abaplint is maintained against ABAP's grammar across releases; adt+ isn't. Upstream fixes reach
  every abaplint user, and adt+ loses its stopgaps.
- abaplint's full default (193 rules) buried what matters: 351 findings on 20 classes, about 95%
  style or rules that misread ADT/AFF sources. One rule set for both commands, so they agree on
  what an error is.
- `check_syntax` finds a mistyped call into another mirrored object, but without stubs it also
  calls SAP's own interfaces "not found". It stays opt-in until the check has stubs.
- Most failed activations in greenfield runs had one of the RAP causes above, and abaplint parses
  none of those files.

## Consequences

- Release-dependent RAP rules wait for the release's feature data (backlog).
- What abaplint misreads in AFF files is listed in [mirror.md](../tools/mirror.md#abaplint-on-aff-files).

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADRs it absorbed merged in.
