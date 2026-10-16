import { decodeXml, escapeXml, startTags, xmlAttr } from '../backends/rawadt.js';
import type { FormObject, FormObjectContent, FormObjectKind } from './rest-form-object.js';

// --- REST fallback ---------------------------------------------------------
//
// adt-ls 1.1.2 serves a domain as a placeholder, has no creation adapter for it, and its
// activation answers "Internal error.". The
// lifecycle is every form-based object's (rest-form-object.ts) under /sap/bc/adt/ddic/domains.
// A PUT replaces the whole domain: a fixed value the document leaves out is gone. SAP stores what
// a PUT sends, a data type it doesn't know too, and refuses it only at activation; AFF's schema
// refuses it here first.

/** A fixed value (no `high`) or an interval (with one). */
export interface FixedValue {
  low: string;
  high: string;
  text: string;
  /** The fixed value append that contributes it; such values belong to the append, not the domain. */
  append?: string;
}

export interface Domain extends FormObject {
  dataType: string;
  length: number;
  decimals: number;
  /** 0 lets the activation compute it. */
  outputLength: number;
  /** DD01L-OUTPUTSTYLE, `00`–`06`. */
  style: string;
  conversionExit: string;
  signExists: boolean;
  lowercase: boolean;
  ampmFormat: boolean;
  valueTable: string;
  /** Fixed value appends extend the domain. */
  appendExists: boolean;
  fixedValues: FixedValue[];
}

