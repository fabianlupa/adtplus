import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import { AFF_SCHEMAS } from '../mirror/aff-schemas/index.js';
import { compileAffSchema } from '../mirror/schema.js';
import { hasPredefinedType, LABEL_MAX, LABELS, type DataElement, type DataElementContent } from './dataelement.js';
import type { Domain, DomainContent, FixedValue } from './domain.js';
import type { MessageClass, MessageInput } from './messageclass.js';
import { languageVersionName, type CreatePackageInput, type LanguageVersion, type PackageDefinition } from './package.js';

/**
 * Form-based objects as their type's AFF JSON (docs/decisions/018-names-and-grouping.md): what
 * `object read` returns for them, and the `properties` that `object create`/`update` take.
 * SAP's field names, checked against AFF's schema; an update's `properties` merge into the object
 * by key, so a key not sent stays as it is and leaving a list entry out never deletes it.
 */

/** The form-based types with an AFF schema. */
const FORM_TYPES = { DEVC: 'devc-v1', DOMA: 'doma-v1', DTEL: 'dtel-v1', MSAG: 'msag-v1' } as const;
/** `TRPR`, a translation project, is form-based too, in a shape of adt+'s own: AFF has no `trpr` (ADR-019 §4). */
export type FormType = keyof typeof FORM_TYPES | 'TRPR';

/** `DEVC/K` → `DEVC`; undefined for a source-based type. */
export function formType(objectType: string): FormType | undefined {
  const main = objectType.split('/')[0]!.toUpperCase();
  return main in FORM_TYPES || main === 'TRPR' ? (main as FormType) : undefined;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The schema with every `required` dropped: a partial document is valid as far as it goes. */
function partial(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(partial);
  if (!isObject(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== 'required').map(([k, v]) => [k, partial(v)]));
}

const validators = new Map<keyof typeof FORM_TYPES, ValidateFunction>();

function validatorFor(type: keyof typeof FORM_TYPES): ValidateFunction {
  let validate = validators.get(type);
  if (!validate) {
    // Its own `$id`: the full schema is compiled under AFF's one.
    const schema = partial(AFF_SCHEMAS[FORM_TYPES[type]]) as Record<string, unknown>;
    validate = compileAffSchema({ ...schema, $id: `${String(schema.$id)}.partial` });
    validators.set(type, validate);
  }
  return validate;
}

/** Every leaf path the schema knows, for a refusal: `header.description`, `messages[].text`. */
function fieldsOf(schema: unknown, prefix = ''): string[] {
  if (!isObject(schema)) return [];
  if (schema.type === 'array') return fieldsOf(schema.items, `${prefix}[]`);
  if (!isObject(schema.properties)) return prefix ? [prefix] : [];
  return Object.entries(schema.properties).flatMap(([k, v]) => fieldsOf(v, prefix ? `${prefix}.${k}` : k));
}

function describeError(e: ErrorObject): string {
  const at = e.instancePath.replace(/^\//, '').replaceAll('/', '.') || 'properties';
  if (e.keyword === 'additionalProperties') return `${at} has "${(e.params as { additionalProperty: string }).additionalProperty}", which AFF doesn't know`;
  return `${at} ${e.message ?? 'is not valid'}`;
}

/** `properties` against the type's AFF schema (partial): refused with every finding and the type's fields. */
export function checkProperties(objectType: string, properties: unknown): Json {
  const type = formType(objectType);
  if (!type) throw new Error(`${objectType} takes "source", not "properties": only ${[...Object.keys(FORM_TYPES), 'TRPR'].join(', ')} take properties`);
  if (type === 'TRPR') throw new Error('a translation project (TRPR) has no AFF schema: its update checks its own properties (ADR-019)');
  if (!isObject(properties)) throw new Error('"properties" must be a JSON object');
  const validate = validatorFor(type);
  if (!validate(properties)) {
    const findings = (validate.errors ?? []).map(describeError);
    const fields = fieldsOf(AFF_SCHEMAS[FORM_TYPES[type]]).filter((f) => f !== 'formatVersion');
    throw new Error(`${type} properties refused (AFF ${FORM_TYPES[type]}): ${findings.join('; ')}. Its fields: ${fields.join(', ')}`);
  }
  return properties;
}

/** Keys a call may not set: `where` names them, `why` says what to do instead. */
function refuseKeys(o: Json | undefined, keys: string[], where: string, why: string): void {
  const given = keys.filter((k) => o?.[k] !== undefined);
  if (given.length > 0) throw new Error(`${given.map((k) => `${where}${k}`).join(', ')}: ${why}`);
}

// --- MSAG ---------------------------------------------------------------------

/** A message class as AFF `msag-v1`: messages by number. */
export function messageClassProperties(mc: Pick<MessageClass, 'description' | 'masterLanguage' | 'messages'>): Json {
  const messages = [...mc.messages]
    .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))
    .map((m) => ({ number: m.number, text: m.text }));
  return { formatVersion: '1', header: { description: mc.description, originalLanguage: mc.masterLanguage.toLowerCase() }, messages };
}

