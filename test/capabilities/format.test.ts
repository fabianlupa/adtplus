import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawAdtClient, RequestOptions } from '../../src/backends/rawadt.js';

const cleanSource = vi.fn();
vi.mock('../../src/core/abap-cleaner.js', () => ({ cleanSource: (...args: unknown[]) => cleanSource(...args) }));

const { checkFormatInput, formatSource, normalize } = await import('../../src/capabilities/format.js');
type FormatDeps = import('../../src/capabilities/format.js').FormatDeps;

const CLAS = { name: 'ZCL_X', objectType: 'CLAS/OC' };
const DDLS = { name: 'ZADTPLUS_I_TRIP', objectType: 'DDLS/DF' };
const STORED = 'class zcl_x definition public.\npublic section.\nendclass.\nclass zcl_x implementation.\nendclass.\n';
const PRETTY = 'CLASS zcl_x DEFINITION PUBLIC.\r\n  PUBLIC SECTION.\r\nENDCLASS.\r\nCLASS zcl_x IMPLEMENTATION.\r\nENDCLASS.';
const EXPECTED = 'CLASS zcl_x DEFINITION PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\nENDCLASS.\n';

function fakeAdt(formatted = PRETTY) {
  return {
    lifecycle: { resolveAffUri: vi.fn(async () => 'abap:/repotree-v1/x/zcl_x.clas.abap') },
    repository: { readFile: vi.fn(async () => STORED) },
    navigation: { format: vi.fn(async () => ({ formatted, edits: [] })) },
  };
}

function deps(adt = fakeAdt(), body = PRETTY) {
  const sent: Array<{ method: string; path: string; opts: RequestOptions }> = [];
  const rest = {
    expectOk: vi.fn(async (method: string, path: string, _ctx: string, opts: RequestOptions) => {
      sent.push({ method, path, opts });
      return { status: 200, headers: new Headers(), body };
    }),
  } as unknown as RawAdtClient;
  const d: FormatDeps = {
    adt: vi.fn(async () => adt as unknown as AdtLsClient),
    withRest: vi.fn(async <T>(fn: (r: RawAdtClient) => Promise<T>) => fn(rest)) as FormatDeps['withRest'],
  };
  return { d, adt, sent };
}

const sap = {};
const cleaner = { format: { engine: 'abap-cleaner' as const, abapCleaner: { release: '758' } } };

beforeEach(() => cleanSource.mockReset());

describe('normalize', () => {
  it('turns \\r\\n into \\n and keeps the final newline as the input has it', () => {
    expect(normalize('a\r\nb', 'x\n')).toBe('a\nb\n');
    expect(normalize('a\nb\n', 'x')).toBe('a\nb');
    expect(normalize('a\nb\n', 'x\n')).toBe('a\nb\n');
  });
});

