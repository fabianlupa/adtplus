import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveRead } from '../../src/core/active-source.js';
import * as navigate from '../../src/capabilities/navigate.js';

const CLAS = { name: 'ZCL_ADTPLUS_M6', objectType: 'CLAS/OC' };
const DDLS = { name: 'ZI_ADTPLUS_M6', objectType: 'DDLS/DF' };
const loc = { symbol: 'ZCL_ADTPLUS_M6' };

function navAdt(results: Partial<Record<string, unknown>>) {
  const fn = (key: string) => vi.fn(async () => results[key]);
  return {
    navigation: {
      findReferences: fn('references'),
      documentSymbols: fn('symbols'),
      typeHierarchy: fn('hierarchy'),
      checkSyntax: fn('syntax'),
    },
  } as unknown as AdtLsClient;
}

describe('navigate.references', () => {
  it('qualifies an empty result: it does NOT show that nothing uses the symbol', async () => {
    // m6-02-nav-clas-references-method.json recorded `[]` where ARC-1 saw a caller.
    const res = await navigate.references(navAdt({ references: [] }), CLAS, loc);
    expect(res.result).toEqual([]);
    expect(res.notes).toHaveLength(2);
    expect(res.notes[0]).toMatch(/does NOT show that nothing uses the symbol/);
  });

  it('warns on a non-empty ABAP result that same-object callers can be missing', async () => {
    const res = await navigate.references(navAdt({ references: [{ uri: 'abap:/x', range: {} }] }), CLAS, loc);
    expect(res.notes).toEqual([expect.stringMatching(/own main source can be missing/)]);
  });

  it('adds the locate-by-view-name note on CDS, alongside the empty note', async () => {
    const res = await navigate.references(navAdt({ references: [] }), DDLS, loc);
    expect(res.notes).toHaveLength(2);
    expect(res.notes[1]).toMatch(/locate by the view name/i);

    const nonEmpty = await navigate.references(navAdt({ references: [{ uri: 'abap:/x' }] }), DDLS, loc);
    expect(nonEmpty.notes).toHaveLength(1);
    expect(nonEmpty.notes[0]).toMatch(/locate by the view name/i);
  });

  it('forwards timeoutMs to the SDK', async () => {
    const adt = navAdt({ references: [] });
    await navigate.references(adt, CLAS, loc, { timeoutMs: 1234 });
    expect(adt.navigation.findReferences).toHaveBeenCalledWith(CLAS, loc, { timeoutMs: 1234 });
  });
});

describe('navigate.symbols / hierarchy on CDS', () => {
  it('symbols: empty on CDS carries the CDS_THIN note; non-empty or ABAP does not', async () => {
    // m6-02-nav-ddls-symbols.json recorded `[]`.
    const thin = await navigate.symbols(navAdt({ symbols: [] }), DDLS);
    expect(thin.notes).toEqual([expect.stringMatching(/outline, highlight and type hierarchy return nothing on CDS/)]);

    expect((await navigate.symbols(navAdt({ symbols: [] }), CLAS)).notes).toEqual([]);
    expect((await navigate.symbols(navAdt({ symbols: [{ name: 'X' }] }), DDLS)).notes).toEqual([]);
  });

  it('hierarchy: the recorded CDS payload {item:null, supertypes:[], subtypes:[]} gets the CDS_THIN note', async () => {
    const empty = { item: null, supertypes: [], subtypes: [] };
    const thin = await navigate.hierarchy(navAdt({ hierarchy: empty }), DDLS, loc);
    expect(thin.notes).toEqual([expect.stringMatching(/return nothing on CDS/)]);
    expect((await navigate.hierarchy(navAdt({ hierarchy: undefined }), DDLS, loc)).notes).toHaveLength(1);
  });

  it('hierarchy: a populated ABAP result, or an empty ABAP one, carries no note', async () => {
    const populated = { item: { name: 'ZCL_ADTPLUS_M6' }, supertypes: [{ name: 'ZIF_ADTPLUS_M6' }], subtypes: [] };
    expect((await navigate.hierarchy(navAdt({ hierarchy: populated }), CLAS, loc)).notes).toEqual([]);
    expect((await navigate.hierarchy(navAdt({ hierarchy: { item: null } }), CLAS, loc)).notes).toEqual([]);
  });
});