/** The text of `<doma:name>` in `xml` (its first one), `''` for an empty element. */
function element(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<doma:${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</doma:${name}>)`));
  return m?.[1] === undefined ? '' : decodeXml(m[1]);
}

/** The part of `xml` from `<doma:name` to its end tag. */
function section(xml: string, name: string): string {
  return xml.match(new RegExp(`<doma:${name}\\b[\\s\\S]*?</doma:${name}>`))?.[0] ?? '';
}

const number = (text: string) => (text.trim() === '' ? 0 : Number.parseInt(text, 10));

export function parseDomainXml(xml: string): Domain {
  const head = xml.match(startTags('doma:domain'))?.[0];
  const name = head && xmlAttr(head, 'adtcore:name');
  if (!head || !name) throw new Error('not a doma:domain representation');
  const packageRef = xml.match(startTags('adtcore:packageRef'))?.[0] ?? '';
  const type = section(xml, 'typeInformation');
  const output = section(xml, 'outputInformation');
  const values = section(xml, 'valueInformation');
  const valueTableRef = values.match(startTags('doma:valueTableRef'))?.[0] ?? '';
  const fixedValues = [...values.matchAll(/<doma:fixValue>([\s\S]*?)<\/doma:fixValue>/g)].map(([, v = '']) => {
    const appendRef = v.match(startTags('doma:contributingAppendRef'))?.[0];
    const append = appendRef && xmlAttr(appendRef, 'adtcore:name');
    return { low: element(v, 'low'), high: element(v, 'high'), text: element(v, 'text'), ...(append ? { append } : {}) };
  });
  return {
    name,
    description: xmlAttr(head, 'adtcore:description') ?? '',
    package: xmlAttr(packageRef, 'adtcore:name') ?? '',
    masterLanguage: xmlAttr(head, 'adtcore:masterLanguage') ?? '',
    abapLanguageVersion: xmlAttr(head, 'adtcore:abapLanguageVersion') || 'standard',
    version: xmlAttr(head, 'adtcore:version') ?? '',
    dataType: element(type, 'datatype'),
    length: number(element(type, 'length')),
    decimals: number(element(type, 'decimals')),
    outputLength: number(element(output, 'length')),
    style: element(output, 'style') || '00',
    conversionExit: element(output, 'conversionExit'),
    signExists: element(output, 'signExists') === 'true',
    lowercase: element(output, 'lowercase') === 'true',
    ampmFormat: element(output, 'ampmFormat') === 'true',
    valueTable: xmlAttr(valueTableRef, 'adtcore:name') ?? '',
    appendExists: element(values, 'appendExists') === 'true',
    fixedValues,
  };
}

export function buildDomainXml(d: Domain, options: { create?: boolean } = {}): string {
  const e = escapeXml;
  const flag = (b: boolean) => (b ? 'true' : 'false');
  const languageVersion = options.create && d.abapLanguageVersion !== 'standard' ? ` adtcore:abapLanguageVersion="${e(d.abapLanguageVersion)}"` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core"' +
    ` adtcore:name="${e(d.name)}" adtcore:type="DOMA/DD" adtcore:description="${e(d.description)}"` +
    ` adtcore:masterLanguage="${e(d.masterLanguage)}" adtcore:language="${e(d.masterLanguage)}"${languageVersion}>` +
    `<adtcore:packageRef adtcore:name="${e(d.package)}"/>` +
    '<doma:content>' +
    `<doma:typeInformation><doma:datatype>${e(d.dataType)}</doma:datatype><doma:length>${d.length}</doma:length>` +
    `<doma:decimals>${d.decimals}</doma:decimals></doma:typeInformation>` +
    `<doma:outputInformation><doma:length>${d.outputLength}</doma:length><doma:style>${e(d.style)}</doma:style>` +
    `<doma:conversionExit>${e(d.conversionExit)}</doma:conversionExit><doma:signExists>${flag(d.signExists)}</doma:signExists>` +
    `<doma:lowercase>${flag(d.lowercase)}</doma:lowercase><doma:ampmFormat>${flag(d.ampmFormat)}</doma:ampmFormat></doma:outputInformation>` +
    '<doma:valueInformation>' +
    (d.valueTable ? `<doma:valueTableRef adtcore:name="${e(d.valueTable)}"/>` : '<doma:valueTableRef/>') +
    `<doma:appendExists>${flag(d.appendExists)}</doma:appendExists>` +
    '<doma:fixValues>' +
    d.fixedValues
      .map(
        (v, i) =>
          `<doma:fixValue><doma:position>${i + 1}</doma:position><doma:low>${e(v.low)}</doma:low>` +
          `<doma:high>${e(v.high)}</doma:high><doma:text>${e(v.text)}</doma:text></doma:fixValue>`,
      )
      .join('') +
    '</doma:fixValues></doma:valueInformation></doma:content></doma:domain>'
  );
}

/** What SAP stores that a write can't have sent as it was: trailing blanks (CHAR fields). */
function stored(d: Domain): Record<string, unknown> {
  const t = (s: string) => s.trimEnd();
  return {
    dataType: d.dataType,
    length: d.length,
    decimals: d.decimals,
    outputLength: d.outputLength,
    style: d.style,
    conversionExit: t(d.conversionExit),
    signExists: d.signExists,
    lowercase: d.lowercase,
    ampmFormat: d.ampmFormat,
    valueTable: t(d.valueTable),
    fixedValues: d.fixedValues.filter((v) => !v.append).map((v) => [t(v.low), t(v.high), t(v.text)]),
  };
}

/** A new domain's content: `create` gives its name, package and description, `content` the rest. */
export type DomainContent = FormObjectContent<Domain>;

export const DOMAIN: FormObjectKind<Domain> = {
  type: 'DOMA',
  kind: 'domain',
  plural: 'domains',
  path: '/sap/bc/adt/ddic/domains',
  mediaType: 'application/vnd.sap.adt.domains.v2+xml',
  native: 'domain',
  parse: parseDomainXml,
  build: buildDomainXml,
  stored,
  refuseUpdate: (current) => {
    if (current.appendExists) {
      throw new Error(`domain ${current.name} has fixed value appends; a write replaces the whole domain, so adt+ doesn't write it. Change it in Eclipse or SE11`);
    }
  },
};
