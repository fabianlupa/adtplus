import { describe, expect, it } from 'vitest';
import { buildDomainXml, DOMAIN, parseDomainXml, type Domain } from '../../src/capabilities/domain.js';
import { createFormObject, deleteFormObject, gateFormObjects, updateFormObject } from '../../src/capabilities/rest-form-object.js';
import { formType, domainCreate, domainProperties, domainUpdate } from '../../src/capabilities/properties.js';
import { activateRest, parseActivationXml } from '../../src/capabilities/rest-activation.js';
import type { Destination } from '../../src/core/destinations.js';
import { packageBody, routedRest } from '../helpers/rest.js';

// Trimmed from the live ONPREM GET of ZADTPLUS_DD_PROBE.
function domainXml(o: Partial<Domain> & { appendOf?: string } = {}): string {
  const values = o.fixedValues ?? [
    { low: 'A', high: '', text: 'Alpha' },
    { low: 'X10', high: 'X19', text: 'Range &amp; more' },
  ];
  return (
    '<?xml version="1.0" encoding="utf-8"?><doma:domain adtcore:responsible="DEVELOPER" ' +
    `adtcore:masterLanguage="${o.masterLanguage ?? 'EN'}" adtcore:masterSystem="DEV" adtcore:abapLanguageVersion="${o.abapLanguageVersion ?? 'standard'}" ` +
    `adtcore:name="${o.name ?? 'ZADTPLUS_DOM'}" adtcore:type="DOMA/DD" adtcore:changedAt="2026-10-14T04:38:04Z" adtcore:version="${o.version ?? 'active'}" ` +
    `adtcore:description="${o.description ?? 'Demo'}" adtcore:language="EN" ` +
    'xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<atom:link href="versions" rel="http://www.sap.com/adt/relations/versions" title="Historic versions" xmlns:atom="http://www.w3.org/2005/Atom"/>' +
    `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/zpkg" adtcore:type="DEVC/K" adtcore:name="${o.package ?? 'ZPKG'}" adtcore:description="Package"/>` +
    '<doma:content><doma:typeInformation>' +
    `<doma:datatype>${o.dataType ?? 'CHAR'}</doma:datatype><doma:length>${String(o.length ?? 3).padStart(6, '0')}</doma:length>` +
    `<doma:decimals>${String(o.decimals ?? 0).padStart(6, '0')}</doma:decimals></doma:typeInformation>` +
    `<doma:outputInformation><doma:length>${String(o.outputLength ?? 3).padStart(6, '0')}</doma:length><doma:style>${o.style ?? '00'}</doma:style>` +
    (o.conversionExit ? `<doma:conversionExit>${o.conversionExit}</doma:conversionExit>` : '<doma:conversionExit/>') +
    `<doma:signExists>false</doma:signExists><doma:lowercase>${o.lowercase ?? false}</doma:lowercase><doma:ampmFormat>false</doma:ampmFormat></doma:outputInformation>` +
    '<doma:valueInformation>' +
    (o.valueTable ? `<doma:valueTableRef adtcore:uri="/sap/bc/adt/ddic/tables/x" adtcore:type="TABL/DT" adtcore:name="${o.valueTable}"/>` : '<doma:valueTableRef/>') +
    `<doma:appendExists>${o.appendExists ?? false}</doma:appendExists><doma:fixValues>` +
    values
      .map(
        (v, i) =>
          `<doma:fixValue><doma:position>${String(i + 1).padStart(4, '0')}</doma:position><doma:low>${v.low}</doma:low>` +
          (v.high ? `<doma:high>${v.high}</doma:high>` : '<doma:high/>') +
          `<doma:text>${v.text}</doma:text>` +
          (v.append ? `<doma:contributingAppendRef adtcore:name="${v.append}"/>` : '') +
          '</doma:fixValue>',
      )
      .join('') +
    '</doma:fixValues></doma:valueInformation></doma:content></doma:domain>'
  );
}

const URI = '/sap/bc/adt/ddic/domains/zadtplus_dom';
const LOCK = '<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>DEVK900001</CORRNR></DATA></asx:values></asx:abap>';