describe('navigate.checkSyntax', () => {
  it('always carries the stored-source note, whatever the result', async () => {
    for (const result of [[], [{ severity: 'error', text: 'boom' }]]) {
      const res = await navigate.checkSyntax(navAdt({ syntax: result }), CLAS);
      expect(res.result).toEqual(result);
      expect(res.notes).toEqual([expect.stringMatching(/stored source as last saved.*pass it as `source`/)]);
    }
  });

  it('does not send an SRVB and says it is not checked, since an empty result would read as clean', async () => {
    const adt = navAdt({ syntax: undefined });
    const res = await navigate.checkSyntax(adt, { name: 'ZUI_X_O4', objectType: 'SRVB/SVB' });
    expect(adt.navigation.checkSyntax).not.toHaveBeenCalled();
    expect(res).toEqual({ result: null, notes: [expect.stringMatching(/^Not checked: SRVB ZUI_X_O4\./)] });
  });

  it('names inactive dependencies as the cause and points to one activation of the chain', async () => {
    const items = [
      { message: 'The data source "ZR_X" does not exist or is not active' },
      { message: 'The class ZBP_X has inactive parts.' },
      { message: 'Unrelated' },
    ];
    const res = await navigate.checkSyntax(navAdt({ syntax: { items } }), DDLS);
    expect(res.notes[1]).toMatch(/^2 findings name an object that is inactive.*one `activate` call/);
  });
});

// --- sourceScan -------------------------------------------------------
//
// M6.4c's where-used runs: the index returned only the test-class file for
// `GET_CUSTOMER_COUNTS` while the class's own `main` called it too, and across
// four runs Copilot never reported both sets from the note alone. adt+ now
// reads the source and scans it itself.

