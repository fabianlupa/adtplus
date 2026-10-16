import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it } from 'vitest';
import type { RawAdtClient, RequestOptions } from '../../src/backends/rawadt.js';
import { checkObjectList, checkStoredSyntax, checkSyntaxText, checksThroughCheckRun, parseCheckMessages } from '../../src/capabilities/checkrun.js';

/** ONPREM's answer to a class with an undeclared variable. */
const BROKEN =
  '<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
  '<chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="/sap/bc/adt/oo/classes/zcl_adtplus_b_c01" chkrun:status="processed" ' +
  'chkrun:statusText="Object ZCL_ADTPLUS_B_C01 has been checked"><chkrun:checkMessageList>' +
  '<chkrun:checkMessage chkrun:uri="/sap/bc/adt/oo/classes/zcl_adtplus_b_c01/source/main#start=17,20" chkrun:type="E" ' +
  'chkrun:shortText="Field &quot;PROBE_UNDECLARED_VAR&quot; is unknown.">' +
  '<atom:link href="art.syntax:GTU" rel="http://www.sap.com/adt/categories/quickfixes" xmlns:atom="http://www.w3.org/2005/Atom"/>' +
  '</chkrun:checkMessage></chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>';

const CLEAN =
  '<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
  '<chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="/sap/bc/adt/oo/classes/zcl_adtplus_b_c01" chkrun:status="processed" ' +
  'chkrun:statusText="Object ZCL_ADTPLUS_B_C01 has been checked"/></chkrun:checkRunReports>';

const MAIN = '/sap/bc/adt/oo/classes/zcl_adtplus_b_c01/source/main';

describe('parseCheckMessages', () => {
  it('turns SAP\'s 1-based line and 0-based column into an LSP range, E into severity 1', () => {
    expect(parseCheckMessages(BROKEN, MAIN)).toEqual([
      {
        range: { start: { line: 16, character: 20 }, end: { line: 16, character: 20 } },
        severity: 1,
        message: 'Field "PROBE_UNDECLARED_VAR" is unknown.',
      },
    ]);
  });

  it('names the include or object of a finding outside the checked text', () => {
    const other = BROKEN.replace(`${MAIN}#`, '/sap/bc/adt/oo/classes/zcl_adtplus_b_c01/includes/testclasses#').replace('chkrun:type="E"', 'chkrun:type="W"');
    expect(parseCheckMessages(other, MAIN)).toEqual([
      expect.objectContaining({ severity: 2, uri: '/sap/bc/adt/oo/classes/zcl_adtplus_b_c01/includes/testclasses' }),
    ]);
  });

  it('fails a report that was not processed instead of reading it as clean', () => {
    const notRun = CLEAN.replace('chkrun:status="processed"', 'chkrun:status="notProcessed"').replace('has been checked', 'is locked');
    expect(() => parseCheckMessages(notRun, MAIN)).toThrow(/the syntax check did not run \(notProcessed\): Object ZCL_ADTPLUS_B_C01 is locked/);
    expect(() => parseCheckMessages('<chkrun:checkRunReports xmlns:chkrun="x"/>', MAIN)).toThrow(/no report/);
  });

  it('keeps a message whose text holds an unescaped ">", and counts A as an error', () => {
    const arrow = BROKEN.replace('chkrun:shortText="Field &quot;PROBE_UNDECLARED_VAR&quot; is unknown."', 'chkrun:shortText="Method ME->DO_IT is unknown."').replace('chkrun:type="E"', 'chkrun:type="A"');
    expect(parseCheckMessages(arrow, MAIN)).toEqual([expect.objectContaining({ severity: 1, message: 'Method ME->DO_IT is unknown.' })]);
  });

  it('reads a clean report as no findings and refuses anything else', () => {
    expect(parseCheckMessages(CLEAN, MAIN)).toEqual([]);
    expect(() => parseCheckMessages('<html/>', MAIN)).toThrow(/not a check run report/);
  });
});

describe('checkObjectList', () => {
  it('carries the text base64 under the include URI', () => {
    const xml = checkObjectList('/sap/bc/adt/oo/classes/zcl_x', `/sap/bc/adt/oo/classes/zcl_x/includes/testclasses`, 'CLASS ltc DEFINITION.ä');
    expect(xml).toContain('adtcore:uri="/sap/bc/adt/oo/classes/zcl_x"');
    expect(xml).toContain('chkrun:uri="/sap/bc/adt/oo/classes/zcl_x/includes/testclasses"');
    const content = xml.match(/<chkrun:content>([^<]*)<\/chkrun:content>/)![1]!;
    expect(Buffer.from(content, 'base64').toString('utf8')).toBe('CLASS ltc DEFINITION.ä');
  });
});

