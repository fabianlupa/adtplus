import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RawAdtClient, RequestOptions } from '../../src/backends/rawadt.js';
import {
  buildXliff,
  narrowAndPage,
  parseXliff,
  prepareFilter,
  prepareProjectRead,
  prepareTranslations,
  readTranslationProject,
  readTranslations,
  sourceObject,
  textSourceOf,
  type TranslationEntry,
  type TranslationsDeps,
} from '../../src/capabilities/translations.js';
import type { Destination } from '../../src/core/destinations.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/translations/${name}`, import.meta.url), 'utf8');

/**
 * Recorded on cloud-erp (UI_SMTR_PROJECT, F4950 2608.0.0): ZADTPLUS_TRPR_P4 (source MESSAGE_CL ZADTPLUS_TRPR_SUB)
 * and ZADTPLUS_TRPR_P5 (PACKAGE ZADTPLUS_ADT_DIFF_SUB) both EN→DE; P5 published 001, so P4's DELTA still
 * has it. ZADTPLUS_TRPR_P2 holds one source of each type, a text pool among them; ZADTPLUS_TRPR_P3's text
 * pools have no EN text.
 */
const PROJECTS = fixture('projects.json');
const METADATA = fixture('metadata.xml');
const files: Record<string, string> = {
  'ZADTPLUS_TRPR_P4 ALL': fixture('ZADTPLUS_TRPR_P4-ALL.xlf'),
  'ZADTPLUS_TRPR_P4 DELTA': fixture('ZADTPLUS_TRPR_P4-DELTA.xlf'),
  'ZADTPLUS_TRPR_P5 ALL': fixture('ZADTPLUS_TRPR_P5-ALL.xlf'),
  'ZADTPLUS_TRPR_P5 DELTA': fixture('ZADTPLUS_TRPR_P5-DELTA.xlf'),
  'ZADTPLUS_TRPR_P2 ALL': fixture('ZADTPLUS_TRPR_P2-ALL.xlf'),
  'ZADTPLUS_TRPR_P2 DELTA': fixture('ZADTPLUS_TRPR_P2-ALL.xlf'),
  'ZADTPLUS_TRPR_P3 ALL': fixture('ZADTPLUS_TRPR_P3-ALL.xlf'),
  'ZADTPLUS_TRPR_P3 DELTA': fixture('ZADTPLUS_TRPR_P3-ALL.xlf'),
};

const destination: Destination = {
  id: 'cloud-erp',
  kind: 'cloud',
  auth: 'interactive',
  client: '100',
  systemUrl: 'https://cloud-erp.invalid',
  extraCaCerts: [],
  writeAllowlist: [],
  allowTranslations: true,
} as unknown as Destination;

type Call = { method: string; path: string; opts: RequestOptions };
const unquote = (v: string | undefined) => v?.replace(/^'|'$/g, '');