const MAIN_SOURCE = [
  'CLASS zcl_adtplus_ai_demo2 DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    INTERFACES if_oo_adt_classrun.',
  '  PRIVATE SECTION.',
  '    METHODS get_customer_counts RETURNING VALUE(rv) TYPE i.',
  '    METHODS get_customer_counts_2 RETURNING VALUE(rv) TYPE i.',
  'ENDCLASS.',
  'CLASS zcl_adtplus_ai_demo2 IMPLEMENTATION.',
  '  METHOD if_oo_adt_classrun~main.',
  '    DATA(lv) = get_customer_counts( ).       " calls it',
  '  ENDMETHOD.',
  '  METHOD get_customer_counts.',
  '    rv = 1.',
  '  ENDMETHOD.',
  '* old: get_customer_counts( ) was called here',
  '  METHOD get_customer_counts_2.',
  '    rv = 2.',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

const TEST_SOURCE = [
  'CLASS ltc_demo DEFINITION FOR TESTING.',
  '  PRIVATE SECTION.',
  '    METHODS first FOR TESTING.',
  'ENDCLASS.',
  'CLASS ltc_demo IMPLEMENTATION.',
  '  METHOD first.',
  '    cl_abap_unit_assert=>assert_equals( act = cut->get_customer_counts( ) exp = 1 ).',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

function scanAdt(sources: Record<string, string>, references: unknown = [{ uri: 'abap:/testclasses' }]) {
  return {
    navigation: { findReferences: vi.fn(async () => references) },
    source: {
      read: vi.fn(async ({ include }: { include?: string }) => {
        const key = include ?? 'main';
        if (!(key in sources)) throw new Error(`Resource ${key} does not exist`);
        return sources[key];
      }),
    },
  } as unknown as AdtLsClient;
}

const DEMO = { name: 'ZCL_ADTPLUS_AI_DEMO2', objectType: 'CLAS/OC' };
const METHOD = { symbol: 'GET_CUSTOMER_COUNTS' };

describe('navigate.references sourceScan', () => {
  it('finds the same-object caller the index left out, and leaves `result` untouched', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE, testclasses: TEST_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD);

    expect(res.result).toEqual([{ uri: 'abap:/testclasses' }]);
    const calls = res.sourceScan?.matches.filter((m) => m.kind === 'call');
    expect(calls).toEqual([
      {
        include: 'main',
        line: 10,
        text: 'DATA(lv) = get_customer_counts( ).       " calls it',
        kind: 'call',
        version: 'inactive',
      },
      {
        include: 'testclasses',
        line: 7,
        text: 'cl_abap_unit_assert=>assert_equals( act = cut->get_customer_counts( ) exp = 1 ).',
        kind: 'call',
        version: 'inactive',
      },
    ]);
  });

  it('marks METHODS/METHOD headers as declarations, not callers', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD);
    expect(res.sourceScan?.matches.filter((m) => m.kind === 'declaration').map((m) => m.line)).toEqual([5, 12]);
  });

  it('ignores a commented-out call, on a full line and after an inline quote', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD);
    // Line 15 is `* old: get_customer_counts( ) ...`.
    expect(res.sourceScan?.matches.some((m) => m.line === 15)).toBe(false);
    // The inline `" calls it` on line 10 does not stop the real call being found.
    expect(res.sourceScan?.matches.some((m) => m.line === 10 && m.kind === 'call')).toBe(true);
  });

  it('reads ABAP as abaplint does: a quote in a literal, a chained METHODS, text and code in a template', async () => {
    const source = [
      'CLASS lcl DEFINITION.',
      '  PUBLIC SECTION.',
      '    METHODS: other, get_customer_counts.',
      'ENDCLASS.',
      'CLASS lcl IMPLEMENTATION.',
      '  METHOD other.',
      `    lo->log( 'say "hi"' ). me->get_customer_counts( ).`,
      `    lo->log( 'get_customer_counts' ).`,
      '    lv = |get_customer_counts: { get_customer_counts( ) }|.',
      '  ENDMETHOD.',
      'ENDCLASS.',
    ].join('\n');
    const res = await navigate.references(scanAdt({ main: source }), DEMO, METHOD);
    expect(res.sourceScan?.matches.map((m) => [m.line, m.kind])).toEqual([
      [3, 'declaration'],
      [7, 'call'],
      [9, 'call'],
    ]);
  });

  it('scans a qualified symbol the index took as it is for its name', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, { symbol: 'ZCL_ADTPLUS_AI_DEMO2=>GET_CUSTOMER_COUNTS' });
    expect(res.sourceScan?.matches.filter((m) => m.kind === 'call').map((m) => m.line)).toEqual([10]);
  });

  it("leaves another class's static call out of a qualified symbol's scan, and its own name in", async () => {
    const source = [
      'CLASS zcl_adtplus_ai_demo2 IMPLEMENTATION.',
      '  METHOD main.',
      '    lv = zcl_other=>get_customer_counts( ).',
      '    lv = zcl_adtplus_ai_demo2=>get_customer_counts( ).',
      '    lv = get_customer_counts( ).',
      '  ENDMETHOD.',
      'ENDCLASS.',
    ].join('\n');
    const res = await navigate.references(scanAdt({ main: source }), DEMO, { symbol: 'ZCL_ADTPLUS_AI_DEMO2=>GET_CUSTOMER_COUNTS' });
    expect(res.sourceScan?.symbol).toBe('ZCL_ADTPLUS_AI_DEMO2=>GET_CUSTOMER_COUNTS');
    expect(res.sourceScan?.matches.map((m) => m.line)).toEqual([4, 5]);
  });

  it('only the declared name is a declaration: a type on a METHODS continuation line is a use', async () => {
    const source = [
      'CLASS lcl DEFINITION.',
      '  PUBLIC SECTION.',
      '    METHODS m',
      '      IMPORTING io TYPE REF TO zcl_x.',
      'ENDCLASS.',
    ].join('\n');
    const res = await navigate.references(scanAdt({ main: source }), DEMO, { symbol: 'zcl_x' });
    expect(res.sourceScan?.matches.map((m) => [m.line, m.kind])).toEqual([[4, 'call']]);
  });

  it('matches whole words only, so a longer method name is not a hit', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD);
    // `get_customer_counts_2` is declared on line 6 and implemented on line 16.
    expect(res.sourceScan?.matches.some((m) => m.line === 6 || m.line === 16)).toBe(false);
  });

  it('reads a class\'s includes and skips the ones it does not have', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE, testclasses: TEST_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD);
    expect(res.sourceScan?.scanned).toEqual(['main', 'testclasses']);
    expect(vi.mocked(adt.source.read).mock.calls.map((c) => (c[0] as { include?: string }).include)).toEqual([
      undefined,
      'definitions',
      'implementations',
      'macros',
      'testclasses',
    ]);
  });

  it('reads only the main source for a non-class object', async () => {
    const adt = scanAdt({ main: 'DEFINE VIEW x AS SELECT FROM y { key a }' });
    await navigate.references(adt, { name: 'ZADTPLUS_X', objectType: 'INTF/OI' }, { symbol: 'a' });
    expect(vi.mocked(adt.source.read).mock.calls).toHaveLength(1);
  });

  it('labels a draft-only scan inactive and says the index half is active', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD);
    expect(res.sourceScan?.versions).toEqual(['inactive']);
    expect(res.notes).toEqual([
      expect.stringMatching(/adt\+ read that source and scanned it/),
      expect.stringMatching(/ACTIVE version.*INACTIVE draft/s),
    ]);
  });

  it('keeps the old "search the source yourself" note when it cannot scan', async () => {
    // No symbol to look for: a line/character locator names no name.
    const byPosition = scanAdt({ main: MAIN_SOURCE });
    const positional = await navigate.references(byPosition, DEMO, { line: 10, character: 16 });
    expect(positional.sourceScan).toBeUndefined();
    expect(positional.notes).toEqual([expect.stringMatching(/own main source can be missing/)]);
    expect(byPosition.source.read).not.toHaveBeenCalled();

    // Every include unreadable — nothing was scanned, so do not claim it was.
    const unreadable = scanAdt({});
    const res = await navigate.references(unreadable, DEMO, METHOD);
    expect(res.sourceScan).toBeUndefined();
    expect(res.notes).toEqual([expect.stringMatching(/own main source can be missing/)]);
  });

  it('skips the scan on CDS and when the caller opts out', async () => {
    const cds = scanAdt({ main: 'DEFINE VIEW ...' });
    const onCds = await navigate.references(cds, DDLS, { symbol: 'ZI_ADTPLUS_M6' });
    expect(onCds.sourceScan).toBeUndefined();
    expect(cds.source.read).not.toHaveBeenCalled();

    const optedOut = scanAdt({ main: MAIN_SOURCE });
    const res = await navigate.references(optedOut, DEMO, METHOD, { scanSource: false });
    expect(res.sourceScan).toBeUndefined();
    expect(optedOut.source.read).not.toHaveBeenCalled();
  });
});