/** An update's `properties` for a message class: the description and the messages to add or change. */
export function messageClassUpdate(properties: Json): { description?: string; messages?: MessageInput[] } {
  refuseKeys(properties, ['formatVersion'], '', 'set by adt+, not by a call');
  const header = properties.header as Json | undefined;
  refuseKeys(header, ['originalLanguage'], 'header.', 'the original language does not change');
  const messages = properties.messages as Array<{ number: string; text?: string }> | undefined;
  const textless = messages?.find((m) => m.text === undefined);
  if (textless) throw new Error(`messages: message ${textless.number} has no "text"; leaving a message out keeps it as it is`);
  const description = header?.description as string | undefined;
  if (description === undefined && !messages?.length) throw new Error('message class update needs "messages" and/or "header.description"');
  return {
    ...(description !== undefined ? { description } : {}),
    ...(messages ? { messages: messages.map((m) => ({ number: m.number, text: m.text! })) } : {}),
  };
}

// --- DOMA ---------------------------------------------------------------------

/** DD01L-OUTPUTSTYLE codes (SAP's domain OUTPUTSTYLE) in AFF's enum order. */
const OUTPUT_STYLES = ['normal', 'signRight', 'scalePreserving', 'scientific', 'scientificWithLeadingZero', 'scalePreservingScientific', 'engineering'] as const;

const styleName = (code: string): string => OUTPUT_STYLES[Number.parseInt(code, 10)] ?? `unknown(${code})`;
const styleCode = (name: string): string => String(OUTPUT_STYLES.indexOf(name as (typeof OUTPUT_STYLES)[number])).padStart(2, '0');

/** A domain as AFF `doma-v1`; what is off or empty left out, as AFF writes it. Values an append contributes are its own. */
export function domainProperties(d: Domain): Json {
  const own = d.fixedValues.filter((v) => !v.append);
  const single = own.filter((v) => !v.high).map((v) => ({ fixedValue: v.low, description: v.text }));
  const intervals = own.filter((v) => v.high).map((v) => ({ ...(v.low ? { lowLimit: v.low } : {}), highLimit: v.high, description: v.text }));
  const appends = [...new Set(d.fixedValues.flatMap((v) => (v.append ? [v.append] : [])))];
  return {
    formatVersion: '1',
    header: {
      description: d.description,
      originalLanguage: d.masterLanguage.toLowerCase(),
      ...(d.abapLanguageVersion !== 'standard' ? { abapLanguageVersion: d.abapLanguageVersion } : {}),
    },
    format: { dataType: d.dataType, length: d.length, ...(d.decimals ? { decimals: d.decimals } : {}) },
    outputCharacteristics: {
      length: d.outputLength,
      ...(d.style !== '00' ? { style: styleName(d.style) } : {}),
      ...(d.conversionExit ? { conversionRoutine: d.conversionExit } : {}),
      ...(d.lowercase ? { caseSensitive: true } : {}),
      ...(d.signExists ? { negativeValues: true } : {}),
      ...(d.ampmFormat ? { amPmTimeFormat: true } : {}),
    },
    ...(single.length ? { fixedValues: single } : {}),
    ...(intervals.length ? { fixedValueIntervals: intervals } : {}),
    ...(d.valueTable ? { valueTable: { name: d.valueTable } } : {}),
    ...(appends.length ? { fixedValueAppends: appends.map((name) => ({ name })) } : {}),
  };
}

type DomainFields = Omit<DomainContent, 'fixedValues'> & { description: string; fixedValues: FixedValue[] };

