import { describe, expect, it } from 'vitest';
import {
  buildDataElementXml,
  DATA_ELEMENT,
  parseDataElementXml,
} from '../../src/capabilities/dataelement.js';
import { createFormObject, gateFormObjects, updateFormObject } from '../../src/capabilities/rest-form-object.js';
import { formType, checkProperties, dataElementCreate, dataElementProperties, dataElementUpdate } from '../../src/capabilities/properties.js';
import { activateRest } from '../../src/capabilities/rest-activation.js';
import type { Destination } from '../../src/core/destinations.js';
import { routedRest } from '../helpers/rest.js';

// Trimmed from the live ONPREM GETs of MATNR and ZADTPLUS_DE_PROBE.
interface Fixture {
  name?: string;
  package?: string;
  version?: string;
  description?: string;
  typeKind?: string;
  typeName?: string;
  dataType?: string;
  length?: number;
  short?: string;
  shortLength?: number;
  searchHelp?: string;
  searchHelpParameter?: string;
  leftToRightDirection?: boolean;
}

function dataElementXml(o: Fixture = {}): string {
  const tag = (name: string, value: string) => (value ? `<dtel:${name}>${value}</dtel:${name}>` : `<dtel:${name}/>`);
  return (
    '<?xml version="1.0" encoding="utf-8"?><blue:wbobj adtcore:responsible="DEVELOPER" adtcore:masterLanguage="EN" adtcore:masterSystem="DEV" ' +
    `adtcore:abapLanguageVersion="standard" adtcore:name="${o.name ?? 'ZADTPLUS_DE'}" adtcore:type="DTEL/DE" adtcore:version="${o.version ?? 'active'}" ` +
    `adtcore:description="${o.description ?? 'Demo &amp; more'}" adtcore:language="EN" ` +
    'xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<atom:link href="versions" rel="http://www.sap.com/adt/relations/versions" title="Historic versions" xmlns:atom="http://www.w3.org/2005/Atom"/>' +
    `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/zpkg" adtcore:type="DEVC/K" adtcore:name="${o.package ?? 'ZPKG'}" adtcore:description="Package"/>` +
    '<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">' +
    tag('typeKind', o.typeKind ?? 'domain') +
    tag('typeName', o.typeName ?? 'ZADTPLUS_DOM') +
    tag('dataType', o.dataType ?? 'NUMC') +
    `<dtel:dataTypeLength>${String(o.length ?? 8).padStart(6, '0')}</dtel:dataTypeLength><dtel:dataTypeDecimals>000000</dtel:dataTypeDecimals>` +
    `<dtel:shortFieldLabel>${o.short ?? 'Short'}</dtel:shortFieldLabel><dtel:shortFieldLength>${o.shortLength ?? 10}</dtel:shortFieldLength><dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>` +
    '<dtel:mediumFieldLabel>Medium</dtel:mediumFieldLabel><dtel:mediumFieldLength>15</dtel:mediumFieldLength><dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>' +
    '<dtel:longFieldLabel>Long label</dtel:longFieldLabel><dtel:longFieldLength>20</dtel:longFieldLength><dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>' +
    '<dtel:headingFieldLabel>Heading</dtel:headingFieldLabel><dtel:headingFieldLength>12</dtel:headingFieldLength><dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>' +
    tag('searchHelp', o.searchHelp ?? '') +
    tag('searchHelpParameter', o.searchHelpParameter ?? '') +
    '<dtel:setGetParameter/><dtel:defaultComponentName>PROBE</dtel:defaultComponentName>' +
    '<dtel:deactivateInputHistory>false</dtel:deactivateInputHistory><dtel:changeDocument>true</dtel:changeDocument>' +
    `<dtel:leftToRightDirection>${o.leftToRightDirection ?? false}</dtel:leftToRightDirection><dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering>` +
    '</dtel:dataElement></blue:wbobj>'
  );
}

const URI = '/sap/bc/adt/ddic/dataelements/zadtplus_de';
const LOCK = '<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>DEVK900001</CORRNR></DATA></asx:values></asx:abap>';