// The active half, read by switching adt-ls to the active version (the daemon
// supplies the reader, core/active-source.ts). Modelled on the divergence ARC-1 confirmed on ZCL_ADTPLUS_AI_DEMO2: the draft's
// testclasses include is an empty stub while the ACTIVE one calls the method
// three times, so before this those three callers were in neither half.
const TEST_STUB = '*"* use this source file for your ABAP unit test classes';

describe('navigate.references sourceScan, both versions', () => {
  function bothAdt(inactive: Record<string, string>, active: Record<string, string>) {
    const adt = scanAdt(inactive, []);
    const readActiveSource = vi.fn(async (includes: Array<string | undefined>): Promise<ActiveRead> => {
      const texts = new Map<string, string>();
      for (const include of includes) {
        const key = include ?? 'main';
        if (key in active) texts.set(key, active[key] as string);
      }
      return { texts };
    });
    return { adt, readActiveSource };
  }

  it('finds callers that exist only in the active version', async () => {
    const { adt, readActiveSource } = bothAdt(
      { main: MAIN_SOURCE, testclasses: TEST_STUB },
      { main: MAIN_SOURCE, testclasses: TEST_SOURCE },
    );
    const res = await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    const testCall = res.sourceScan?.matches.find((m) => m.include === 'testclasses' && m.kind === 'call');
    expect(testCall).toMatchObject({ line: 7, version: 'active' });
    expect(res.sourceScan?.diverged).toEqual(['testclasses']);
    expect(res.sourceScan?.versions).toEqual(['active', 'inactive']);
  });

  it('does not list a line twice when only part of a diverged include changed', async () => {
    // `main` is identical here, `testclasses` is not — the main call must still
    // read as ONE caller, or it counts as two.
    const { adt, readActiveSource } = bothAdt(
      { main: MAIN_SOURCE, testclasses: TEST_STUB },
      { main: `${MAIN_SOURCE}\n" a trailing change`, testclasses: TEST_SOURCE },
    );
    const res = await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    const mainCalls = res.sourceScan?.matches.filter((m) => m.include === 'main' && m.kind === 'call');
    expect(mainCalls).toHaveLength(1);
    expect(mainCalls?.[0]).toMatchObject({ line: 10, version: 'both' });
    expect(res.sourceScan?.diverged).toEqual(['main', 'testclasses']);
  });

  it('tags a match as `both` where the two versions agree, without duplicating it', async () => {
    const { adt, readActiveSource } = bothAdt({ main: MAIN_SOURCE }, { main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    const calls = res.sourceScan?.matches.filter((m) => m.kind === 'call');
    expect(calls).toHaveLength(1);
    expect(calls?.[0]).toMatchObject({ include: 'main', line: 10, version: 'both' });
    expect(res.sourceScan?.diverged).toEqual([]);
  });

  it('swaps in the both-versions note once the active half was read', async () => {
    const { adt, readActiveSource } = bothAdt({ main: MAIN_SOURCE }, { main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    expect(res.sourceScan).not.toHaveProperty('via');
    expect(res.notes.join('\n')).toMatch(/read BOTH versions/);
    expect(res.notes.join('\n')).toMatch(/diverged/);
  });

  it('falls back to the draft half when the active read fails', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE }, []);
    const readActiveSource = vi.fn(async () => {
      throw new Error('adt-ls did not switch ZCL_ADTPLUS_AI_DEMO2 to the active version');
    });
    const res = await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    expect(res.sourceScan?.versions).toEqual(['inactive']);
    expect(res.sourceScan?.matches.some((m) => m.kind === 'call')).toBe(true);
    expect(res.notes.join('\n')).toMatch(/ACTIVE version.*INACTIVE draft/s);
    expect(res.notes.join('\n')).not.toMatch(/read BOTH versions/);
  });

  it('without an own draft, takes the draft read as the active one and tags every match `both`', async () => {
    const adt = scanAdt({ main: MAIN_SOURCE, testclasses: TEST_SOURCE }, []);
    const readActiveSource = vi.fn(async (): Promise<ActiveRead> => ({ sameAsServed: true }));
    const res = await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    expect(res.sourceScan?.versions).toEqual(['active', 'inactive']);
    expect(res.sourceScan?.diverged).toEqual([]);
    expect(res.sourceScan?.matches.length).toBeGreaterThan(0);
    expect(res.sourceScan?.matches.every((m) => m.version === 'both')).toBe(true);
  });

  it('reads the draft includes before the active window opens, and all includes in one window', async () => {
    const order: string[] = [];
    const adt = scanAdt({ main: MAIN_SOURCE, testclasses: TEST_STUB }, []);
    const read = adt.source.read as unknown as ReturnType<typeof vi.fn<(args: { include?: string }) => Promise<string>>>;
    const draftRead = read.getMockImplementation()!;
    read.mockImplementation(async (args) => {
      order.push(`draft:${args.include ?? 'main'}`);
      return draftRead(args);
    });
    const readActiveSource = vi.fn(async (includes: Array<string | undefined>): Promise<ActiveRead> => {
      order.push('active-window');
      return { texts: new Map(includes.map((i) => [i ?? 'main', MAIN_SOURCE])) };
    });
    await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    expect(readActiveSource).toHaveBeenCalledTimes(1);
    expect(readActiveSource.mock.calls[0]![0]).toEqual([undefined, 'definitions', 'implementations', 'macros', 'testclasses']);
    expect(order.at(-1)).toBe('active-window');
    expect(order.filter((o) => o.startsWith('draft:'))).toHaveLength(5);
  });

  it('still answers from the active half when the object has no draft to read', async () => {
    const { adt, readActiveSource } = bothAdt({}, { main: MAIN_SOURCE });
    const res = await navigate.references(adt, DEMO, METHOD, { readActiveSource });

    expect(res.sourceScan?.versions).toEqual(['active']);
    expect(res.sourceScan?.matches.every((m) => m.version === 'active')).toBe(true);
  });
});

// A Copilot run passed ABAP's qualified form and read the SDK's "not found"
// as the tool refusing method-level lookup, then answered from the draft
// source and got it wrong. The SDK lists the declared symbols in that error;
// adt+ now retries instead of leaving it to the caller.
describe('qualified symbol names', () => {
  function qualifiedAdt() {
    // Case-insensitive like the SDK: verified live, `get_customer_counts`
    // resolves the same object as `GET_CUSTOMER_COUNTS`.
    const findReferences = vi.fn(async (_ref: unknown, locator: { symbol?: string }) => {
      if (locator.symbol?.toUpperCase() !== 'GET_CUSTOMER_COUNTS') {
        throw new Error(
          `Symbol "${locator.symbol}" not found in the outline or source. Declared symbols: GET_CUSTOMER_COUNTS.`,
        );
      }
      return [{ uri: 'abap:/x' }];
    });
    return {
      navigation: { findReferences },
      source: { read: vi.fn(async () => MAIN_SOURCE) },
    } as unknown as AdtLsClient;
  }

  it('retries ZCL_X=>METH with the bare method name', async () => {
    const adt = qualifiedAdt();
    const res = await navigate.references(adt, DEMO, { symbol: 'ZCL_ADTPLUS_AI_DEMO2=>GET_CUSTOMER_COUNTS' });
    expect(res.result).toEqual([{ uri: 'abap:/x' }]);
    expect(vi.mocked(adt.navigation.findReferences).mock.calls.at(-1)?.[1]).toEqual({
      symbol: 'GET_CUSTOMER_COUNTS',
    });
  });

  it('retries the lo_x->meth form too', async () => {
    const adt = qualifiedAdt();
    await navigate.references(adt, DEMO, { symbol: 'lo_demo->get_customer_counts' });
    expect(vi.mocked(adt.navigation.findReferences).mock.calls.at(-1)?.[1]).toMatchObject({
      symbol: 'get_customer_counts',
    });
  });

  it('scans the source for the symbol that actually worked, not the qualified one', async () => {
    const adt = qualifiedAdt();
    const res = await navigate.references(adt, DEMO, { symbol: 'ZCL_ADTPLUS_AI_DEMO2=>GET_CUSTOMER_COUNTS' });
    expect(res.sourceScan?.symbol).toBe('GET_CUSTOMER_COUNTS');
    expect(res.sourceScan?.matches.some((m) => m.kind === 'call')).toBe(true);
  });

  it('keeps an interface method\'s ~ intact — that is how it is declared', async () => {
    const adt = {
      navigation: { findReferences: vi.fn(async () => []) },
      source: { read: vi.fn(async () => MAIN_SOURCE) },
    } as unknown as AdtLsClient;
    await navigate.references(adt, DEMO, { symbol: 'IF_OO_ADT_CLASSRUN~MAIN' });
    expect(vi.mocked(adt.navigation.findReferences).mock.calls[0]?.[1]).toEqual({
      symbol: 'IF_OO_ADT_CLASSRUN~MAIN',
    });
  });

  it('rethrows a genuinely unknown symbol rather than retrying forever', async () => {
    const adt = qualifiedAdt();
    await expect(navigate.references(adt, DEMO, { symbol: 'NO_SUCH_METHOD' })).rejects.toThrow(
      /not found in the outline/,
    );
    expect(adt.navigation.findReferences).toHaveBeenCalledTimes(1);
  });
});