/** A domain that reads as `before` until a PUT, then as what the PUT sent (SAP stores what it gets); a DELETE removes it. */
function domainOnSystem(before: string | undefined, packageLanguageVersion = '') {
  let current = before;
  return routedRest(({ method, path, opts }) => {
    if (path === '/sap/bc/adt/packages/zpkg' && method === 'GET') return { body: packageBody('ZPKG', { languageVersion: packageLanguageVersion }) };
    if (path === URI && method === 'GET') return current ? { body: current } : { status: 404 };
    if (path === URI && method === 'POST' && opts.query?._action === 'LOCK') return { body: LOCK };
    if (path === URI && method === 'POST' && opts.query?._action === 'UNLOCK') return { status: 200 };
    if (path === URI && method === 'PUT') {
      current = opts.body!.replace('adtcore:type="DOMA/DD"', 'adtcore:type="DOMA/DD" adtcore:version="inactive"');
      return { status: 200 };
    }
    if (path === URI && method === 'DELETE') {
      current = undefined;
      return { status: 200 };
    }
    if (path === '/sap/bc/adt/ddic/domains/validation') return { status: 200 };
    if (path === '/sap/bc/adt/ddic/domains' && method === 'POST') {
      current = opts.body!.replace('adtcore:type="DOMA/DD"', 'adtcore:type="DOMA/DD" adtcore:version="new"');
      return { status: 201 };
    }
    return undefined;
  });
}

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  user: 'DEVELOPER',
  extraCaCerts: [],
  writeAllowlist: ['ZPKG'],
};

const noChain = async (): Promise<string[]> => {
  throw new Error('no chain lookup expected');
};

describe('domain XML', () => {
  it('names DOMA and DOMA/DD as domains', () => {
    expect(formType('DOMA')).toBe(DOMAIN.type);
    expect(formType('doma/dd')).toBe(DOMAIN.type);
    expect(formType('DOMA/D')).toBe(DOMAIN.type);
    expect(formType('DTEL/DE')).not.toBe(DOMAIN.type);
  });

  it('parses type, output, value table and fixed values; padded numbers read as numbers', () => {
    const d = parseDomainXml(domainXml({ conversionExit: 'MATN1', valueTable: 'MARA', style: '02', lowercase: true }));
    expect(d).toEqual({
      name: 'ZADTPLUS_DOM',
      description: 'Demo',
      package: 'ZPKG',
      masterLanguage: 'EN',
      abapLanguageVersion: 'standard',
      version: 'active',
      dataType: 'CHAR',
      length: 3,
      decimals: 0,
      outputLength: 3,
      style: '02',
      conversionExit: 'MATN1',
      signExists: false,
      lowercase: true,
      ampmFormat: false,
      valueTable: 'MARA',
      appendExists: false,
      fixedValues: [
        { low: 'A', high: '', text: 'Alpha' },
        { low: 'X10', high: 'X19', text: 'Range & more' },
      ],
    });
  });

  it('builds a body that parses back to the same domain, positions renumbered and text escaped', () => {
    const d = parseDomainXml(domainXml());
    const xml = buildDomainXml(d);
    expect(xml).toContain('<doma:position>2</doma:position>');
    expect(xml).toContain('Range &amp; more');
    expect(xml).not.toContain('abapLanguageVersion');
    expect(parseDomainXml(xml)).toEqual({ ...d, version: '' });
  });

  it('sends the ABAP language version only on a create, and only when not standard', () => {
    const d = { ...parseDomainXml(domainXml()), abapLanguageVersion: 'cloudDevelopment' };
    expect(buildDomainXml(d, { create: true })).toContain('adtcore:abapLanguageVersion="cloudDevelopment"');
    expect(buildDomainXml(d)).not.toContain('abapLanguageVersion');
  });
});