describe('formatSource, engine sap', () => {
  it("formats the stored source through adt-ls, comparing with the stored text", async () => {
    const { d, adt } = deps();
    const res = await formatSource(d, sap, { ref: CLAS });
    expect(res).toMatchObject({ formatted: EXPECTED, changed: true, engine: 'sap', input: 'stored' });
    expect(res.via).toBeUndefined();
    expect(adt.navigation.format).toHaveBeenCalledWith(CLAS);
    expect(res.notes).toEqual([
      "Formatted with the logon user's pretty printer settings on the system, as ADT's Format does.",
      "A class's main source only; its local test classes and other includes aren't formatted.",
    ]);
  });

  it('reports an already formatted source as unchanged', async () => {
    const adt = fakeAdt(EXPECTED.replace(/\n/g, '\r\n'));
    adt.repository.readFile.mockResolvedValue(EXPECTED);
    const { d } = deps(adt);
    expect(await formatSource(d, sap, { ref: CLAS })).toMatchObject({ changed: false, formatted: EXPECTED });
  });

  it('sends given ABAP text to the REST pretty printer, opening no adt-ls call', async () => {
    const { d, sent } = deps();
    const res = await formatSource(d, sap, { ref: CLAS, source: STORED });
    expect(res).toMatchObject({ formatted: EXPECTED, input: 'source', via: 'rest-fallback', nativeAvailable: null });
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/sap/bc/adt/abapsource/prettyprinter',
        opts: expect.objectContaining({ changesNothing: true, body: STORED, headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' } }),
      },
    ]);
    expect(d.adt).not.toHaveBeenCalled();
  });

  it('refuses given DDL-syntax text (CDS, tables) and a service binding before any call', async () => {
    expect(() => checkFormatInput(sap, { ref: DDLS, source: 'define view entity x as select from y { a }' })).toThrow(
      /format.engine "sap" can't format DDLS text that isn't saved/,
    );
    expect(() => checkFormatInput(sap, { ref: { name: 'ZADTPLUS_TRIP', objectType: 'TABL/DT' }, source: 'define table zadtplus_trip { key id : abap.int4; }' })).toThrow(
      /can't format TABL text/,
    );
    expect(() => checkFormatInput(sap, { ref: { name: 'Z_SB', objectType: 'SRVB/SVB' } })).toThrow(/SRVB Z_SB has no source to format/);
    expect(() => checkFormatInput(cleaner, { ref: DDLS, source: 'x' })).not.toThrow();
  });

  it('refuses a result that changed code, returning nothing', async () => {
    const { d } = deps(fakeAdt(PRETTY.replace('PUBLIC SECTION', 'PRIVATE SECTION')));
    await expect(formatSource(d, sap, { ref: CLAS })).rejects.toThrow(
      /^sap changed the code, not just its layout: line 2 "public section\." became line 2 "PRIVATE SECTION\."/,
    );
  });

  it("blames a save in between, not the formatter, when the stored source moved", async () => {
    const adt = fakeAdt(PRETTY.replace('PUBLIC SECTION', 'PRIVATE SECTION'));
    adt.repository.readFile.mockResolvedValueOnce(STORED).mockResolvedValueOnce(STORED.replace('public section', 'private section'));
    await expect(formatSource(deps(adt).d, sap, { ref: CLAS })).rejects.toThrow("ZCL_X's stored source changed while it was formatted; format it again");
  });

  it('names the lines abaplint cannot parse', async () => {
    const broken = STORED.replace('endclass.\nclass', 'endclass.\nif x = .\nclass');
    const adt = fakeAdt(broken.toUpperCase());
    adt.repository.readFile.mockResolvedValue(broken);
    const res = await formatSource(deps(adt).d, sap, { ref: CLAS });
    expect(res.unparsedLines).toEqual([4]);
    expect(res.notes).toContain("abaplint can't parse line 4: if that is a syntax error, the layout after it is wrong; check syntax first.");
  });
});

describe('formatSource, engine abap-cleaner', () => {
  it('formats given text locally: no session, no REST', async () => {
    cleanSource.mockResolvedValue(EXPECTED);
    const { d } = deps();
    const res = await formatSource(d, cleaner, { ref: CLAS, source: STORED });
    expect(res).toMatchObject({ formatted: EXPECTED, changed: true, engine: 'abap-cleaner', input: 'source', notes: [] });
    expect(cleanSource).toHaveBeenCalledWith(STORED, { release: '758' });
    expect(d.adt).not.toHaveBeenCalled();
    expect(d.withRest).not.toHaveBeenCalled();
  });

  it('reads the stored source through adt-ls first', async () => {
    cleanSource.mockResolvedValue(EXPECTED);
    const { d, adt } = deps();
    expect(await formatSource(d, cleaner, { ref: CLAS })).toMatchObject({ input: 'stored', formatted: EXPECTED });
    expect(cleanSource).toHaveBeenCalledWith(STORED, { release: '758' });
    expect(adt.navigation.format).not.toHaveBeenCalled();
  });

  it('refuses a behavior definition whose text changed beyond whitespace and case', async () => {
    const bdef = 'managed implementation in class zbp_x unique;\ndefine behavior for ZR_X\n{ create; }\n';
    cleanSource.mockResolvedValue(bdef.replace('create;', ''));
    await expect(formatSource(deps().d, cleaner, { ref: { name: 'ZR_X', objectType: 'BDEF/BDO' }, source: bdef })).rejects.toThrow(
      /^abap-cleaner changed the code, not just its layout: line 3/,
    );
  });
});
