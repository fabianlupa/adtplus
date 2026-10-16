# Data preview

`adtplus_data` (CLI `adtplus data`): one ABAP SQL SELECT through `datapreview/freestyle`
(ADR-013). Backend and gate letters: [capabilities.md](../capabilities.md#legend).

| Tool | Backend | Gate | Verified |
|---|---|---|---|
| `adtplus_data` | REST | D | both |

## What it runs

- One ABAP SQL SELECT without INTO: tables, DDIC and CDS views, joins, aggregates, UNION.
- Whatever the SAP user may read (`cloud-erp`, ABAP Cloud: released and own objects; `onprem`: any table). SAP
  runs a SELECT only.

## Refused before SAP

Before SAP and before a session opens:

- another statement;
- one reading another client (`CLIENT SPECIFIED`, `USING CLIENT`/`CLIENTS IN`/`ALL CLIENTS`) or
  another database (`CONNECTION`), subqueries included;
- one abaplint can't parse (ADR-012).

The statement is sent as abaplint's tokens, so comments never reach SAP.

## Result

- `maxRows` default 100, at most 1000 (SAP has no cap).
- Cell values cut at 500 characters (less when many columns share the limit); rows past 50,000
  characters left out.
- Values as SAP formats them for output: an INT4 `1` is `"1 "`, `-5` is `"5-"` (sign trailing).
- Rows as arrays in `columns` order, SAP's `totalRows`, `truncatedRows`/`truncatedCells`, the
  statement as SAP ran it.

## Availability

- Listed only while a system of the workspace folders sets `allowDataPreview: true`
  ([configuration.md](../configuration.md#data-preview-off-by-default)), in read-only mode too.
- The call log keeps the statement's length only.