/** `properties` (checked against AFF) over `base`: a key not sent keeps its value; a fixed value list sent is the new list. */
function applyDomainProperties<T extends DomainFields>(base: T, properties: Json): T {
  const format = (properties.format ?? {}) as Json;
  const output = (properties.outputCharacteristics ?? {}) as Json;
  const valueTable = properties.valueTable as Json | undefined;
  const header = properties.header as Json | undefined;
  const pick = <V>(value: unknown, fallback: V): V => (value === undefined ? fallback : (value as V));
  const own = base.fixedValues.filter((v) => !v.append);
  const single = properties.fixedValues as Array<{ fixedValue?: string; description?: string }> | undefined;
  const intervals = properties.fixedValueIntervals as Array<{ lowLimit?: string; highLimit?: string; description?: string }> | undefined;
  // AFF requires it; the partial schema `checkProperties` uses doesn't.
  if (intervals?.some((v) => !v.highLimit)) throw new Error('fixedValueIntervals: every interval needs its "highLimit"');
  const lowercase = pick(output.caseSensitive, base.lowercase);
  // SAP stores the values of a domain that isn't case-sensitive in upper case.
  const value = (v: string) => (lowercase ? v : v.toUpperCase());
  const fixedValues = [
    ...(single ? single.map((v) => ({ low: value(v.fixedValue ?? ''), high: '', text: v.description ?? '' })) : own.filter((v) => !v.high).map((v) => ({ ...v, low: value(v.low) }))),
    ...(intervals ? intervals.map((v) => ({ low: value(v.lowLimit ?? ''), high: value(v.highLimit!), text: v.description ?? '' })) : own.filter((v) => v.high).map((v) => ({ ...v, low: value(v.low), high: value(v.high) }))),
  ];
  const twice = fixedValues.map((v) => (v.high ? `${v.low}…${v.high}` : v.low)).filter((k, i, all) => all.indexOf(k) !== i);
  if (twice.length > 0) throw new Error(`fixed value ${twice[0]} is given twice`);
  const typeChanged = (['dataType', 'length', 'decimals'] as const).some((k) => format[k] !== undefined && format[k] !== base[k]);
  return {
    ...base,
    description: pick(header?.description, base.description),
    dataType: pick(format.dataType, base.dataType),
    length: pick(format.length, base.length),
    decimals: pick(format.decimals, base.decimals),
    // One computed for the old type would be too short or too long: 0 lets the activation compute it again.
    outputLength: pick(output.length, typeChanged ? 0 : base.outputLength),
    style: output.style === undefined ? base.style : styleCode(output.style as string),
    // SAP stores the name as sent, and its activation finds no routine in lower case.
    conversionExit: (pick(output.conversionRoutine, base.conversionExit) as string).toUpperCase(),
    lowercase,
    signExists: pick(output.negativeValues, base.signExists),
    ampmFormat: pick(output.amPmTimeFormat, base.ampmFormat),
    valueTable: valueTable === undefined ? base.valueTable : ((valueTable.name as string | undefined) ?? '').toUpperCase(),
    fixedValues,
  };
}

const DOMAIN_APPENDS = 'fixed value appends are objects of their own: adt+ neither creates nor changes them';

/** A create's `properties` for a domain: `format` at least. Name, package and description come as the create's own parameters. */
export function domainCreate(properties: Json | undefined): DomainContent {
  if (!properties) throw new Error('a domain create needs "properties" with format.dataType and format.length');
  refuseKeys(properties, ['formatVersion', 'header'], '', 'a create takes the name, "package" and "description" as its own parameters; the language is the logon language, the ABAP language version the package\'s default');
  refuseKeys(properties, ['fixedValueAppends'], '', DOMAIN_APPENDS);
  const format = properties.format as Json | undefined;
  if (format?.dataType === undefined || format.length === undefined) throw new Error('a domain create needs format.dataType and format.length');
  const empty: DomainFields = {
    description: '',
    dataType: '',
    length: 0,
    decimals: 0,
    outputLength: 0,
    style: '00',
    conversionExit: '',
    signExists: false,
    lowercase: false,
    ampmFormat: false,
    valueTable: '',
    appendExists: false,
    fixedValues: [],
  };
  const { description: _, ...content } = applyDomainProperties(empty, properties);
  return content;
}

