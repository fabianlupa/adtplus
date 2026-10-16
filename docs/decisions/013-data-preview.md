# ADR-013: Data preview through free SQL, one switch per system

- Status: accepted 2026-10-10

## Context

Looking into a table or view is part of developing it, as Eclipse ADT's Data Preview and SQL
console show, and ADR-005 allows it as the operator's switch. A finer limit, such as "only the
operator's own objects", can't be held:

- A Z CDS view can select from any table. Previewing it passes as "own" and shows SAP data.
  Following a view's data sources to stop that would mean parsing DDL ourselves (ADR-012).
- adt+ already reads anything without a preview: a test method can select any table and return
  the rows in an assertion message, and `adtplus_run` reads anything directly.

What does limit a read is the SAP user's authorizations and the system's ABAP language version
(ABAP Cloud refuses unreleased SAP tables; on-premise reads any table), plus the operator's
decision to switch preview on.

adt-ls has no data preview. ADT's `POST /sap/bc/adt/datapreview/freestyle` runs one SELECT on
both systems; SAP refuses anything else.

## Decision

- **Free SQL only**, through `datapreview/freestyle`, a REST fallback (ADR-002) that retires when
  adt-ls offers data preview. No separate table/view preview: free SQL reaches the same objects,
  and a CDS view with parameters is a SELECT too.
- **Off by default. One switch per system**, `allowDataPreview: true`. A gate field for project
  configs (the trust dialog, ADR-006). No levels.
- **SAP keeps it to one SELECT.** adt+ checks the statement only through abaplint's parse
  (ADR-012), before it opens a session: a statement that isn't one SELECT is refused, and so is one
  abaplint can't parse, since what it reads can't be told. adt+ sends abaplint's tokens of the
  statement, the text it checked, so no comment can swallow the `INTO` and `UP TO` that SAP
  appends.
- **Only the logon client.** A SELECT that reads another client (`CLIENT SPECIFIED`, `USING
  CLIENT`, `USING CLIENTS IN`, `USING ALL CLIENTS`, in subqueries too) is refused: on-premise such
  a statement reads any client, the reserved 000/066 included (ADR-005). A SELECT on another
  database (`CONNECTION`) is refused the same way.
- **Small results:** 100 rows by default, at most 1000. Cell values and the whole result are cut at
  a size limit, and the result says when rows or values were cut, with SAP's total row count. No
  paging, no export to a file.
- **Call log:** metadata only, no statement text, no rows (ADR-005).
- **Its own tool**, `adtplus_data` (daemon `data.query`, CLI `adtplus data`), so a person approves
  it apart from the code reads. Read-only, listed only for systems that allow it, its `system`
  enum holding only those.
- **`ADTPLUS_READONLY` keeps it**: it changes nothing on the system, and the per-system switch is
  the gate. `ADTPLUS_DENY=data.query` takes it out.

## Consequences

- An operator who switches preview on for a system gets every table the SAP user may read there.
  The docs say so where the setting is described.
- Bulk reads stay out: a caller who wants more rows calls again with a narrower statement, each
  call against the budget.

## Changes

- 2026-10-15: restated as it holds today for the public release.
