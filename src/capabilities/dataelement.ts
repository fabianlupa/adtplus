import { decodeXml, escapeXml, startTags, xmlAttr } from '../backends/rawadt.js';
import type { FormObject, FormObjectContent, FormObjectKind } from './rest-form-object.js';

// --- REST fallback ---------------------------------------------------------
//
// adt-ls 1.1.2 serves a data element as a placeholder and has no creation adapter for it, as for a
// domain. The lifecycle is every form-based
// object's (rest-form-object.ts) under /sap/bc/adt/ddic/dataelements. SAP's create doesn't store
// the content always as sent (every label at its maximum length; `cloud-erp` drops a predefined type): a
// PUT follows then.
// A label length goes with its maximum (`…FieldMaxLength`): sent without, the activation sets every
// length to its maximum. Names are stored as sent and the activation finds none in lower case.
// A domain-based data element's predefined type is the domain's: sent empty, filled by the activation.

/** Kinds whose type is a predefined one (`dataType`); the others name one (`typeName`). */
export function hasPredefinedType(kind: string): boolean {
  return kind === 'predefinedAbapType' || kind === 'refToPredefinedAbapType';
}

export const LABELS = ['short', 'medium', 'long', 'heading'] as const;
export type LabelKind = (typeof LABELS)[number];

/** The longest each label can be (SE11's "max. length"), the same for every data element. */
export const LABEL_MAX: Record<LabelKind, number> = { short: 10, medium: 20, long: 40, heading: 55 };

export interface FieldLabel {
  text: string;
  /** The longest a translation may be; at most `LABEL_MAX`. */
  length: number;
}

export interface DataElement extends FormObject {
  typeKind: string;
  /** The domain, dictionary type or class/interface; empty for a predefined type. */
  typeName: string;
  /** The predefined type; for a domain-based one the domain's, filled by the activation. */
  dataType: string;
  length: number;
  decimals: number;
  labels: Record<LabelKind, FieldLabel>;
  searchHelp: string;
  searchHelpParameter: string;
  setGetParameter: string;
  defaultComponentName: string;
  deactivateInputHistory: boolean;
  changeDocument: boolean;
  /** DD04L-LTRFLDDIS: AFF's `basicDirection` `rightToLeft` when set. */
  leftToRightDirection: boolean;
  deactivateBIDIFiltering: boolean;
}