/** An update's `properties` for a domain, as the change it makes to the current one. */
export function domainUpdate(properties: Json): (current: Domain) => Domain {
  refuseKeys(properties, ['formatVersion'], '', 'set by adt+, not by a call');
  refuseKeys(properties.header as Json | undefined, ['originalLanguage', 'abapLanguageVersion'], 'header.', 'it does not change');
  refuseKeys(properties, ['fixedValueAppends'], '', DOMAIN_APPENDS);
  const keys = Object.keys(properties).filter((k) => k !== 'header');
  if (keys.length === 0 && (properties.header as Json | undefined)?.description === undefined) {
    throw new Error('domain update needs at least one of header.description, format, outputCharacteristics, fixedValues, fixedValueIntervals, valueTable');
  }
  return (current) => applyDomainProperties(current, properties);
}

// --- DTEL ---------------------------------------------------------------------

/** SAP's kind of type (`dtel:typeKind`) ↔ AFF's `dataTypeInformation.category`. */
const CATEGORIES: Record<string, string> = {
  domain: 'domain',
  predefinedAbapType: 'predefinedType',
  refToPredefinedAbapType: 'referenceToPredefinedType',
  refToDictionaryType: 'referenceDictionaryType',
  refToClifType: 'referenceClasIntType',
};
const typeKindOf = (category: string): string => Object.entries(CATEGORIES).find(([, c]) => c === category)![0];

/**
 * A data element as AFF `dtel-v1`; what is off or empty left out, as AFF writes it. A domain-based
 * one names its domain only (its type is the domain's). The flag SE11 calls "basic direction is set
 * to LTR" is AFF's `basicDirection` `rightToLeft` (AFF's value for it, `X`).
 */
export function dataElementProperties(d: DataElement): Json {
  const predefined = hasPredefinedType(d.typeKind);
  const searchHelp = d.searchHelp ? { name: d.searchHelp, ...(d.searchHelpParameter ? { parameter: d.searchHelpParameter } : {}) } : undefined;
  const bidi = {
    ...(d.leftToRightDirection ? { basicDirection: 'rightToLeft' } : {}),
    ...(d.deactivateBIDIFiltering ? { noFiltering: true } : {}),
  };
  const additional: Json = {
    ...(searchHelp ? { searchHelp } : {}),
    ...(d.setGetParameter ? { parameterId: d.setGetParameter } : {}),
    ...(d.defaultComponentName ? { defaultComponentName: d.defaultComponentName } : {}),
    ...(d.changeDocument ? { changeDocumentRelevant: true } : {}),
    ...(d.deactivateInputHistory ? { noInputHistory: true } : {}),
    ...(Object.keys(bidi).length ? { bidirectionalOptions: bidi } : {}),
  };
  return {
    formatVersion: '1',
    header: {
      description: d.description,
      originalLanguage: d.masterLanguage.toLowerCase(),
      ...(d.abapLanguageVersion !== 'standard' ? { abapLanguageVersion: d.abapLanguageVersion } : {}),
    },
    dataTypeInformation: {
      category: CATEGORIES[d.typeKind] ?? `unknown(${d.typeKind})`,
      ...(predefined
        ? { predefinedType: { dataType: d.dataType, ...(d.length ? { length: d.length } : {}), ...(d.decimals ? { decimals: d.decimals } : {}) } }
        : { typeName: d.typeName }),
    },
    fieldLabels: Object.fromEntries(LABELS.flatMap((k) => [[k, d.labels[k].text], [`${k}Length`, d.labels[k].length]])),
    ...(Object.keys(additional).length ? { additionalProperties: additional } : {}),
  };
}

type DataElementFields = DataElementContent & { description: string };