describe('domain properties (AFF doma-v1)', () => {
  it('renders fixed values and intervals apart, off and empty fields left out', () => {
    expect(domainProperties(parseDomainXml(domainXml({ style: '06', valueTable: 'T001' })))).toEqual({
      formatVersion: '1',
      header: { description: 'Demo', originalLanguage: 'en' },
      format: { dataType: 'CHAR', length: 3 },
      outputCharacteristics: { length: 3, style: 'engineering' },
      fixedValues: [{ fixedValue: 'A', description: 'Alpha' }],
      fixedValueIntervals: [{ lowLimit: 'X10', highLimit: 'X19', description: 'Range & more' }],
      valueTable: { name: 'T001' },
    });
  });

  it('lists values an append contributes as its append, not as the domain\'s', () => {
    const d = parseDomainXml(domainXml({ fixedValues: [{ low: 'A', high: '', text: 'Alpha' }, { low: 'Z', high: '', text: 'Zed', append: 'ZAPP' }] }));
    const p = domainProperties(d);
    expect(p.fixedValues).toEqual([{ fixedValue: 'A', description: 'Alpha' }]);
    expect(p.fixedValueAppends).toEqual([{ name: 'ZAPP' }]);
  });

  it('a create needs format.dataType and format.length, and takes no header', () => {
    expect(() => domainCreate(undefined)).toThrow(/needs "properties"/);
    expect(() => domainCreate({ format: { dataType: 'CHAR' } })).toThrow(/format.dataType and format.length/);
    expect(() => domainCreate({ header: { description: 'x' }, format: { dataType: 'CHAR', length: 1 } })).toThrow(/header/);
    expect(domainCreate({ format: { dataType: 'DEC', length: 10, decimals: 2 }, outputCharacteristics: { style: 'signRight' } })).toMatchObject({
      dataType: 'DEC',
      length: 10,
      decimals: 2,
      outputLength: 0,
      style: '01',
      fixedValues: [],
    });
  });

  it('an update merges by key, but a fixed value list sent is the new list; the other list stays', () => {
    const current = parseDomainXml(domainXml());
    const next = domainUpdate({ header: { description: 'New' }, fixedValues: [{ fixedValue: 'C', description: 'Gamma' }] })(current);
    expect(next.description).toBe('New');
    expect(next.dataType).toBe('CHAR');
    expect(next.fixedValues).toEqual([
      { low: 'C', high: '', text: 'Gamma' },
      { low: 'X10', high: 'X19', text: 'Range & more' },
    ]);
    expect(domainUpdate({ fixedValueIntervals: [] })(current).fixedValues).toEqual([{ low: 'A', high: '', text: 'Alpha' }]);
    expect(domainUpdate({ valueTable: { name: '' } })({ ...current, valueTable: 'T001' }).valueTable).toBe('');
  });

  it('stores values as SAP does: upper case unless case-sensitive, the conversion routine always', () => {
    const current = parseDomainXml(domainXml());
    const next = domainUpdate({ outputCharacteristics: { conversionRoutine: 'alpha' }, fixedValues: [{ fixedValue: 'b', description: 'x' }] })(current);
    expect(next.conversionExit).toBe('ALPHA');
    expect(next.fixedValues[0]).toEqual({ low: 'B', high: '', text: 'x' });
    expect(domainUpdate({ outputCharacteristics: { caseSensitive: true }, fixedValues: [{ fixedValue: 'b' }] })(current).fixedValues[0]!.low).toBe('b');
  });

  it('lets the activation compute the output length again when the type changes', () => {
    const current = parseDomainXml(domainXml({ length: 2, outputLength: 2 }));
    expect(domainUpdate({ format: { length: 10 } })(current).outputLength).toBe(0);
    expect(domainUpdate({ format: { length: 10 }, outputCharacteristics: { length: 12 } })(current).outputLength).toBe(12);
    expect(domainUpdate({ format: { length: 2 } })(current).outputLength).toBe(2);
    expect(domainUpdate({ header: { description: 'x' } })(current).outputLength).toBe(2);
  });

  it('refuses an interval without its highLimit before any call', () => {
    expect(() => domainUpdate({ fixedValueIntervals: [{ lowLimit: 'A' }] })(parseDomainXml(domainXml()))).toThrow(/highLimit/);
    expect(() => domainCreate({ format: { dataType: 'CHAR', length: 1 }, fixedValueIntervals: [{ lowLimit: 'A' }] })).toThrow(/highLimit/);
  });

  it('refuses what an update can\'t change, an empty update, and a value given twice', () => {
    const current = parseDomainXml(domainXml());
    expect(() => domainUpdate({ header: { originalLanguage: 'de' } })).toThrow(/header.originalLanguage/);
    expect(() => domainUpdate({ fixedValueAppends: [{ name: 'ZAPP' }] })).toThrow(/appends/);
    expect(() => domainUpdate({})).toThrow(/needs at least one/);
    expect(() => domainUpdate({ fixedValues: [{ fixedValue: 'A' }, { fixedValue: 'a' }] })(current)).toThrow(/A is given twice/);
  });
});

