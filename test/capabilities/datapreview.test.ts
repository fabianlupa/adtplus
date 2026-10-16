import { describe, expect, it } from 'vitest';
import { RawAdtError, type RawAdtClient, type RequestOptions } from '../../src/backends/rawadt.js';
import {
  capResult,
  checkStatement,
  MAX_CELL_CHARS,
  MAX_RESULT_CHARS,
  parseTableData,
  prepareQuery,
  query,
} from '../../src/capabilities/datapreview.js';

const problem = (statement: string) => {
  const checked = checkStatement(statement);
  return 'problem' in checked ? checked.problem : undefined;
};
import type { Destination } from '../../src/core/destinations.js';

/** Column-major as ONPREM answers. */
function tableXml(columns: Array<{ name: string; type?: string; values: string[] }>, totalRows: number): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `<dataPreview:totalRows>${totalRows}</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>` +
    '<dataPreview:executedQueryString>SELECT MANDT, MTEXT FROM T000   INTO     TABLE @DATA(LT_RESULT)   UP TO 2  ROWS   .</dataPreview:executedQueryString>' +
    '<dataPreview:queryExecutionTime>0.1340000</dataPreview:queryExecutionTime>' +
    columns
      .map(
        (c) =>
          `<dataPreview:columns><dataPreview:metadata dataPreview:name="${c.name}" dataPreview:type="${c.type ?? 'C'}" ` +
          `dataPreview:description="${c.name}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>` +
          (c.values.length === 0
            ? '<dataPreview:dataSet/>'
            : `<dataPreview:dataSet>${c.values.map((v) => (v === '' ? '<dataPreview:data/>' : `<dataPreview:data>${v}</dataPreview:data>`)).join('')}</dataPreview:dataSet>`) +
          '</dataPreview:columns>',
      )
      .join('') +
    '</dataPreview:tableData>'
  );
}

interface Call {
  method: string;
  path: string;
  opts: RequestOptions;
}

function fakeRest(answer: { status?: number; body: string }): RawAdtClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    expectOk: async (method: string, path: string, context: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      if ((answer.status ?? 200) >= 400) throw new RawAdtError(answer.status!, 'ExceptionDataPreviewGeneral', answer.body, context);
      return { status: 200, headers: new Headers(), body: answer.body };
    },
  } as unknown as RawAdtClient & { calls: Call[] };
}

const destination: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: [],
  allowDataPreview: true,
};

describe('checkStatement (abaplint, ADR-012/023)', () => {
  it.each([
    'SELECT * FROM zadtplus_recipe',
    "SELECT mandt, mtext FROM t000 WHERE mandt <> '000' ORDER BY mandt.",
    'SELECT COUNT(*) AS n FROM zadtplus_recipe',
    'SELECT a~currency, b~currency_text FROM zadtplus_currency AS a INNER JOIN zadtplus_currency AS b ON a~currency = b~currency',
    'SELECT currency FROM i_currency UNION SELECT currency FROM zadtplus_currency',
    "SELECT * FROM zview( p_x = 'A' )",
    'SELECT * FROM zadtplus_recipe " a trailing comment',
  ])('lets %j through', (statement) => {
    expect(problem(statement)).toBeUndefined();
  });

  it.each([
    'SELECT client FROM zadtplus_recipe USING ALL CLIENTS',
    "SELECT * FROM zadtplus_recipe USING CLIENT '000'",
    "SELECT * FROM zadtplus_recipe USING CLIENTS IN @( VALUE #( ( '000' ) ) )",
    "SELECT * FROM zadtplus_recipe CLIENT SPECIFIED WHERE client = '066'",
    "SELECT * FROM zadtplus_recipe WHERE uuid IN ( SELECT uuid FROM zadtplus_recipe USING CLIENT '000' )",
  ])('refuses %j: it reads another client', (statement) => {
    expect(problem(statement)).toMatch(/reads another client/);
  });

  it.each(['DELETE FROM zadtplus_curr', "UPDATE zadtplus_curr SET currency = 'X'", 'SELECT * FROM t000. SELECT * FROM t001'])(
    'refuses %j: not one SELECT',
    (statement) => {
      expect(problem(statement)).toBe('only one SELECT runs here, nothing else');
    },
  );

  it.each(['SELECT * FROM', 'SELECT * FROM t000 WHERE'])('refuses %j: abaplint cannot read it', (statement) => {
    expect(problem(statement)).toMatch(/could not read this as an ABAP SQL SELECT/);
  });

  it('refuses an empty statement', () => {
    expect(problem('  . ')).toMatch(/empty/);
  });

  it('refuses a statement reading another database', () => {
    expect(problem('SELECT * FROM usr02 CONNECTION r3_other')).toMatch(/reads another database \(CONNECTION\)/);
  });

  it("sends abaplint's tokens: no comments, so SAP's INTO can't land in one", () => {
    expect(checkStatement("SELECT *\n  FROM zadtplus_recipe \" first\n* whole line\n  WHERE rating > 3 \" note")).toEqual({
      body: 'SELECT * FROM zadtplus_recipe WHERE rating > 3',
    });
    expect(checkStatement("SELECT * FROM zadtplus_recipe \" USING CLIENT '000'")).toEqual({ body: 'SELECT * FROM zadtplus_recipe' });
    expect(checkStatement("SELECT mtext FROM t000 WHERE mtext = 'Demo  client'.")).toEqual({
      body: "SELECT mtext FROM t000 WHERE mtext = 'Demo  client'",
    });
  });
});