/** `properties` (checked against AFF) over `base`: a key not sent keeps its value; a change of category clears the old one's type. */
function applyDataElementProperties<T extends DataElementFields>(base: T, properties: Json): T {
  const pick = <V>(value: unknown, fallback: V): V => (value === undefined ? fallback : (value as V));
  const upper = (v: string) => v.toUpperCase();
  const info = (properties.dataTypeInformation ?? {}) as Json;
  const predefinedType = info.predefinedType as Json | undefined;
  const typeKind = info.category === undefined ? base.typeKind : typeKindOf(info.category as string);
  const category = CATEGORIES[typeKind];
  const predefined = hasPredefinedType(typeKind);
  if (predefined && info.typeName !== undefined) throw new Error(`dataTypeInformation.typeName: a ${category} data element has a predefinedType, not a typeName`);
  if (!predefined && predefinedType !== undefined) throw new Error(`dataTypeInformation.predefinedType: a ${category} data element names its type in typeName`);
  // Another category starts from no type: the old one's name or predefined type doesn't carry over;
  // another data type, from no length and decimals: the old type's don't fit it.
  const from = typeKind === base.typeKind ? base : { ...base, typeName: '', dataType: '', length: 0, decimals: 0 };
  const typeName = predefined ? '' : upper(pick(info.typeName, from.typeName));
  const dataType = predefined ? pick(predefinedType?.dataType, from.dataType) : '';
  const sized = dataType === from.dataType ? from : { ...from, length: 0, decimals: 0 };
  if (predefined && !dataType) throw new Error(`a ${category} data element needs dataTypeInformation.predefinedType.dataType`);
  if (!predefined && !typeName) throw new Error(`a ${category} data element needs dataTypeInformation.typeName`);
  const labels = (properties.fieldLabels ?? {}) as Json;
  const additional = (properties.additionalProperties ?? {}) as Json;
  const searchHelp = additional.searchHelp as Json | undefined;
  const bidi = (additional.bidirectionalOptions ?? {}) as Json;
  const searchHelpName = upper(pick(searchHelp?.name, base.searchHelp));
  if (!searchHelpName && searchHelp?.parameter) throw new Error('additionalProperties.searchHelp.parameter needs a search help: send searchHelp.name too');
  // A parameter belongs to its search help: another one, or none, drops the old parameter.
  const keptParameter = searchHelpName === base.searchHelp ? base.searchHelpParameter : '';
  const header = properties.header as Json | undefined;
  return {
    ...base,
    description: pick(header?.description, base.description),
    typeKind,
    typeName,
    dataType,
    length: predefined ? pick(predefinedType?.length, sized.length) : 0,
    decimals: predefined ? pick(predefinedType?.decimals, sized.decimals) : 0,
    labels: Object.fromEntries(
      LABELS.map((k) => [k, { text: pick(labels[k], base.labels[k].text), length: pick(labels[`${k}Length`], base.labels[k].length) }]),
    ) as DataElement['labels'],
    searchHelp: searchHelpName,
    searchHelpParameter: searchHelpName ? upper(pick(searchHelp?.parameter, keptParameter)) : '',
    setGetParameter: upper(pick(additional.parameterId, base.setGetParameter)),
    defaultComponentName: upper(pick(additional.defaultComponentName, base.defaultComponentName)),
    changeDocument: pick(additional.changeDocumentRelevant, base.changeDocument),
    deactivateInputHistory: pick(additional.noInputHistory, base.deactivateInputHistory),
    leftToRightDirection: bidi.basicDirection === undefined ? base.leftToRightDirection : bidi.basicDirection === 'rightToLeft',
    deactivateBIDIFiltering: pick(bidi.noFiltering, base.deactivateBIDIFiltering),
  };
}

/**
 * A create's `properties` for a data element: `dataTypeInformation` at least. Name, package and
 * description come as the create's own parameters; a label length not given is the label's
 * maximum, as SE11 starts it.
 */
export function dataElementCreate(properties: Json | undefined): DataElementContent {
  if (!properties) throw new Error('a data element create needs "properties" with dataTypeInformation.category and its type');
  refuseKeys(properties, ['formatVersion', 'header'], '', 'a create takes the name, "package" and "description" as its own parameters; the language is the logon language, the ABAP language version the package\'s default');
  if ((properties.dataTypeInformation as Json | undefined)?.category === undefined) {
    throw new Error('a data element create needs dataTypeInformation.category: domain (with typeName), predefinedType (with predefinedType.dataType), or a reference');
  }
  const empty: DataElementFields = {
    description: '',
    typeKind: '',
    typeName: '',
    dataType: '',
    length: 0,
    decimals: 0,
    labels: Object.fromEntries(LABELS.map((k) => [k, { text: '', length: LABEL_MAX[k] }])) as DataElement['labels'],
    searchHelp: '',
    searchHelpParameter: '',
    setGetParameter: '',
    defaultComponentName: '',
    deactivateInputHistory: false,
    changeDocument: false,
    leftToRightDirection: false,
    deactivateBIDIFiltering: false,
  };
  const { description: _, ...content } = applyDataElementProperties(empty, properties);
  return content;
}

