import { Comment, Expressions, Statements, Unknown } from '@abaplint/core';
import { decodeXml, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import { abapStatements } from '../core/abap-statements.js';
import type { Destination } from '../core/destinations.js';
import { assertDataPreviewAllowed } from './policy.js';

// --- REST fallback ---------------------------------------------------------
//
// adt-ls 1.1.2 bundles no data preview plug-in.
// Wire protocol, verified on `onprem` and `cloud-erp`:
//   POST /sap/bc/adt/datapreview/freestyle?rowNumber=<n>, the statement as text/plain,
//        Accept application/vnd.sap.adt.datapreview.table.v1+xml (anything else: 406)
//   → dataPreview:tableData: totalRows (the statement's full count), executedQueryString,
//     queryExecutionTime (ms), then column-major `columns`: `metadata` and a `dataSet` of `data`.
// SAP runs one SELECT and refuses anything else (400 "Only SELECT statement is allowed"), but
// sets no row cap: `rowNumber` is ours to limit. The language version decides reach: ABAP Cloud
// refuses unreleased SAP tables and `USING CLIENT`, Standard ABAP reads any table in any client.

const PATH = '/sap/bc/adt/datapreview/freestyle';
const MEDIA_TYPE = 'application/vnd.sap.adt.datapreview.table.v1+xml';

export const DEFAULT_ROWS = 100;
export const MAX_ROWS = 1000;
/** A longer cell value is cut to this many characters, fewer when many columns share MAX_RESULT_CHARS. */
export const MAX_CELL_CHARS = 500;
/** Rows past this many characters of cell values are left out. */
export const MAX_RESULT_CHARS = 50_000;

/** The statements abaplint finds in `body`, the report line and comments left out. */
function statementsOf(body: string) {
  return abapStatements(`REPORT zadtplus_data_query.\n${body}`).filter((s) => !(s.get() instanceof Statements.Report) && !(s.get() instanceof Comment));
}

const UNREADABLE =
  'adt+ could not read this as an ABAP SQL SELECT (abaplint), so it cannot check what it reads; write it in strict syntax (comma-separated fields, host variables with @)';

/**
 * The statement as adt+ sends it, or why it won't (ADR-013). abaplint parses it (ADR-012): it must
 * be one SELECT (SAP refuses anything else too), and adt+ sends abaplint's tokens of it, so
 * comments are gone and SAP's appended INTO and UP TO can't land in one. That text, with SAP's
 * INTO, is parsed again and refused when it reads another client (`CLIENT SPECIFIED`, `USING
 * CLIENT`, `USING CLIENTS IN`, `USING ALL CLIENTS`; the reserved ones included) or another
 * database (`CONNECTION`), in subqueries too. A statement abaplint can't parse is refused, since
 * what it reads can't be told.
 */
export function checkStatement(statement: string): { body: string } | { problem: string } {
  const text = statement.trim().replace(/\.$/, '').trim();
  if (text === '') return { problem: 'the statement is empty' };
  // The period on its own line, so a trailing comment can't swallow it.
  const written = statementsOf(`${text}\n.`);
  if (written.some((s) => s.get() instanceof Unknown)) return { problem: UNREADABLE };
  // Without INTO a SELECT reads as the head of a SELECT loop; a DELETE as a DELETE.
  const head = written[0]!.get();
  if (written.length > 1 || !(head instanceof Statements.SelectLoop || head instanceof Statements.Select)) {
    return { problem: 'only one SELECT runs here, nothing else' };
  }
  const body = written[0]!.concatTokens().replace(/\s*\.$/, '');
  const run = statementsOf(`${body}\n  INTO TABLE @DATA(rows).`);
  const select = run.length === 1 && run[0]!.get() instanceof Statements.Select ? run[0]! : undefined;
  if (!select) return { problem: UNREADABLE };
  if (select.findAllExpressionsRecursive(Expressions.SQLClient).length > 0) {
    return { problem: 'the statement reads another client (CLIENT SPECIFIED or USING … CLIENT[S]); adt+ reads the logon client only' };
  }
  if (select.findAllExpressionsRecursive(Expressions.DatabaseConnection).length > 0) {
    return { problem: 'the statement reads another database (CONNECTION); adt+ reads the system\'s own only' };
  }
  return { body };
}

export interface QueryInput {
  /** One ABAP SQL SELECT, without INTO. */
  statement: string;
  /** Rows to return, default 100, at most 1000. */
  maxRows?: number;
}

export interface QueryColumn {
  name: string;
  /** ABAP type letter as SAP reports it: C, N, X, P, 8 (INT8), … */
  type: string;
  description: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  /** One array per row, values in `columns` order. */
  rows: string[][];
  /** Rows the statement selects in all, as SAP counts them. */
  totalRows: number;
  /** Set when fewer rows came back than the statement selects: by `maxRows` or the size limit. */
  truncatedRows?: true;
  /** Cell values cut to MAX_CELL_CHARS. */
  truncatedCells?: number;
  /** The statement as SAP ran it (with its INTO and UP TO). */
  executedStatement: string;
  executionMs: number;
  via: 'rest-fallback';
  /** true once this system offers data preview natively — the fallback is retirable. */
  nativeAvailable: boolean | null;
}

function rowLimit(maxRows: number | undefined): number {
  if (maxRows === undefined) return DEFAULT_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw new Error(`maxRows must be a whole number from 1 to ${MAX_ROWS}`);
  }
  return maxRows;
}