describe('parseTableData', () => {
  it('turns columns into rows, decoding values and keeping empty cells', () => {
    const table = parseTableData(
      tableXml(
        [
          { name: 'MANDT', values: ['000', '100'] },
          { name: 'MTEXT', values: ['SAP AG', 'Demo client US &amp; DE'] },
          { name: 'ORT01', values: ['Walldorf', ''] },
        ],
        33,
      ),
    );
    expect(table.columns.map((c) => c.name)).toEqual(['MANDT', 'MTEXT', 'ORT01']);
    expect(table.rows).toEqual([
      ['000', 'SAP AG', 'Walldorf'],
      ['100', 'Demo client US & DE', ''],
    ]);
    expect(table).toMatchObject({ totalRows: 33, executionMs: 0.134 });
    expect(table.executedStatement).toBe('SELECT MANDT, MTEXT FROM T000 INTO TABLE @DATA(LT_RESULT) UP TO 2 ROWS .');
  });

  it('reads an empty result as columns without rows', () => {
    const table = parseTableData(tableXml([{ name: 'CLIENT', values: [] }], 0));
    expect(table.columns).toHaveLength(1);
    expect(table.rows).toEqual([]);
  });

  it('refuses another document', () => {
    expect(() => parseTableData('<exc:exception/>')).toThrow(/not a dataPreview:tableData/);
  });
});

describe('capResult', () => {
  const table = (rows: string[][], totalRows = rows.length) => ({
    columns: (rows[0] ?? ['']).map((_, i) => ({ name: `C${i}`, type: 'C', description: '' })),
    rows,
    totalRows,
    executedStatement: '',
    executionMs: 0,
  });

  it('cuts long cell values and counts them', () => {
    const res = capResult(table([['x'.repeat(MAX_CELL_CHARS + 10), 'short']]));
    expect(res.rows[0]![0]).toHaveLength(MAX_CELL_CHARS + 1);
    expect(res.truncatedCells).toBe(1);
    expect(res.truncatedRows).toBeUndefined();
  });

  it('leaves out the rows past the size limit and says so', () => {
    const row = ['y'.repeat(MAX_CELL_CHARS)];
    const count = Math.ceil(MAX_RESULT_CHARS / MAX_CELL_CHARS) + 5;
    const res = capResult(table(Array.from({ length: count }, () => row)));
    expect(res.rows.length).toBeLessThan(count);
    expect(res.truncatedRows).toBe(true);
  });

  it('says rows were left out when SAP counts more than came back', () => {
    expect(capResult(table([['1']], 33)).truncatedRows).toBe(true);
  });

  it('says rows were left out by the size limit even without a usable count', () => {
    const row = ['y'.repeat(MAX_CELL_CHARS)];
    const res = capResult(table(Array.from({ length: 200 }, () => row), Number.NaN));
    expect(res.truncatedRows).toBe(true);
    expect(capResult(table([['1']], Number.NaN)).truncatedRows).toBe(true);
  });

  it('keeps one wide row under the size limit: its cells share it', () => {
    const wide = Array.from({ length: 300 }, () => 'z'.repeat(MAX_CELL_CHARS));
    const res = capResult(table([wide]));
    expect(res.rows[0]!.reduce((n, v) => n + v.length, 0)).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(res.truncatedCells).toBe(300);
  });
});

describe('query', () => {
  const answer = { body: tableXml([{ name: 'MANDT', values: ['000'] }], 33) };

  it('posts the statement as text with the row limit and returns rows as a REST fallback', async () => {
    const rest = fakeRest(answer);
    const res = await query(rest, prepareQuery(destination, { statement: 'SELECT mandt FROM t000.', maxRows: 1 }), undefined);
    expect(rest.calls).toEqual([
      {
        method: 'POST',
        path: '/sap/bc/adt/datapreview/freestyle',
        opts: {
          changesNothing: true,
          query: { rowNumber: '1' },
          headers: { 'Content-Type': 'text/plain', Accept: 'application/vnd.sap.adt.datapreview.table.v1+xml' },
          body: 'SELECT mandt FROM t000',
        },
      },
    ]);
    expect(res).toMatchObject({ rows: [['000']], totalRows: 33, truncatedRows: true, via: 'rest-fallback', nativeAvailable: null });
  });

  it('asks for 100 rows by default', async () => {
    const rest = fakeRest(answer);
    await query(rest, prepareQuery(destination, { statement: 'SELECT mandt FROM t000' }), undefined);
    expect(rest.calls[0]!.opts.query).toEqual({ rowNumber: '100' });
  });

  it.each([0, 1001, 2.5, Number.NaN])('prepareQuery refuses maxRows %j', (maxRows) => {
    expect(() => prepareQuery(destination, { statement: 'SELECT mandt FROM t000', maxRows })).toThrow(/maxRows/);
  });

  it.each([undefined, false])('prepareQuery refuses on a system with allowDataPreview %j, naming the setting', (allowDataPreview) => {
    expect(() => prepareQuery({ ...destination, allowDataPreview }, { statement: 'SELECT mandt FROM t000' })).toThrow(
      /adt\+ system "onprem": data preview is off here\. It needs "allowDataPreview": true/,
    );
  });

  it('prepareQuery refuses a statement reading another client', () => {
    expect(() => prepareQuery(destination, { statement: "SELECT * FROM zadtplus_recipe USING CLIENT '000'" })).toThrow(
      /adt\+ system "onprem": the statement reads another client/,
    );
  });

  it("passes SAP's refusal on", async () => {
    const rest = fakeRest({ status: 400, body: 'No authorization to view data' });
    await expect(query(rest, prepareQuery(destination, { statement: 'SELECT mandt FROM t000' }), undefined)).rejects.toThrow(
      /data query failed \(HTTP 400 ExceptionDataPreviewGeneral\): No authorization to view data/,
    );
  });
});