/** An update's `properties` for a data element, as the change it makes to the current one. */
export function dataElementUpdate(properties: Json): (current: DataElement) => DataElement {
  refuseKeys(properties, ['formatVersion'], '', 'set by adt+, not by a call');
  refuseKeys(properties.header as Json | undefined, ['originalLanguage', 'abapLanguageVersion'], 'header.', 'it does not change');
  const keys = Object.keys(properties).filter((k) => k !== 'header');
  if (keys.length === 0 && (properties.header as Json | undefined)?.description === undefined) {
    throw new Error('data element update needs at least one of header.description, dataTypeInformation, fieldLabels, additionalProperties');
  }
  return (current) => applyDataElementProperties(current, properties);
}

// --- DEVC ---------------------------------------------------------------------

/** A package as AFF `devc-v1`; empty optional fields left out, as AFF writes them. */
export function packageProperties(p: PackageDefinition): Json {
  const version = languageVersionName(p.languageVersion);
  const general: Json = {
    type: p.packageType || 'development',
    ...(p.superPackage ? { superPackage: p.superPackage } : {}),
    ...(p.applicationComponent ? { applicationComponent: p.applicationComponent } : {}),
    ...(p.softwareComponent ? { softwareComponent: p.softwareComponent } : {}),
    ...(p.transportLayer ? { transportLayer: p.transportLayer } : {}),
    supportsRecordChanges: p.recordChanges,
    ...(p.addingObjectsNotPossible ? { isAddingObjectsNotAllowed: true } : {}),
    defaultAbapLanguageVersion: version,
  };
  return {
    formatVersion: '1',
    header: { description: p.description, originalLanguage: p.masterLanguage.toLowerCase() },
    generalInformation: general,
  };
}

/** What adt+ changes on an existing package; everything else stays as SAP has it (SE21). */
const PACKAGE_EDITABLE = 'adt+ changes a package\'s header.description and generalInformation.applicationComponent only';

/** An update's `properties` for a package. */
export function packageUpdate(properties: Json): { description?: string; applicationComponent?: string } {
  refuseKeys(properties, ['formatVersion', 'useAccesses'], '', PACKAGE_EDITABLE);
  const header = properties.header as Json | undefined;
  refuseKeys(header, ['originalLanguage'], 'header.', PACKAGE_EDITABLE);
  const general = properties.generalInformation as Json | undefined;
  const others = Object.keys(general ?? {}).filter((k) => k !== 'applicationComponent');
  refuseKeys(general, others, 'generalInformation.', PACKAGE_EDITABLE);
  const description = header?.description as string | undefined;
  const applicationComponent = general?.applicationComponent as string | undefined;
  if (description === undefined && applicationComponent === undefined) {
    throw new Error('package update needs "header.description" and/or "generalInformation.applicationComponent"');
  }
  return { ...(description !== undefined ? { description } : {}), ...(applicationComponent !== undefined ? { applicationComponent } : {}) };
}

/** A create's `properties` for a package; its name, superpackage (`package`) and description come as the create's own parameters. */
export function packageCreate(properties: Json | undefined): Omit<CreatePackageInput, 'name' | 'superPackage' | 'description' | 'transport'> {
  if (!properties) return {};
  refuseKeys(properties, ['formatVersion', 'header', 'useAccesses'], '', 'a create takes the name, "package" (the superpackage) and "description" as its own parameters, and nothing else here');
  const general = (properties.generalInformation ?? {}) as Json;
  refuseKeys(general, ['superPackage'], 'generalInformation.', 'the superpackage is the create\'s "package"');
  refuseKeys(general, ['switch', 'isEncapsulated', 'isAddingObjectsNotAllowed'], 'generalInformation.', 'adt+ creates development packages without them');
  if (general.type !== undefined && general.type !== 'development') throw new Error('generalInformation.type: adt+ creates development packages only');
  return {
    ...(general.softwareComponent !== undefined ? { softwareComponent: general.softwareComponent as string } : {}),
    ...(general.transportLayer !== undefined ? { transportLayer: general.transportLayer as string } : {}),
    ...(general.applicationComponent !== undefined ? { applicationComponent: general.applicationComponent as string } : {}),
    ...(general.supportsRecordChanges !== undefined ? { recordChanges: general.supportsRecordChanges as boolean } : {}),
    ...(general.defaultAbapLanguageVersion !== undefined ? { languageVersion: general.defaultAbapLanguageVersion as LanguageVersion } : {}),
  };
}