type Call = { method: string; path: string; opts: RequestOptions };

function fakes(body: string, uri = '/sap/bc/adt/oo/classes/zcl_adtplus_b_c01') {
  const calls: Call[] = [];
  const searches: unknown[] = [];
  const rest = {
    expectOk: async (method: string, path: string, _context: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      return { status: 200, headers: new Headers(), body };
    },
  } as unknown as RawAdtClient;
  const adt = {
    repository: {
      search: async (query: string, opts: unknown) => {
        searches.push({ query, opts });
        return { references: [{ name: 'ZCL_ADTPLUS_B_C01_OLD', uri: '/sap/bc/adt/oo/classes/zcl_adtplus_b_c01_old' }, { name: 'ZCL_ADTPLUS_B_C01', uri }] };
      },
    },
  } as unknown as AdtLsClient;
  return { rest, adt, calls, searches };
}

describe('checkSyntaxText', () => {
  const ref = { name: 'zcl_adtplus_b_c01', objectType: 'CLAS/OC' };

  it('posts one check run with the text and reports findings as a REST fallback', async () => {
    const { rest, adt, calls } = fakes(BROKEN);
    const res = await checkSyntaxText(adt, rest, { ref, source: 'CLASS x.' }, undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/sap/bc/adt/checkruns',
      opts: {
        changesNothing: true,
        query: { reporters: 'abapCheckRun' },
        headers: { 'Content-Type': 'application/vnd.sap.adt.checkobjects+xml', Accept: 'application/vnd.sap.adt.checkmessages+xml' },
      },
    });
    expect(calls[0]!.opts.body).toContain(`chkrun:uri="${MAIN}"`);
    expect(res).toMatchObject({ result: { kind: 'full', items: [{ severity: 1 }] }, via: 'rest-fallback', nativeAvailable: null });
    expect(res.notes[0]).toMatch(/nothing was saved/);
  });

  it('checks a class include under its include URI', async () => {
    const { rest, adt, calls } = fakes(CLEAN);
    await checkSyntaxText(adt, rest, { ref, source: '', include: 'testclasses' }, undefined);
    expect(calls[0]!.opts.body).toContain('chkrun:uri="/sap/bc/adt/oo/classes/zcl_adtplus_b_c01/includes/testclasses"');
  });

  it('takes the object URI from an adt:// search hit without host or query', async () => {
    const { rest, adt, calls } = fakes(CLEAN, 'adt://DEV/sap/bc/adt/oo/classes/zcl_adtplus_b_c01?version=active');
    await checkSyntaxText(adt, rest, { ref, source: '' }, undefined);
    expect(calls[0]!.opts.body).toContain('adtcore:uri="/sap/bc/adt/oo/classes/zcl_adtplus_b_c01"');
  });

  it('refuses an include that is not a class include before any call', async () => {
    const { rest, adt, calls, searches } = fakes(CLEAN);
    await expect(checkSyntaxText(adt, rest, { ref, source: '', include: 'locals_imp' }, undefined)).rejects.toThrow(/abapGit's locals_imp is "implementations"/);
    await expect(checkSyntaxText(adt, rest, { ref: { name: 'ZIF_X', objectType: 'INTF/OI' }, source: '', include: 'testclasses' }, undefined)).rejects.toThrow(/only classes have includes/);
    expect([calls, searches]).toEqual([[], []]);
  });

  it('refuses a service binding before any call: it has no source', async () => {
    const { rest, adt, calls, searches } = fakes(CLEAN);
    await expect(checkSyntaxText(adt, rest, { ref: { name: 'Z_SB', objectType: 'SRVB/SVB' }, source: 'x' }, undefined)).rejects.toThrow(/SRVB Z_SB has no source/);
    expect([calls, searches]).toEqual([[], []]);
  });

  it('reports a missing object by name', async () => {
    const { rest, adt } = fakes(CLEAN);
    await expect(checkSyntaxText(adt, rest, { ref: { name: 'ZCL_NONE', objectType: 'CLAS/OC' }, source: '' }, undefined)).rejects.toThrow(/CLAS\/OC ZCL_NONE not found/);
  });

  it('says when the system offers the check natively', async () => {
    const { rest, adt } = fakes(CLEAN);
    const native = { syntaxText: true } as Parameters<typeof checkSyntaxText>[3];
    expect((await checkSyntaxText(adt, rest, { ref, source: '' }, native)).nativeAvailable).toBe(true);
  });
});