/** The text of `<dtel:name>` in `xml`, `''` for an empty element. */
function element(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<dtel:${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</dtel:${name}>)`));
  return m?.[1] === undefined ? '' : decodeXml(m[1]);
}

const number = (text: string) => (text.trim() === '' ? 0 : Number.parseInt(text, 10));

export function parseDataElementXml(xml: string): DataElement {
  const head = xml.match(startTags('blue:wbobj'))?.[0];
  const name = head && xmlAttr(head, 'adtcore:name');
  const body = xml.match(/<dtel:dataElement\b[\s\S]*?<\/dtel:dataElement>/)?.[0];
  if (!head || !name || !body) throw new Error('not a data element representation (blue:wbobj with dtel:dataElement)');
  const packageRef = xml.match(startTags('adtcore:packageRef'))?.[0] ?? '';
  const label = (kind: LabelKind): FieldLabel => ({ text: element(body, `${kind}FieldLabel`), length: number(element(body, `${kind}FieldLength`)) });
  return {
    name,
    description: xmlAttr(head, 'adtcore:description') ?? '',
    package: xmlAttr(packageRef, 'adtcore:name') ?? '',
    masterLanguage: xmlAttr(head, 'adtcore:masterLanguage') ?? '',
    abapLanguageVersion: xmlAttr(head, 'adtcore:abapLanguageVersion') || 'standard',
    version: xmlAttr(head, 'adtcore:version') ?? '',
    typeKind: element(body, 'typeKind'),
    typeName: element(body, 'typeName'),
    dataType: element(body, 'dataType'),
    length: number(element(body, 'dataTypeLength')),
    decimals: number(element(body, 'dataTypeDecimals')),
    labels: { short: label('short'), medium: label('medium'), long: label('long'), heading: label('heading') },
    searchHelp: element(body, 'searchHelp'),
    searchHelpParameter: element(body, 'searchHelpParameter'),
    setGetParameter: element(body, 'setGetParameter'),
    defaultComponentName: element(body, 'defaultComponentName'),
    deactivateInputHistory: element(body, 'deactivateInputHistory') === 'true',
    changeDocument: element(body, 'changeDocument') === 'true',
    leftToRightDirection: element(body, 'leftToRightDirection') === 'true',
    deactivateBIDIFiltering: element(body, 'deactivateBIDIFiltering') === 'true',
  };
}

export function buildDataElementXml(d: DataElement, options: { create?: boolean } = {}): string {
  const e = escapeXml;
  const flag = (b: boolean) => (b ? 'true' : 'false');
  const text = (name: string, value: string) => `<dtel:${name}>${e(value)}</dtel:${name}>`;
  const languageVersion = options.create && d.abapLanguageVersion !== 'standard' ? ` adtcore:abapLanguageVersion="${e(d.abapLanguageVersion)}"` : '';
  // A domain's type is the domain's (the activation fills it); a reference names its type.
  const predefined = hasPredefinedType(d.typeKind);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core"' +
    ` adtcore:name="${e(d.name)}" adtcore:type="DTEL/DE" adtcore:description="${e(d.description)}"` +
    ` adtcore:masterLanguage="${e(d.masterLanguage)}" adtcore:language="${e(d.masterLanguage)}"${languageVersion}>` +
    `<adtcore:packageRef adtcore:name="${e(d.package)}"/>` +
    '<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">' +
    text('typeKind', d.typeKind) +
    text('typeName', d.typeName) +
    text('dataType', predefined ? d.dataType : '') +
    `<dtel:dataTypeLength>${predefined ? d.length : 0}</dtel:dataTypeLength>` +
    `<dtel:dataTypeDecimals>${predefined ? d.decimals : 0}</dtel:dataTypeDecimals>` +
    LABELS.map(
      (k) =>
        text(`${k}FieldLabel`, d.labels[k].text) +
        `<dtel:${k}FieldLength>${d.labels[k].length}</dtel:${k}FieldLength>` +
        `<dtel:${k}FieldMaxLength>${LABEL_MAX[k]}</dtel:${k}FieldMaxLength>`,
    ).join('') +
    text('searchHelp', d.searchHelp) +
    text('searchHelpParameter', d.searchHelpParameter) +
    text('setGetParameter', d.setGetParameter) +
    text('defaultComponentName', d.defaultComponentName) +
    `<dtel:deactivateInputHistory>${flag(d.deactivateInputHistory)}</dtel:deactivateInputHistory>` +
    `<dtel:changeDocument>${flag(d.changeDocument)}</dtel:changeDocument>` +
    `<dtel:leftToRightDirection>${flag(d.leftToRightDirection)}</dtel:leftToRightDirection>` +
    `<dtel:deactivateBIDIFiltering>${flag(d.deactivateBIDIFiltering)}</dtel:deactivateBIDIFiltering>` +
    '</dtel:dataElement></blue:wbobj>'
  );
}

/** What SAP stores that a write can't have sent as it was: trailing blanks (CHAR fields), a domain's type. */
function stored(d: DataElement): Record<string, unknown> {
  const t = (s: string) => s.trimEnd();
  return {
    typeKind: d.typeKind,
    typeName: t(d.typeName),
    // A domain-based one's is filled by the activation from the domain; a reference has none.
    type: hasPredefinedType(d.typeKind) ? [d.dataType, d.length, d.decimals] : null,
    labels: LABELS.map((k) => [t(d.labels[k].text), d.labels[k].length]),
    searchHelp: [t(d.searchHelp), t(d.searchHelpParameter)],
    setGetParameter: t(d.setGetParameter),
    defaultComponentName: t(d.defaultComponentName),
    flags: [d.deactivateInputHistory, d.changeDocument, d.leftToRightDirection, d.deactivateBIDIFiltering],
  };
}

/**
 * Labels longer than their length: SAP's activation would refuse them and a PUT stores them
 * anyway. With `current`, only the labels the write changes: one already stored too long isn't the call's.
 */
function checkLabels(d: DataElement, current?: DataElement): void {
  for (const k of LABELS) {
    if (current && JSON.stringify(current.labels[k]) === JSON.stringify(d.labels[k])) continue;
    const { text, length: max } = d.labels[k];
    const chars = [...text.trimEnd()].length;
    if (chars > max) throw new Error(`fieldLabels.${k} has ${chars} characters, more than its length ${max} (fieldLabels.${k}Length)`);
  }
}

/** A new data element's content: `create` gives its name, package and description, `content` the rest. */
export type DataElementContent = FormObjectContent<DataElement>;

export const DATA_ELEMENT: FormObjectKind<DataElement> = {
  type: 'DTEL',
  kind: 'data element',
  plural: 'data elements',
  path: '/sap/bc/adt/ddic/dataelements',
  mediaType: 'application/vnd.sap.adt.dataelements.v2+xml',
  native: 'dataElement',
  parse: parseDataElementXml,
  build: buildDataElementXml,
  stored,
  check: checkLabels,
  rewriteAfterCreate: true,
};