/** A data element that reads as `before` until a write, then as what it sent (SAP stores what it gets); a DELETE removes it. */
function dataElementOnSystem(before: string | undefined) {
  let current = before;
  return routedRest(({ method, path, opts }) => {
    if (path === URI && method === 'GET') return current ? { body: current } : { status: 404 };
    if (path === URI && method === 'POST' && opts.query?._action === 'LOCK') return { body: LOCK };
    if (path === URI && method === 'POST' && opts.query?._action === 'UNLOCK') return { status: 200 };
    if (path === URI && method === 'PUT') {
      current = opts.body!.replace('adtcore:type="DTEL/DE"', 'adtcore:type="DTEL/DE" adtcore:version="inactive"');
      return { status: 200 };
    }
    if (path === URI && method === 'DELETE') {
      current = undefined;
      return { status: 200 };
    }
    if (path === '/sap/bc/adt/ddic/dataelements/validation') return { status: 200 };
    if (path === '/sap/bc/adt/ddic/dataelements' && method === 'POST') {
      current = opts.body!.replace('adtcore:type="DTEL/DE"', 'adtcore:type="DTEL/DE" adtcore:version="new"');
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

describe('data element XML', () => {
  it('names DTEL and DTEL/DE as data elements', () => {
    expect(formType('DTEL/DE')).toBe(DATA_ELEMENT.type);
    expect(formType('dtel')).toBe(DATA_ELEMENT.type);
    expect(formType('DOMA/DD')).not.toBe(DATA_ELEMENT.type);
  });

  it('parses type, labels and additional properties; padded numbers read as numbers', () => {
    const d = parseDataElementXml(dataElementXml({ searchHelp: 'S_MAT1', searchHelpParameter: 'MATNR' }));
    expect(d).toMatchObject({
      name: 'ZADTPLUS_DE',
      description: 'Demo & more',
      package: 'ZPKG',
      masterLanguage: 'EN',
      version: 'active',
      typeKind: 'domain',
      typeName: 'ZADTPLUS_DOM',
      dataType: 'NUMC',
      length: 8,
      decimals: 0,
      labels: { short: { text: 'Short', length: 10 }, medium: { text: 'Medium', length: 15 }, long: { text: 'Long label', length: 20 }, heading: { text: 'Heading', length: 12 } },
      searchHelp: 'S_MAT1',
      searchHelpParameter: 'MATNR',
      defaultComponentName: 'PROBE',
      changeDocument: true,
      leftToRightDirection: false,
    });
  });

  it('builds a body that parses back the same, with every label\'s maximum length and a domain\'s type left to the activation', () => {
    const d = parseDataElementXml(dataElementXml());
    const xml = buildDataElementXml(d);
    for (const max of ['<dtel:shortFieldMaxLength>10<', '<dtel:mediumFieldMaxLength>20<', '<dtel:longFieldMaxLength>40<', '<dtel:headingFieldMaxLength>55<']) {
      expect(xml).toContain(max);
    }
    expect(xml).toContain('<dtel:dataType></dtel:dataType><dtel:dataTypeLength>0</dtel:dataTypeLength>');
    expect(parseDataElementXml(xml)).toEqual({ ...d, version: '', dataType: '', length: 0 });
    const predefined = { ...d, typeKind: 'predefinedAbapType', typeName: '', dataType: 'CHAR', length: 12 };
    expect(parseDataElementXml(buildDataElementXml(predefined))).toEqual({ ...predefined, version: '' });
  });

  it('sends the ABAP language version only on a create, and only when not standard', () => {
    const d = { ...parseDataElementXml(dataElementXml()), abapLanguageVersion: 'cloudDevelopment' };
    expect(buildDataElementXml(d, { create: true })).toContain('adtcore:abapLanguageVersion="cloudDevelopment"');
    expect(buildDataElementXml(d)).not.toContain('abapLanguageVersion');
  });
});

describe('data element properties (AFF dtel-v1)', () => {
  it('renders a domain-based one by its domain only, off and empty fields left out', () => {
    const props = dataElementProperties(parseDataElementXml(dataElementXml()));
    expect(props).toEqual({
      formatVersion: '1',
      header: { description: 'Demo & more', originalLanguage: 'en' },
      dataTypeInformation: { category: 'domain', typeName: 'ZADTPLUS_DOM' },
      fieldLabels: { short: 'Short', shortLength: 10, medium: 'Medium', mediumLength: 15, long: 'Long label', longLength: 20, heading: 'Heading', headingLength: 12 },
      additionalProperties: { defaultComponentName: 'PROBE', changeDocumentRelevant: true },
    });
    expect(() => checkProperties('DTEL/DE', props)).not.toThrow();
  });

  it('renders a predefined type as predefinedType, and the set direction flag as AFF\'s rightToLeft', () => {
    const d = parseDataElementXml(
      dataElementXml({ typeKind: 'refToPredefinedAbapType', typeName: '', dataType: 'STRING', length: 0, leftToRightDirection: true, searchHelp: 'S_X', searchHelpParameter: 'P' }),
    );
    const props = dataElementProperties(d);
    expect(props.dataTypeInformation).toEqual({ category: 'referenceToPredefinedType', predefinedType: { dataType: 'STRING' } });
    expect(props.additionalProperties).toMatchObject({ searchHelp: { name: 'S_X', parameter: 'P' }, bidirectionalOptions: { basicDirection: 'rightToLeft' } });
    expect(() => checkProperties('DTEL/DE', props)).not.toThrow();
  });

  it('a create needs a category and its type; label lengths not given are the maxima; names upper case', () => {
    expect(() => dataElementCreate(undefined)).toThrow(/needs "properties"/);
    expect(() => dataElementCreate({ fieldLabels: { short: 'x' } })).toThrow(/needs dataTypeInformation.category/);
    expect(() => dataElementCreate({ header: { description: 'x' }, dataTypeInformation: { category: 'domain', typeName: 'X' } })).toThrow(/header/);
    expect(() => dataElementCreate({ dataTypeInformation: { category: 'domain' } })).toThrow(/needs dataTypeInformation.typeName/);
    expect(() => dataElementCreate({ dataTypeInformation: { category: 'predefinedType' } })).toThrow(/needs dataTypeInformation.predefinedType.dataType/);
    expect(() => dataElementCreate({ dataTypeInformation: { category: 'domain', typeName: 'X', predefinedType: { dataType: 'CHAR' } } })).toThrow(/names its type in typeName/);
    const content = dataElementCreate({
      dataTypeInformation: { category: 'domain', typeName: 'zadtplus_dom' },
      fieldLabels: { short: 'Short', shortLength: 5 },
      additionalProperties: { searchHelp: { name: 's_x', parameter: 'p' }, parameterId: 'mat', defaultComponentName: 'comp' },
    });
    expect(content).toMatchObject({
      typeKind: 'domain',
      typeName: 'ZADTPLUS_DOM',
      labels: { short: { text: 'Short', length: 5 }, medium: { text: '', length: 20 }, long: { text: '', length: 40 }, heading: { text: '', length: 55 } },
      searchHelp: 'S_X',
      searchHelpParameter: 'P',
      setGetParameter: 'MAT',
      defaultComponentName: 'COMP',
    });
  });

  it('an update merges by key; another category clears the old type', () => {
    const current = parseDataElementXml(dataElementXml());
    const relabeled = dataElementUpdate({ fieldLabels: { medium: 'New' } })(current);
    expect(relabeled.labels).toEqual({ ...current.labels, medium: { text: 'New', length: 15 } });
    expect(relabeled.typeName).toBe('ZADTPLUS_DOM');
    const predefined = dataElementUpdate({ dataTypeInformation: { category: 'predefinedType', predefinedType: { dataType: 'CHAR', length: 12 } } })(current);
    expect(predefined).toMatchObject({ typeKind: 'predefinedAbapType', typeName: '', dataType: 'CHAR', length: 12, decimals: 0 });
    expect(() => dataElementUpdate({ dataTypeInformation: { category: 'referenceDictionaryType' } })(current)).toThrow(/needs dataTypeInformation.typeName/);
    const longer = dataElementUpdate({ dataTypeInformation: { predefinedType: { length: 20 } } })(predefined);
    expect(longer).toMatchObject({ dataType: 'CHAR', length: 20 });
  });

  it('another data type starts from no length and decimals; a parameter without a search help is refused', () => {
    const dec = dataElementUpdate({ dataTypeInformation: { category: 'predefinedType', predefinedType: { dataType: 'DEC', length: 10, decimals: 2 } } })(
      parseDataElementXml(dataElementXml()),
    );
    expect(dataElementUpdate({ dataTypeInformation: { predefinedType: { dataType: 'INT4' } } })(dec)).toMatchObject({ dataType: 'INT4', length: 0, decimals: 0 });
    expect(dataElementUpdate({ dataTypeInformation: { predefinedType: { length: 12 } } })(dec)).toMatchObject({ dataType: 'DEC', length: 12, decimals: 2 });
    expect(() => dataElementUpdate({ additionalProperties: { searchHelp: { parameter: 'MATNR' } } })(dec)).toThrow(/needs a search help/);
  });

  it('drops a search help\'s parameter with the search help, and sets the direction both ways', () => {
    const current = parseDataElementXml(dataElementXml({ searchHelp: 'S_A', searchHelpParameter: 'P', leftToRightDirection: true }));
    expect(dataElementUpdate({ additionalProperties: { searchHelp: { name: 'S_B' } } })(current)).toMatchObject({ searchHelp: 'S_B', searchHelpParameter: '' });
    expect(dataElementUpdate({ additionalProperties: { searchHelp: { name: '' } } })(current)).toMatchObject({ searchHelp: '', searchHelpParameter: '' });
    expect(dataElementUpdate({ additionalProperties: { searchHelp: { name: 's_a' } } })(current)).toMatchObject({ searchHelp: 'S_A', searchHelpParameter: 'P' });
    const ltr = dataElementUpdate({ additionalProperties: { bidirectionalOptions: { basicDirection: 'leftToRight' } } })(current);
    expect(ltr.leftToRightDirection).toBe(false);
  });

  it('refuses what an update can\'t change and an empty update', () => {
    expect(() => dataElementUpdate({ header: { originalLanguage: 'de' } })).toThrow(/header.originalLanguage/);
    expect(() => dataElementUpdate({})).toThrow(/needs at least one/);
    expect(() => checkProperties('DTEL/DE', { fieldLabels: { short: 'x', foo: 1 } })).toThrow(/fieldLabels has "foo"/);
  });
});

// The shared create/update/delete/gate path (rest-form-object.ts) is tested once, in domain.test.ts.
describe('data element REST fallback', () => {
  it('sets label lengths other than the maxima by a PUT after the create, which gives every label its maximum', async () => {
    let current: string | undefined;
    const rest = routedRest(({ method, path, opts }) => {
      if (path === '/sap/bc/adt/ddic/dataelements/validation') return { status: 200 };
      if (path === '/sap/bc/adt/ddic/dataelements' && method === 'POST') {
        current = opts.body!.replace(/<dtel:(\w+)FieldLength>\d+</g, (_, k: string) => `<dtel:${k}FieldLength>${{ short: 10, medium: 20, long: 40, heading: 55 }[k]}<`);
        return { status: 201 };
      }
      if (path === URI && method === 'GET') return { body: current };
      if (opts.query?._action === 'LOCK') return { body: LOCK };
      if (path === URI && method === 'PUT') current = opts.body;
      return { status: 200 };
    });
    const content = dataElementCreate({ dataTypeInformation: { category: 'domain', typeName: 'ZADTPLUS_DOM' }, fieldLabels: { medium: 'Medium', mediumLength: 15 } });
    const res = await createFormObject(DATA_ELEMENT, rest, onprem, { name: 'ZADTPLUS_DE', packageName: 'ZPKG', description: 'Demo', content, transport: 'DEVK900001' }, noChain);
    expect(res.object.labels.medium).toEqual({ text: 'Medium', length: 15 });
    expect(rest.calls.map((c) => `${c.method} ${c.opts.query?._action ?? ''}`)).toEqual([
      'POST ',
      'POST ',
      'GET ',
      'POST LOCK',
      'PUT ',
      'POST UNLOCK',
      'GET ',
    ]);
  });

  it('refuses a create outside the allowlist, or with a label longer than its length, before any call', async () => {
    const rest = dataElementOnSystem(undefined);
    const content = dataElementCreate({ dataTypeInformation: { category: 'domain', typeName: 'ZADTPLUS_DOM' } });
    await expect(createFormObject(DATA_ELEMENT, rest, onprem, { name: 'ZADTPLUS_DE', packageName: 'ZOTHER', description: 'x', content }, noChain)).rejects.toThrow(/write allowlist/);
    const long = dataElementCreate({ dataTypeInformation: { category: 'domain', typeName: 'ZADTPLUS_DOM' }, fieldLabels: { medium: 'Medium lbl', mediumLength: 5 } });
    await expect(createFormObject(DATA_ELEMENT, rest, onprem, { name: 'ZADTPLUS_DE', packageName: 'ZPKG', description: 'x', content: long }, noChain)).rejects.toThrow(
      /fieldLabels.medium has 10 characters, more than its length 5/,
    );
    expect(rest.calls).toEqual([]);
  });

  it('updates the whole data element: a merged label reads back in the inactive version, the one before is returned', async () => {
    const rest = dataElementOnSystem(dataElementXml());
    const res = await updateFormObject(DATA_ELEMENT, rest, onprem, { name: 'ZADTPLUS_DE', change: dataElementUpdate({ fieldLabels: { short: 'New' } }) }, noChain);
    expect(res.object).toMatchObject({ version: 'inactive', labels: { short: { text: 'New', length: 10 } } });
    expect(res.previous.labels.short.text).toBe('Short');
  });

  it('checks only the labels an update changes: one already stored too long doesn\'t block it', async () => {
    const stored = dataElementXml({ short: 'Too long a', shortLength: 5 });
    await expect(updateFormObject(DATA_ELEMENT, dataElementOnSystem(stored), onprem, { name: 'ZADTPLUS_DE', change: dataElementUpdate({ header: { description: 'x' } }) }, noChain)).resolves.toBeDefined();
    await expect(
      updateFormObject(DATA_ELEMENT, dataElementOnSystem(stored), onprem, { name: 'ZADTPLUS_DE', change: dataElementUpdate({ fieldLabels: { short: 'Still long' } }) }, noChain),
    ).rejects.toThrow(/fieldLabels.short has 10 characters/);
  });

  it('reads each object\'s version after the activation: SAP answers "executed" for a cancelled one', async () => {
    const answer =
      '<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><chkl:properties checkExecuted="true" activationExecuted="true" generationExecuted="false"/>' +
      '<msg objDescr="" type="W" line="0" href=""><shortText><txt>Activation was cancelled.</txt></shortText></msg>' +
      '<msg objDescr="DTEL ZADTPLUS_DE" type="E" line="1" href="/sap/bc/adt/ddic/dataelements/zadtplus_de"><shortText><txt>Medium key word in language EN: length 10 &gt; maximum length 5</txt></shortText></msg>' +
      '</chkl:messages>';
    const onSystem = (version: string) =>
      routedRest(({ method, path }) => {
        if (method === 'GET' && path === URI) return { body: dataElementXml({ version }) };
        if (method === 'POST' && path === '/sap/bc/adt/activation') return { body: answer };
        return undefined;
      });
    const cancelled = onSystem('inactive');
    const result = await activateRest(cancelled, await gateFormObjects(DATA_ELEMENT, cancelled, onprem, ['ZADTPLUS_DE'], noChain));
    expect(result.activationExecuted).toBe(false);
    expect(result.diagnostics).toContainEqual({
      uri: URI,
      object: 'DTEL ZADTPLUS_DE',
      diagnostic: [
        { severity: 1, source: 'abapActivation', message: 'Medium key word in language EN: length 10 > maximum length 5' },
        { severity: 1, source: 'abapActivation', message: 'DTEL ZADTPLUS_DE is not active after the activation' },
      ],
    });
    // Active despite an error ("became active despite inconsistent references"): activated.
    const active = onSystem('active');
    expect((await activateRest(active, await gateFormObjects(DATA_ELEMENT, active, onprem, ['ZADTPLUS_DE'], noChain))).activationExecuted).toBe(true);
  });

  it('keeps SAP\'s answer when a version read after the activation fails, with a warning', async () => {
    let reads = 0;
    const rest = routedRest(({ method, path }) => {
      if (method === 'GET' && path === URI) return ++reads === 1 ? { body: dataElementXml() } : { status: 500, body: 'boom' };
      if (method === 'POST' && path === '/sap/bc/adt/activation') {
        return { body: '<chkl:messages xmlns:chkl="x"><chkl:properties checkExecuted="true" activationExecuted="true" generationExecuted="false"/></chkl:messages>' };
      }
      return undefined;
    });
    const result = await activateRest(rest, await gateFormObjects(DATA_ELEMENT, rest, onprem, ['ZADTPLUS_DE'], noChain));
    expect(result.activationExecuted).toBe(true);
    expect(JSON.stringify(result.diagnostics)).toContain('its version could not be read after the activation');
  });
});