// AFF JSON types: adt-ls can't check CHDO, NROB, RONT, NONT, DESD.
const NR = '/sap/bc/adt/numberranges/objects/zadtp_apnr';

/** cloud-erp's answers for ZADTP_APNR; `NR_REPORT('…')` wraps check messages in a processed report. */
const NR_REPORT = (messages: string, status = 'processed', text = 'Object ZADTP_APNR has been checked') =>
  '<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
  `<chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="${NR}" chkrun:status="${status}" chkrun:statusText="${text}">` +
  `<chkrun:checkMessageList>${messages}</chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>`;
const NR_SYNTAX =
  `<chkrun:checkMessage chkrun:uri="${NR}/source/main#start=14,5" chkrun:type="E" chkrun:shortText="Unexpected token &quot;&quot;prefix&quot;&quot;. Expected was &quot;,&quot; or &quot;}&quot;" chkrun:code="X(1)"/>`;
const NO_INACTIVE = NR_REPORT('', 'notProcessed', 'Inactive version for NROB ZADTP_APNR does not exist');
const DEPRECATED =
  `<chkrun:checkMessage chkrun:uri="${NR}/source/main#start=9,5" chkrun:type="W" chkrun:shortText="Domain CHAR10 is deprecated. Use own type declaration or own object instead." chkrun:code="LA(024)"/>`;

function nrFakes(...bodies: string[]) {
  const calls: Call[] = [];
  const rest = {
    expectOk: async (method: string, path: string, _context: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      return { status: 200, headers: new Headers(), body: bodies[calls.length - 1] ?? bodies.at(-1) };
    },
  } as unknown as RawAdtClient;
  const adt = {
    repository: { search: async () => ({ references: [{ name: 'ZADTP_APNR', uri: NR }] }) },
  } as unknown as AdtLsClient;
  return { rest, adt, calls };
}