function fakeRest(opts: { metadata?: string; projects?: string; files?: Record<string, string>; sapMessage?: string } = {}): RawAdtClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request: async (method: string, path: string, o: RequestOptions = {}) => {
      calls.push({ method, path, opts: o });
      const ok = (body: string, headers: Record<string, string> = {}) => ({ status: 200, headers: new Headers(headers), body });
      if (path.endsWith('/$metadata')) return ok(opts.metadata ?? METADATA);
      if (path.endsWith('/Project')) return ok(opts.projects ?? PROJECTS);
      const one = path.match(/\/Project\(ID='([^']*)',Type='5'\)$/);
      if (one) {
        const row = (JSON.parse(opts.projects ?? PROJECTS) as { d: { results: Array<{ ID: string }> } }).d.results.find((r) => r.ID === one[1]);
        return row ? ok(JSON.stringify({ d: row })) : { status: 404, headers: new Headers(), body: '{"error":{"code":"/IWBEP/CM_MGW_RT/020","message":{"value":"Resource not found"}}}' };
      }
      if (path.endsWith('/downloadTranslationFile')) {
        const key = `${unquote(o.query!.ProjectID)} ${unquote(o.query!.downloadType)}`;
        const file = (opts.files ?? files)[key];
        if (file === undefined) throw new Error(`no file for ${key}`);
        return ok(JSON.stringify({ d: { downloadTranslationFile: { fileContent: file } } }), opts.sapMessage ? { 'sap-message': opts.sapMessage } : {});
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as RawAdtClient & { calls: Call[] };
}

function deps(rest: RawAdtClient, where: { package?: string; objects?: Array<{ objectType: string; name: string }> } = {}): TranslationsDeps & { checks: unknown[] } {
  const checks: unknown[] = [];
  return {
    checks,
    withRest: (fn) => fn(rest),
    objectPackage: async () => where.package ?? 'ZADTPLUS_ADT_DIFF_SUB',
    packageObjects: async () => where.objects ?? [],
    onServiceCheck: (c) => checks.push(c),
  };
}

const downloads = (rest: { calls: Call[] }) =>
  rest.calls.filter((c) => c.path.endsWith('/downloadTranslationFile')).map((c) => `${unquote(c.opts.query!.ProjectID)} ${unquote(c.opts.query!.downloadType)}`);

describe('XLIFF', () => {
  it('reads units by group: ADT type and name, key, decoded texts, maxwidth, note', () => {
    const { units, problems } = parseXliff(files['ZADTPLUS_TRPR_P4 ALL']!);
    expect(problems).toEqual([]);
    expect(units).toEqual([
      {
        objectType: 'MSAG/N',
        name: 'ZADTPLUS_TRPR_SUB',
        key: 'SHORT_TEXT:001',
        id: 'MESSAGE_CLASS:ZADTPLUS_TRPR_SUB:SHORT_TEXT:001',
        group: { datatype: 'x-MESSAGE_CLASS', resname: 'ZADTPLUS_TRPR_SUB' },
        source: 'Order & saved',
        target: 'Auftrag & gesichert',
        maxwidth: 73,
        note: 'Short description for message 001 of message class ZADTPLUS_TRPR_SUB.',
      },
      expect.objectContaining({ key: 'SHORT_TEXT:002', source: 'Item <&1> not found' }),
    ]);
    expect(units[1]).not.toHaveProperty('target');
  });

  it('maps every group type the probes saw; unmapped ones keep their own type, odd ids stay whole', () => {
    const { units, problems } = parseXliff(files['ZADTPLUS_TRPR_P2 ALL']!);
    expect(problems).toEqual([]);
    const byObject = new Map(units.map((u) => [`${u.objectType} ${u.name}`, u]));
    expect([...byObject.keys()]).toEqual(
      expect.arrayContaining([
        'DTEL/DE ZADTPLUS_RECIPE_RATING',
        'DOMA/DD ZADTPLUS_RECIPE_RATING',
        'DDLS/DF ZC_ADTPLUS_RECIPE',
        'DDLX/EX ZC_ADTPLUS_RECIPE',
        'CLAS/OC ZCL_ADTPLUS_TRPR_TP',
        'LTO_DRTY ZADTPLUS_RECIPE_RATING_CDS',
        'IAM_BUSINESS_CATALOG ZADTPLUS_JOB_TEST',
        'LTO_UIAD ZDMO_FLIGHT_ADT',
      ]),
    );
    expect(units.filter((u) => u.objectType === 'CLAS/OC').map((u) => [u.key, u.source, u.maxwidth])).toEqual([
      ['TEXT_ELEMENT_TEXT:TEXT_SYMBOL:001', 'Customer saved', 20],
      ['TEXT_ELEMENT_TEXT:TEXT_SYMBOL:002', 'No order for this customer', 30],
    ]);
    expect(units.find((u) => u.objectType === 'DOMA/DD')!.key).toBe('FIXED_VALUE_DESCRIPTION:5');
    expect(units.find((u) => u.objectType === 'DDLX/EX' && u.key.startsWith('UI.FACET'))!.key).toBe('UI.FACET$1$.LABEL:FIELD:UUID');
    expect(units.find((u) => u.objectType === 'LTO_DRTY')!.key).toMatch(/^ANNO_TEXT:RECORD:DDDRTY_A_TYPE_T:/);
    // An empty <source/> (an unset launchpad text) is a unit with an empty source.
    expect(units.some((u) => u.source === '')).toBe(true);
  });

  it("writes an upload as SAP's download is written, reading back as sent: only the given units, escaped, with the file's languages", () => {
    const file = parseXliff(files['ZADTPLUS_TRPR_P4 ALL']!);
    const xml = buildXliff('ZADTPLUS_TRPR_P4', file.languages, [{ ...file.units[1]!, target: 'Position <&1> fehlt & "nie" da' }]);
    expect(xml).toContain('source-language="en-US" target-language="de-DE"');
    expect(xml).toContain('<tool tool-id="adtplus" tool-name="adt+"/>');
    expect(xml).toContain('<group datatype="x-MESSAGE_CLASS" resname="ZADTPLUS_TRPR_SUB">');
    const back = parseXliff(xml);
    expect(back.problems).toEqual([]);
    expect(back.units).toEqual([{ ...file.units[1]!, target: 'Position <&1> fehlt & "nie" da' }]);
  });

  it('reads an empty body as no units', () => {
    expect(parseXliff(files['ZADTPLUS_TRPR_P3 ALL']!)).toEqual({ units: [], languages: { source: 'en-US', target: 'de-DE' }, problems: [] });
  });

  it('tells an empty target from none, and decodes in one pass', () => {
    const unit = (source: string) =>
      '<xliff version="1.2"><file><body><group datatype="x-DATA_ELEMENT" resname="ZDE">' +
      `<trans-unit id="DATA_ELEMENT:ZDE:SHORT_DESCRIPTION" maxwidth="60"><source>${source}</source><target/></trans-unit>` +
      '</group></body></file></xliff>';
    expect(parseXliff(unit('A&#228;&#x20AC;')).units[0]).toMatchObject({ source: 'Aä€', target: '' });
    // The text "&#38;lt;" stays that text; a reference past Unicode stays as written.
    expect(parseXliff(unit('&amp;#38;lt; &amp;amp;')).units[0]!.source).toBe('&#38;lt; &amp;');
    expect(parseXliff(unit('x&#x110000;')).units[0]!.source).toBe('x&#x110000;');
  });

  it('reports what lacks the structure: no file, a unit without maxwidth, a unit outside a group, an unknown id', () => {
    expect(parseXliff('<html/>').problems).toEqual(['not an XLIFF file: no <xliff> element']);
    expect(parseXliff('<xliff version="1.2"></xliff>').problems).toEqual(['no <file> element']);
    const xml =
      '<xliff><file><body><group datatype="x-MESSAGE_CLASS" resname="ZM"><trans-unit id="OTHER:1"><source>s</source></trans-unit></group>' +
      '<trans-unit id="LOOSE" maxwidth="5"><source>x</source></trans-unit></body></file></xliff>';
    const { units, problems } = parseXliff(xml);
    expect(problems).toEqual(['unit OTHER:1 has no maxwidth', '1 trans-unit(s) outside a group']);
    expect(units[0]).toMatchObject({ objectType: 'MSAG/N', name: 'ZM', key: 'OTHER:1' });
  });
});

describe('text sources', () => {
  it('maps text sources to ADT objects and back', () => {
    expect(sourceObject('TEXT_POOL', 'CL_ZCL_X')).toEqual({ objectType: 'CLAS/OC', name: 'ZCL_X' });
    expect(sourceObject('TEXT_POOL', 'FG_ZFG')).toEqual({ objectType: 'FUGR/F', name: 'ZFG' });
    expect(sourceObject('PACKAGE', 'ZP')).toEqual({ objectType: 'DEVC/K', name: 'ZP' });
    expect(sourceObject('LTO_DRTY', 'X')).toBeUndefined();
    expect(textSourceOf({ objectType: 'CLAS/OC', name: 'zcl_x' })).toEqual({ type: 'TEXT_POOL', name: 'CL_ZCL_X' });
    expect(textSourceOf({ objectType: 'DTEL', name: 'ZDE' })).toEqual({ type: 'DATA_ELEM', name: 'ZDE' });
    expect(textSourceOf({ objectType: 'TABL/DT', name: 'ZT' })).toBeUndefined();
  });
});

describe('checks before any call', () => {
  it('refuses without allowTranslations, naming the switch', () => {
    const off = { ...destination, allowTranslations: undefined } as Destination;
    expect(() => prepareTranslations(off, { ref: { objectType: 'MSAG/N', name: 'Z' } })).toThrow(/translations are off here\. They need "allowTranslations": true/);
    expect(() => prepareProjectRead(off, {})).toThrow(/translations are off here/);
  });

  it('refuses a type no text source maps, a bad status, language, maxResults, grep or cursor', () => {
    const ref = { objectType: 'MSAG/N', name: 'Z' };
    expect(() => prepareTranslations(destination, { ref: { objectType: 'TABL/DT', name: 'Z' } })).toThrow(/translations reads DEVC, DDLS, DDLX, DTEL, DOMA, MSAG, CLAS, FUGR .*not TABL\/DT/);
    expect(() => prepareTranslations(destination, { ref, translationStatus: ['stale' as never] })).toThrow(/takes translated, missing, outdated, empty, not stale/);
    expect(() => prepareTranslations(destination, { ref, translationStatus: [] })).toThrow(/is a list of/);
    expect(() => prepareTranslations(destination, { ref, language: 'german' })).toThrow(/"german" is not a language AFF lists/);
    expect(() => prepareTranslations(destination, { ref, maxResults: 501 })).toThrow(/"maxResults" is 0 to 500/);
    expect(() => prepareTranslations(destination, { ref, grep: '(' })).toThrow(/"grep" is not a regular expression/);
    expect(() => prepareTranslations(destination, { ref, cursor: 'nonsense' })).toThrow(/"cursor" is not one a translation read gave/);
  });

  it('a project read takes text narrowing only with translationStatus', () => {
    expect(() => prepareProjectRead(destination, { grep: 'x' })).toThrow(/"grep" narrow a project's texts: add "translationStatus"/);
    expect(prepareProjectRead(destination, {})).toBeUndefined();
    expect(prepareProjectRead(destination, { language: 'de' })).toEqual({ target: 'DE', maxResults: 0 });
  });
});

describe('object translations', () => {
  it('reads an object from every project covering it, with each project its own status, and warns about the overlap', async () => {
    const rest = fakeRest();
    const d = deps(rest);
    const result = await readTranslations(d, destination, prepareTranslations(destination, { ref: { objectType: 'MSAG/N', name: 'zadtplus_trpr_sub' } }));
    expect(result.projects).toEqual([
      { project: 'ZADTPLUS_TRPR_P4', package: 'ZADTPLUS_ADT_DIFF_SUB', languages: [{ sourceLanguage: 'en', language: 'de' }] },
      { project: 'ZADTPLUS_TRPR_P5', package: 'ZADTPLUS_ADT_DIFF_SUB', languages: [{ sourceLanguage: 'en', language: 'de' }] },
    ]);
    expect(result.translations.map((e) => [e.project, e.key, e.status, e.target])).toEqual([
      ['ZADTPLUS_TRPR_P4', 'SHORT_TEXT:001', 'outdated', 'Auftrag & gesichert'],
      ['ZADTPLUS_TRPR_P4', 'SHORT_TEXT:002', 'missing', undefined],
      ['ZADTPLUS_TRPR_P5', 'SHORT_TEXT:001', 'translated', 'Auftrag & gesichert'],
      ['ZADTPLUS_TRPR_P5', 'SHORT_TEXT:002', 'missing', undefined],
    ]);
    expect(result.translations[0]).toEqual({
      project: 'ZADTPLUS_TRPR_P4',
      sourceLanguage: 'en',
      language: 'de',
      objectType: 'MSAG/N',
      name: 'ZADTPLUS_TRPR_SUB',
      key: 'SHORT_TEXT:001',
      source: 'Order & saved',
      target: 'Auftrag & gesichert',
      maxwidth: 73,
      note: 'Short description for message 001 of message class ZADTPLUS_TRPR_SUB.',
      status: 'outdated',
    });
    expect(result.warnings).toEqual([expect.stringMatching(/^projects ZADTPLUS_TRPR_P4, ZADTPLUS_TRPR_P5 all cover MSAG\/N ZADTPLUS_TRPR_SUB for en→de: each has its own "outdated"/)]);
    expect(result).toMatchObject({ total: 4, via: 'odata-ui' });
    expect(result).not.toHaveProperty('truncated');
    expect(d.checks).toEqual([expect.objectContaining({ ok: true })]);
    // The service check first, then one lookup, then ALL and DELTA per pair.
    expect(rest.calls.map((c) => c.path.split('/').pop())).toEqual(['$metadata', 'Project', ...Array(4).fill('downloadTranslationFile')]);
    expect(rest.calls[1]!.opts.query).toMatchObject({ $filter: "Type eq '5'", $expand: 'to_TextSource,to_Translation' });
  });

  it('narrows by status and grep, and skips DELTA when no status needs it', async () => {
    const rest = fakeRest();
    const outdated = await readTranslations(deps(rest), destination, prepareTranslations(destination, { ref: { objectType: 'MSAG/N', name: 'ZADTPLUS_TRPR_SUB' }, translationStatus: ['outdated'] }));
    expect(outdated.translations.map((e) => `${e.project} ${e.key}`)).toEqual(['ZADTPLUS_TRPR_P4 SHORT_TEXT:001']);

    const missingRest = fakeRest();
    const missing = await readTranslations(
      deps(missingRest),
      destination,
      prepareTranslations(destination, { ref: { objectType: 'MSAG/N', name: 'ZADTPLUS_TRPR_SUB' }, translationStatus: ['missing'], grep: 'item <&1>' }),
    );
    expect(missing.translations.map((e) => `${e.project} ${e.key}`)).toEqual(['ZADTPLUS_TRPR_P4 SHORT_TEXT:002', 'ZADTPLUS_TRPR_P5 SHORT_TEXT:002']);
    expect(downloads(missingRest)).toEqual(['ZADTPLUS_TRPR_P4 ALL', 'ZADTPLUS_TRPR_P5 ALL']);
  });

  it('finds a text pool through its CL_ source and a package through its own objects', async () => {
    const pool = await readTranslations(
      deps(fakeRest(), { package: 'ZADTPLUS_TEST' }),
      destination,
      prepareTranslations(destination, { ref: { objectType: 'CLAS/OC', name: 'ZCL_ADTPLUS_TRPR_TP' } }),
    );
    expect(pool.projects.map((p) => p.project)).toEqual(['ZADTPLUS_TRPR_P2']);
    expect(pool.translations.map((e) => [e.objectType, e.name, e.key, e.status])).toEqual([
      ['CLAS/OC', 'ZCL_ADTPLUS_TRPR_TP', 'TEXT_ELEMENT_TEXT:TEXT_SYMBOL:001', 'missing'],
      ['CLAS/OC', 'ZCL_ADTPLUS_TRPR_TP', 'TEXT_ELEMENT_TEXT:TEXT_SYMBOL:002', 'missing'],
    ]);
    expect(pool.warnings).toEqual([]);

    const pkg = await readTranslations(
      deps(fakeRest(), { objects: [{ objectType: 'MSAG', name: 'ZADTPLUS_TRPR_SUB' }] }),
      destination,
      prepareTranslations(destination, { ref: { objectType: 'DEVC/K', name: 'ZADTPLUS_ADT_DIFF_SUB' } }),
    );
    expect(pkg.projects.map((p) => p.project)).toEqual(['ZADTPLUS_TRPR_P4', 'ZADTPLUS_TRPR_P5']);
    expect(pkg.total).toBe(4);

    // P2 covers ZADTP_TEMPLATE_DOCUMENT through its PACKAGE source; texts without an ADT type can't be placed.
    const template = await readTranslations(
      deps(fakeRest(), { objects: [{ objectType: 'DTEL', name: 'ZADTP_TEMPLATE_DOCUMENT' }] }),
      destination,
      prepareTranslations(destination, { ref: { objectType: 'DEVC/K', name: 'ZADTP_TEMPLATE_DOCUMENT' } }),
    );
    expect(new Set(template.translations.map((e) => e.name))).toEqual(new Set(['ZADTP_TEMPLATE_DOCUMENT']));
    expect(template.warnings).toEqual([
      expect.stringMatching(/^ZADTPLUS_TRPR_P2 en→de: texts of LTO_DRTY, LTO_SAJC, LTO_SAJT, IAM_BUSINESS_CATALOG, LTO_UIAD are left out.*read TRPR ZADTPLUS_TRPR_P2/),
    ]);
  });

  it('keeps only the asked-for object out of a project with many sources', async () => {
    const result = await readTranslations(
      deps(fakeRest(), { package: 'ZADTPLUS_RECIPES' }),
      destination,
      prepareTranslations(destination, { ref: { objectType: 'DTEL/DE', name: 'ZADTPLUS_RECIPE_RATING' } }),
    );
    expect(new Set(result.translations.map((e) => `${e.objectType} ${e.name}`))).toEqual(new Set(['DTEL/DE ZADTPLUS_RECIPE_RATING']));
    expect(result.translations.map((e) => e.key)).toEqual(['HEADING_FIELD_LABEL', 'LONG_FIELD_LABEL', 'MEDIUM_FIELD_LABEL', 'SHORT_DESCRIPTION', 'SHORT_FIELD_LABEL']);
  });

  it('says when no project covers the object, without downloading', async () => {
    const rest = fakeRest();
    const result = await readTranslations(deps(rest, { package: 'ZOTHER' }), destination, prepareTranslations(destination, { ref: { objectType: 'DTEL/DE', name: 'ZNOPE' } }));
    expect(result).toMatchObject({ projects: [], translations: [], total: 0 });
    expect(result.warnings).toEqual(['no translation project covers DTEL/DE ZNOPE (or its package ZOTHER); adt+ never creates one to read']);
    expect(downloads(rest)).toEqual([]);
  });

  it("says when a covering project's file has no text of the object, with SAP's warnings about it", async () => {
    const projects = JSON.stringify({
      d: { results: [{ ID: 'ZP', Type: '5', Description: '', PackageName: 'ZPKG', to_TextSource: { results: [{ Type: 'BNS_CNFG_O', Name: 'X' }, { Type: 'DATA_ELEM', Name: 'ZADTPLUS_CURR' }] }, to_Translation: { results: [{ SourceLanguage: 'EN', TargetLanguage: 'DE', PublishStatus: 'INITIAL' }] } }] },
    });
    const sapMessage = '{"code":"SMTR/108","message":"No text found for SHORT_FIELD_LABEL of data element ZADTPLUS_CURR in language EN.","severity":"warning","details":[{"code":"SMTR/108","message":"No text found for NAME of ZOTHER.","severity":"warning"}]}';
    const rest = fakeRest({ projects, files: { 'ZP ALL': files['ZADTPLUS_TRPR_P3 ALL']!, 'ZP DELTA': files['ZADTPLUS_TRPR_P3 ALL']! }, sapMessage });
    const result = await readTranslations(deps(rest), destination, prepareTranslations(destination, { ref: { objectType: 'DTEL/DE', name: 'ZADTPLUS_CURR' } }));
    expect(result.warnings).toEqual([
      'ZP en→de has no text of DTEL/DE ZADTPLUS_CURR: no translatable text in en (SMTR/108: No text found for SHORT_FIELD_LABEL of data element ZADTPLUS_CURR in language EN.)',
    ]);
  });

  it('reads only the pairs with the asked-for target language', async () => {
    const rest = fakeRest();
    const result = await readTranslations(deps(rest), destination, prepareTranslations(destination, { ref: { objectType: 'MSAG/N', name: 'ZADTPLUS_TRPR_SUB' }, language: 'fr' }));
    expect(result.total).toBe(0);
    expect(downloads(rest)).toEqual([]);
    expect(result.warnings).toEqual(['ZADTPLUS_TRPR_P4 has no language pair with target fr', 'ZADTPLUS_TRPR_P5 has no language pair with target fr']);
  });

  it('refuses before any download when the service changed', async () => {
    const rest = fakeRest({ metadata: METADATA.replace(/<Parameter Name="fileType"[^>]*\/>/, '') });
    await expect(readTranslations(deps(rest), destination, prepareTranslations(destination, { ref: { objectType: 'MSAG/N', name: 'ZADTPLUS_TRPR_SUB' } }))).rejects.toThrow(
      'UI_SMTR_PROJECT changed on cloud-erp: downloadTranslationFile(fileType) is missing',
    );
    expect(rest.calls.map((c) => c.path.split('/').pop())).toEqual(['$metadata']);
  });
});

describe('paging', () => {
  const entry = (project: string, key: string, status: TranslationEntry['status'] = 'missing'): TranslationEntry => ({
    project,
    sourceLanguage: 'en',
    language: 'de',
    objectType: 'MSAG/N',
    name: 'ZM',
    key,
    source: `text ${key}`,
    status,
  });

  it('sorts by project, pair, object and key, and pages by the last entry', () => {
    const entries = [entry('ZB', '001'), entry('ZA', '002'), entry('ZA', '001'), entry('ZB', '002')];
    const first = narrowAndPage(entries, prepareFilter({ maxResults: 3 }));
    expect(first.translations.map((e) => `${e.project} ${e.key}`)).toEqual(['ZA 001', 'ZA 002', 'ZB 001']);
    expect(first).toMatchObject({ total: 4, truncated: true });
    const second = narrowAndPage(entries, prepareFilter({ maxResults: 3, cursor: first.nextCursor }));
    expect(second.translations.map((e) => `${e.project} ${e.key}`)).toEqual(['ZB 002']);
    expect(second).not.toHaveProperty('truncated');
    expect(second).not.toHaveProperty('nextCursor');
  });

  it('does not shift the next page when a text before the cursor changes status between two pages', () => {
    const entries = [entry('ZA', '001'), entry('ZA', '002'), entry('ZA', '003')];
    const first = narrowAndPage(entries, prepareFilter({ maxResults: 2, translationStatus: ['missing'] }));
    expect(first.translations.map((e) => e.key)).toEqual(['001', '002']);
    // 001 was published in between: it leaves the "missing" list, and the next page still starts after 002.
    const later = [entry('ZA', '001', 'translated'), entry('ZA', '002'), entry('ZA', '003')];
    const second = narrowAndPage(later, prepareFilter({ maxResults: 2, translationStatus: ['missing'], cursor: first.nextCursor }));
    expect(second.translations.map((e) => e.key)).toEqual(['003']);
  });

  it('maxResults 0 gives only the total', () => {
    expect(narrowAndPage([entry('ZA', '001')], prepareFilter({ maxResults: 0 }))).toEqual({ translations: [], total: 1 });
  });
});

describe('read TRPR', () => {
  it('reads the definition without downloading anything', async () => {
    const rest = fakeRest();
    const read = await readTranslationProject(rest, destination, { name: 'zadtplus_trpr_p5', objectType: 'TRPR' }, undefined);
    expect(read).toEqual({
      name: 'ZADTPLUS_TRPR_P5',
      objectType: 'TRPR',
      package: 'ZADTPLUS_ADT_DIFF_SUB',
      properties: {
        header: { description: 'Throwaway, adt+ probe' },
        package: 'ZADTPLUS_ADT_DIFF_SUB',
        textSources: [{ type: 'PACKAGE', name: 'ZADTPLUS_ADT_DIFF_SUB', objectType: 'DEVC/K' }],
        languages: [
          {
            source: 'en',
            target: 'de',
            publishStatus: 'SUCCESS',
            lastUploaded: { at: expect.stringMatching(/^2026-10-13T\d\d:\d\d:\d\d\.\d{3}Z$/), by: 'Jane Doe' },
            lastPublished: { at: expect.stringMatching(/^2026-10-13T/), by: 'Jane Doe' },
          },
        ],
      },
      via: 'odata-ui',
    });
    expect(downloads(rest)).toEqual([]);
    expect(rest.calls[1]!.path).toBe("/sap/opu/odata/sap/UI_SMTR_PROJECT/Project(ID='ZADTPLUS_TRPR_P5',Type='5')");
  });

  it('names a text pool source by its class, and leaves unmapped sources without an ADT type', async () => {
    const read = await readTranslationProject(fakeRest(), destination, { name: 'ZADTPLUS_TRPR_P2', objectType: 'TRPR' }, undefined);
    expect(read.properties.textSources).toEqual(
      expect.arrayContaining([
        { type: 'TEXT_POOL', name: 'CL_ZCL_ADTPLUS_TRPR_TP', objectType: 'CLAS/OC', objectName: 'ZCL_ADTPLUS_TRPR_TP' },
        { type: 'DATA_ELEM', name: 'ZADTPLUS_RECIPE_RATING', objectType: 'DTEL/DE' },
        { type: 'LTO_DRTY', name: 'ZADTPLUS_RECIPE_RATING_CDS' },
      ]),
    );
    expect(read.properties.languages[0]).not.toHaveProperty('lastUploaded');
  });

  it('with translationStatus: the texts without the project, narrowed, and the counts of each pair', async () => {
    const read = await readTranslationProject(fakeRest(), destination, { name: 'ZADTPLUS_TRPR_P4', objectType: 'TRPR' }, prepareProjectRead(destination, { translationStatus: ['outdated'] }));
    expect(read.properties.languages[0]!.counts).toEqual({ translated: 0, missing: 1, outdated: 1, empty: 0 });
    expect(read.properties.translations).toEqual([expect.objectContaining({ key: 'SHORT_TEXT:001', status: 'outdated' })]);
    expect(read.properties.translations![0]).not.toHaveProperty('project');
    expect(read.total).toBe(1);

    const counts = await readTranslationProject(fakeRest(), destination, { name: 'ZADTPLUS_TRPR_P4', objectType: 'TRPR' }, prepareProjectRead(destination, { translationStatus: ['missing'], maxResults: 0 }));
    expect(counts.properties.translations).toEqual([]);
    expect(counts).toMatchObject({ total: 1 });
    expect(counts).not.toHaveProperty('truncated');
  });

  it('keeps a project name inside the entity key of the path', async () => {
    const rest = fakeRest();
    await readTranslationProject(rest, destination, { name: 'x/../../#y?z', objectType: 'TRPR' }, undefined).catch(() => undefined);
    expect(rest.calls[1]!.path).toBe("/sap/opu/odata/sap/UI_SMTR_PROJECT/Project(ID='X%2F..%2F..%2F%23Y%3FZ',Type='5')");
  });

  it('refuses a project that does not exist', async () => {
    await expect(readTranslationProject(fakeRest(), destination, { name: 'ZNOPE', objectType: 'TRPR' }, undefined)).rejects.toThrow(
      'translation project ZNOPE does not exist (adt+ reads developer projects, type 5)',
    );
  });
});