/** A query every local check passed: what `query` sends. */
export interface PreparedQuery {
  readonly body: string;
  readonly rows: number;
}

/**
 * Every check that needs no SAP call (ADR-013): the system's switch, `maxRows`, the statement.
 * The daemon runs it before it opens a session, so a refused query never logs on.
 */
export function prepareQuery(destination: Destination, input: QueryInput): PreparedQuery {
  assertDataPreviewAllowed(destination);
  const rows = rowLimit(input.maxRows);
  const checked = checkStatement(input.statement);
  if ('problem' in checked) throw new Error(`adt+ system "${destination.id}": ${checked.problem}`);
  return { body: checked.body, rows };
}

function attr(tag: string, name: string): string {
  return decodeXml(tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '');
}

function element(xml: string, name: string): string | undefined {
  const value = xml.match(new RegExp(`<dataPreview:${name}>([\\s\\S]*?)</dataPreview:${name}>`))?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

/** `dataPreview:tableData`, column-major, as rows. Values keep SAP's text (a COUNT ends in a blank). */
export function parseTableData(xml: string): Omit<QueryResult, 'via' | 'nativeAvailable' | 'truncatedRows' | 'truncatedCells'> {
  if (!/<dataPreview:tableData\b/.test(xml)) throw new Error('not a dataPreview:tableData representation');
  const columns: QueryColumn[] = [];
  const values: string[][] = [];
  for (const [, block] of xml.matchAll(/<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g)) {
    const meta = block!.match(/<dataPreview:metadata\b[^>]*>/)?.[0] ?? '';
    columns.push({ name: attr(meta, 'dataPreview:name'), type: attr(meta, 'dataPreview:type'), description: attr(meta, 'dataPreview:description') });
    values.push(
      [...block!.matchAll(/<dataPreview:data(?:\/>|>([\s\S]*?)<\/dataPreview:data>)/g)].map(([, v]) => decodeXml(v ?? '')),
    );
  }
  const count = Math.max(0, ...values.map((v) => v.length));
  const rows = Array.from({ length: count }, (_, r) => values.map((v) => v[r] ?? ''));
  return {
    columns,
    rows,
    totalRows: Number(element(xml, 'totalRows') ?? rows.length),
    executedStatement: (element(xml, 'executedQueryString') ?? '').replace(/\s+/g, ' ').trim(),
    executionMs: Number(element(xml, 'queryExecutionTime') ?? 0),
  };
}

/**
 * Cut long cell values, then leave out the rows past the size limit. A row's cells share the limit,
 * so one wide row can't pass it either.
 */
export function capResult(table: ReturnType<typeof parseTableData>): Pick<QueryResult, 'rows' | 'truncatedRows' | 'truncatedCells'> {
  // One character less per column than the share: a cut value ends in `…`.
  const cellLimit = Math.max(1, Math.min(MAX_CELL_CHARS, Math.floor(MAX_RESULT_CHARS / Math.max(1, table.columns.length)) - 1));
  let cut = 0;
  let size = 0;
  let left = false;
  const rows: string[][] = [];
  for (const row of table.rows) {
    const capped = row.map((v) => {
      if (v.length <= cellLimit) return v;
      cut++;
      return `${v.slice(0, cellLimit)}…`;
    });
    size += capped.reduce((n, v) => n + v.length, 0);
    if (size > MAX_RESULT_CHARS) {
      left = true;
      break;
    }
    rows.push(capped);
  }
  // SAP's count, or anything this left out: a missing or odd count can't hide a cut.
  const more = left || !(rows.length >= table.totalRows);
  return {
    rows,
    ...(more ? { truncatedRows: true as const } : {}),
    ...(cut > 0 ? { truncatedCells: cut } : {}),
  };
}

/** Run a prepared SELECT through ADT's data preview (ADR-013). */
export async function query(rest: RawAdtClient, prepared: PreparedQuery, native: NativeSupport | undefined): Promise<QueryResult> {
  const res = await rest.expectOk('POST', PATH, 'data query', {
    changesNothing: true,
    query: { rowNumber: String(prepared.rows) },
    headers: { 'Content-Type': 'text/plain', Accept: MEDIA_TYPE },
    body: prepared.body,
  });
  const table = parseTableData(res.body);
  return {
    ...table,
    ...capResult(table),
    via: 'rest-fallback',
    nativeAvailable: native?.dataPreview ?? null,
  };
}