// Also the one test of the shared REST form-object path (rest-form-object.ts) for every type.
describe('domain REST fallback', () => {
  it('creates in the logon language after SAP\'s name check, and reads it back', async () => {
    const rest = domainOnSystem(undefined);
    const content = domainCreate({ format: { dataType: 'CHAR', length: 2 }, fixedValues: [{ fixedValue: 'A', description: 'Alpha' }] });
    const res = await createFormObject(DOMAIN, rest, onprem, { name: 'zadtplus_dom', packageName: 'zpkg', description: 'Demo', content, transport: 'DEVK900001' }, noChain);
    expect(res.object).toMatchObject({ name: 'ZADTPLUS_DOM', package: 'ZPKG', version: 'new', masterLanguage: 'EN' });
    expect(res).toMatchObject({ transport: 'DEVK900001', via: 'rest-fallback', nativeAvailable: null });
    const post = rest.calls.find((c) => c.method === 'POST' && c.path === '/sap/bc/adt/ddic/domains')!;
    expect(post.opts.query).toEqual({ corrNr: 'DEVK900001' });
    expect(post.opts.body).toContain('adtcore:masterLanguage="EN"');
  });

  it("gives a new object its package's default language version, on a cloud system cloudDevelopment", async () => {
    const content = domainCreate({ format: { dataType: 'CHAR', length: 2 } });
    const input = { name: 'ZADTPLUS_DOM', packageName: 'ZPKG', description: 'Demo', content, transport: 'DEVK900001' };
    const post = (rest: ReturnType<typeof domainOnSystem>) => rest.calls.find((c) => c.method === 'POST' && c.path === '/sap/bc/adt/ddic/domains')!;
    const inCloudPackage = domainOnSystem(undefined, '5');
    await createFormObject(DOMAIN, inCloudPackage, onprem, input, noChain);
    expect(post(inCloudPackage).opts.body).toContain('adtcore:abapLanguageVersion="cloudDevelopment"');
    const onCloud = domainOnSystem(undefined);
    await createFormObject(DOMAIN, onCloud, { ...onprem, kind: 'cloud' }, input, noChain);
    expect(post(onCloud).opts.body).toContain('adtcore:abapLanguageVersion="cloudDevelopment"');
    expect(onCloud.calls.some((c) => c.path === '/sap/bc/adt/packages/zpkg')).toBe(false);
  });

  it('refuses a create outside the allowlist before any call', async () => {
    const rest = domainOnSystem(undefined);
    const content = domainCreate({ format: { dataType: 'CHAR', length: 2 } });
    await expect(createFormObject(DOMAIN, rest, onprem, { name: 'ZADTPLUS_DOM', packageName: 'ZOTHER', description: 'x', content }, noChain)).rejects.toThrow(/write allowlist/);
    expect(rest.calls).toEqual([]);
  });

  it('updates under a lock with the whole domain, and returns the one before', async () => {
    const rest = domainOnSystem(domainXml());
    const res = await updateFormObject(DOMAIN, rest, onprem, { name: 'ZADTPLUS_DOM', change: domainUpdate({ fixedValues: [] }) }, noChain);
    expect(rest.calls.map((c) => `${c.method} ${c.opts.query?._action ?? ''}`)).toEqual(['GET ', 'POST LOCK', 'PUT ', 'POST UNLOCK', 'GET ']);
    expect(res.object.fixedValues).toEqual([{ low: 'X10', high: 'X19', text: 'Range & more' }]);
    expect(res.previous.fixedValues).toHaveLength(2);
    expect(res.transport).toBe('DEVK900001');
  });

  it('refuses an update of a domain outside the allowlist after the read, before the lock', async () => {
    const rest = domainOnSystem(domainXml({ package: 'ZOTHER' }));
    await expect(updateFormObject(DOMAIN, rest, onprem, { name: 'ZADTPLUS_DOM', change: domainUpdate({ header: { description: 'x' } }) }, noChain)).rejects.toThrow(/write allowlist/);
    expect(rest.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('refuses an update of a domain with fixed value appends: the PUT would replace them', async () => {
    const rest = domainOnSystem(domainXml({ appendExists: true }));
    await expect(updateFormObject(DOMAIN, rest, onprem, { name: 'ZADTPLUS_DOM', change: domainUpdate({ header: { description: 'x' } }) }, noChain)).rejects.toThrow(/fixed value appends/);
    expect(rest.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('fails when the read-back differs from what was sent', async () => {
    const rest = routedRest(({ method, opts }) => {
      if (method === 'GET') return { body: domainXml() };
      if (opts.query?._action === 'LOCK') return { body: LOCK };
      return { status: 200 };
    });
    await expect(updateFormObject(DOMAIN, rest, onprem, { name: 'ZADTPLUS_DOM', change: domainUpdate({ header: { description: 'New' } }) }, noChain)).rejects.toThrow(
      /update returned OK but description not as sent/,
    );
  });

  it('deletes only with confirm, and checks it is gone', async () => {
    await expect(deleteFormObject(DOMAIN, domainOnSystem(domainXml()), onprem, { name: 'ZADTPLUS_DOM' }, noChain)).rejects.toThrow(/confirm/);
    const rest = domainOnSystem(domainXml());
    expect(await deleteFormObject(DOMAIN, rest, onprem, { name: 'ZADTPLUS_DOM', confirm: true }, noChain)).toMatchObject({ name: 'ZADTPLUS_DOM', deleted: true });
  });

  it('gates every domain of an activation before activating, then reports SAP\'s messages per object', async () => {
    const outside = domainOnSystem(domainXml({ package: 'ZOTHER' }));
    await expect(gateFormObjects(DOMAIN, outside, onprem, ['ZADTPLUS_DOM'], noChain)).rejects.toThrow(/write allowlist/);
    expect(outside.calls.every((c) => c.method === 'GET')).toBe(true);

    const answer =
      '<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">' +
      '<chkl:properties checkExecuted="true" activationExecuted="false" generationExecuted="false"/>' +
      '<msg objDescr="" type="E" line="0" href=""><shortText><txt>Activation was cancelled.</txt><txt>"DOMA ZADTPLUS_DOM was not activated" (D0 408)</txt></shortText></msg>' +
      '<msg objDescr="DOMA ZADTPLUS_DOM" type="E" line="1" href="/sap/bc/adt/ddic/domains/zadtplus_dom"><shortText><txt>Data type &apos; &apos; does not exist</txt></shortText></msg>' +
      '<msg objDescr="DOMA ZADTPLUS_DOM" type="W" line="1" href="/sap/bc/adt/ddic/domains/zadtplus_dom"><shortText><txt>Value table X does not exist</txt></shortText></msg>' +
      '</chkl:messages>';
    const rest = routedRest(({ method, path }) => {
      if (method === 'GET' && path === URI) return { body: domainXml() };
      if (method === 'POST' && path === '/sap/bc/adt/activation') return { body: answer };
      return undefined;
    });
    const result = await activateRest(rest, await gateFormObjects(DOMAIN, rest, onprem, ['zadtplus_dom'], noChain));
    const post = rest.calls.find((c) => c.path === '/sap/bc/adt/activation')!;
    expect(post.opts.body).toContain('adtcore:uri="/sap/bc/adt/ddic/domains/zadtplus_dom" adtcore:name="ZADTPLUS_DOM"');
    expect(result).toEqual({
      checkExecuted: true,
      activationExecuted: false,
      generationExecuted: false,
      refreshedUris: [],
      diagnostics: [
        { uri: null, object: '', diagnostic: [{ severity: 1, source: 'abapActivation', message: 'Activation was cancelled. "DOMA ZADTPLUS_DOM was not activated" (D0 408)' }] },
        {
          uri: '/sap/bc/adt/ddic/domains/zadtplus_dom',
          object: 'DOMA ZADTPLUS_DOM',
          diagnostic: [
            { severity: 1, source: 'abapActivation', message: "Data type ' ' does not exist" },
            { severity: 2, source: 'abapActivation', message: 'Value table X does not exist' },
          ],
        },
      ],
    });
  });

  it('takes an activation answer without a result as an error, not as nothing to report', () => {
    expect(() => parseActivationXml('<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects"/>')).toThrow(/without an activation result/);
  });
});