describe('JSON types through the check run', () => {
  const ref = { name: 'ZADTP_APNR', objectType: 'NROB/NRO' };

  it('names the types adt-ls cannot check', () => {
    expect(['CHDO/CHD', 'NROB/NRO', 'RONT/ROT', 'NONT/NOT', 'DESD'].every((objectType) => checksThroughCheckRun({ name: 'Z', objectType }))).toBe(true);
    expect(checksThroughCheckRun({ name: 'Z', objectType: 'ENQU/DL' })).toBe(false);
    expect(checksThroughCheckRun({ name: 'Z', objectType: 'CLAS/OC' })).toBe(false);
  });

  it('searches by the main type when the search finds nothing for the subtype', async () => {
    const calls: Call[] = [];
    const types: unknown[] = [];
    const rest = {
      expectOk: async (method: string, path: string, _context: string, opts: RequestOptions = {}) => {
        calls.push({ method, path, opts });
        return { status: 200, headers: new Headers(), body: NR_REPORT('') };
      },
    } as unknown as RawAdtClient;
    const adt = {
      repository: {
        search: async (_q: string, opts: { types: string[] }) => {
          types.push(opts.types);
          return { references: opts.types[0] === 'NROB' ? [{ name: 'ZADTP_APNR', uri: NR }] : [] };
        },
      },
    } as unknown as AdtLsClient;
    await checkStoredSyntax(adt, rest, ref);
    expect(types).toEqual([['NROB/NRO'], ['NROB']]);
    expect(calls[0]!.opts.body).toContain(`adtcore:uri="${NR}"`);
  });

  it('sends JSON text as application/json', async () => {
    const { rest, adt, calls } = nrFakes(NR_REPORT(NR_SYNTAX + NR_SYNTAX));
    const res = await checkSyntaxText(adt, rest, { ref, source: '{}' }, undefined);
    expect(calls[0]!.opts.body).toContain('chkrun:contentType="application/json; charset=utf-8"');
    // SAP reports a JSON syntax error twice: it counts once.
    expect(res.result).toEqual({ kind: 'full', items: [expect.objectContaining({ severity: 1, range: expect.objectContaining({ start: { line: 13, character: 5 } }) })] });
    const nont = nrFakes(NR_REPORT(''));
    await checkSyntaxText(nont.adt, nont.rest, { ref: { name: 'ZADTP_APNR', objectType: 'NONT/NOT' }, source: '{}' }, undefined);
    expect(nont.calls[0]!.opts.body).toContain('application/json');
  });

  it('checks the stored inactive version, else the active one', async () => {
    const { rest, adt, calls } = nrFakes(NO_INACTIVE, NR_REPORT(DEPRECATED));
    const res = await checkStoredSyntax(adt, rest, ref);
    expect(calls.map((c) => String(c.opts.body).match(/chkrun:version="(\w+)"/)![1])).toEqual(['inactive', 'active']);
    expect(calls[0]!.opts.body).not.toContain('<chkrun:artifacts>');
    expect(res).toMatchObject({ result: { kind: 'full', items: [{ severity: 2, message: expect.stringMatching(/CHAR10 is deprecated/) }] }, via: 'rest-fallback', nativeAvailable: null });
    expect(res.notes[0]).toMatch(/adt-ls can't check NROB/);
  });

  it('stops at the inactive version when it exists, and says which version it checked', async () => {
    const once = nrFakes(NR_REPORT(DEPRECATED));
    expect((await checkStoredSyntax(once.adt, once.rest, ref)).notes[0]).toMatch(/including unactivated changes/);
    expect(once.calls).toHaveLength(1);
    const fallback = nrFakes(NO_INACTIVE, NR_REPORT(''));
    expect((await checkStoredSyntax(fallback.adt, fallback.rest, ref)).notes[0]).toMatch(/as last activated/);
  });

  it('tries the active version on any unprocessed inactive check, whatever the language, and fails when that is not processed either', async () => {
    const german = nrFakes(NR_REPORT('', 'notProcessed', 'Inaktive Version für NROB ZADTP_APNR existiert nicht'), NR_REPORT(''));
    await expect(checkStoredSyntax(german.adt, german.rest, ref)).resolves.toMatchObject({ result: { items: [] } });
    const locked = nrFakes(NR_REPORT('', 'notProcessed', 'Object ZADTP_APNR is locked'));
    await expect(checkStoredSyntax(locked.adt, locked.rest, ref)).rejects.toThrow(/is locked/);
    expect(locked.calls).toHaveLength(2);
  });

  it('keeps ABAP findings as they come: the object\'s own uri, repeats included', () => {
    const cls = '/sap/bc/adt/oo/classes/zcl_x';
    const msg = `<chkrun:checkMessage chkrun:uri="${cls}" chkrun:type="E" chkrun:shortText="Class error"/>`;
    expect(parseCheckMessages(NR_REPORT(msg + msg), `${cls}/includes/testclasses`)).toEqual([
      expect.objectContaining({ uri: cls }),
      expect.objectContaining({ uri: cls }),
    ]);
  });

  it('searches a CDS type adt-ls\'s filter misses by its main type at once', async () => {
    const types: unknown[] = [];
    const sty = '/sap/bc/adt/ddic/drty/sources/zadtplus_ap_amount';
    const adt = {
      repository: {
        search: async (_q: string, opts: { types: string[] }) => {
          types.push(opts.types);
          return { references: opts.types[0] === 'DRTY' ? [{ name: 'ZADTPLUS_AP_AMOUNT', uri: sty }] : [] };
        },
      },
    } as unknown as AdtLsClient;
    const { rest, calls } = nrFakes(NR_REPORT(''));
    await checkSyntaxText(adt, rest, { ref: { name: 'ZADTPLUS_AP_AMOUNT', objectType: 'DRTY/STY' }, source: '' }, undefined);
    expect(types).toEqual([['DRTY']]);
    expect(calls[0]!.opts.body).toContain(`adtcore:uri="${sty}"`);
  });

  it('searches a missing ABAP object by its own type only', async () => {
    const types: unknown[] = [];
    const adt = {
      repository: {
        search: async (_q: string, opts: { types: string[] }) => {
          types.push(opts.types);
          return { references: opts.types[0] === 'FUGR' ? [{ name: 'ZFOO', uri: '/sap/bc/adt/functions/groups/zfoo' }] : [] };
        },
      },
    } as unknown as AdtLsClient;
    const { rest } = nrFakes(NR_REPORT(''));
    await expect(checkSyntaxText(adt, rest, { ref: { name: 'ZFOO', objectType: 'FUGR/FF' }, source: '' }, undefined)).rejects.toThrow(/FUGR\/FF ZFOO not found/);
    expect(types).toEqual([['FUGR/FF']]);
  });

  it('reads a finding on the object itself, without a position, as the checked text\'s', () => {
    const table = `<chkrun:checkMessage chkrun:uri="${NR}" chkrun:type="E" chkrun:shortText="Table ZZ_NO_SUCH_TAB does not exist"/>`;
    expect(parseCheckMessages(NR_REPORT(table), `${NR}/source/main`, { objUri: NR })).toEqual([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, message: 'Table ZZ_NO_SUCH_TAB does not exist' },
    ]);
  });
});
