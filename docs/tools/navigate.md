# Navigate

Where-used, definition, declaration, hover, outline and type hierarchy. Tool: `adtplus_navigate`
(CLI `adtplus navigate where-used|definition|declaration|hover|outline|type-hierarchy`). The syntax
check and formatting are in [quality.md](quality.md). Backend and gate letters:
[capabilities.md](../capabilities.md#legend).

| Action | Backend | Gate | Verified |
|---|---|---|---|
| [whereUsed](#whereused) | adt-ls + source scan | — | both |
| [definition, declaration, hover](#definition-declaration-hover) | adt-ls | — | both |
| [outline, typeHierarchy](#outline-typehierarchy) | adt-ls | — | both |

## whereUsed

SAP's where-used list (adt-ls's LSP references), plus a scan of the object's own source.


- Scans the object's own includes, active **and** inactive: active via
  `source.read({version: 'active'})` while the object is locked in the daemon; nothing more is read
  when no include has an own draft.
- The scan reads abaplint's statements and tokens: comments, string literals and a template's
  text don't count, a template's embedded expression does. The name a `METHODS` or `METHOD`
  statement declares is a `declaration`, any other use a `call`. For `ZCL_X=>METH` it looks for
  `METH`, leaving out static calls of another class; for `lo_x->meth`, for every `meth`.
- Empty ≠ "no users".

## definition, declaration, hover

- CDS: hover/definition only.

## outline, typeHierarchy

- ABAP only; empty on CDS.

## Known issues

- **`whereUsed` under-reports on a cold index** and misses same-object callers; the source scan
  covers the latter.
