import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { decodeXml, escapeXml, RawAdtError, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import type { Destination } from '../core/destinations.js';
import { lookupPackageChain, type PackageChainLookup } from '../core/placement.js';
import { assertConfirmed, assertPackageWritable } from './policy.js';
import { ownUser } from './transport.js';

// --- REST fallback ---------------------------------------------------------
//
// Create/edit/validate/delete have no adt-ls path in 1.1.2. Wire protocol, verified live
// on `onprem` (2023, client 100) and `cloud-erp` (Cloud, client 100):
//   GET  /sap/bc/adt/packages/{name}           → application/vnd.sap.adt.packages.v2+xml
//   POST /sap/bc/adt/packages/validation?…     → asx:abap StatusMessage (SEVERITY)
//   POST /sap/bc/adt/packages?corrNr=          → create (v2 body)
//   POST {uri}?_action=LOCK&accessMode=MODIFY&corrNr=   (corrNr must be present,
//        even empty; SAP may answer with a generated CORRNR the next call must reuse)
//   PUT  {uri}?lockHandle=&corrNr=             → full replace, then always UNLOCK
//   DELETE {uri}?lockHandle=&corrNr=
// Lessons carried over from the archived abap-mirror attempt:
//   - `pak:languageVersion` must be sent. It is a code, not the AFF name:
//     "" standard, "2" key user, "5" cloud development (`onprem` reads "", `cloud-erp` "5").
//     A `cloud-erp` package created without it could not be locked again
//     (S_ABPLNGVS).
//   - Lock with the transport that already holds the package, not a fresh
//     one, or the object stays locked in the other request (`onprem` EU/510).

const PACKAGES_PATH = '/sap/bc/adt/packages';
const PACKAGE_MEDIA_TYPE = 'application/vnd.sap.adt.packages.v2+xml';
const LOCK_RESULT_MEDIA_TYPE = 'application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result';

export const LANGUAGE_VERSION_CODES = {
  standard: '',
  keyUser: '2',
  cloudDevelopment: '5',
} as const;

export type LanguageVersion = keyof typeof LANGUAGE_VERSION_CODES;

export function languageVersionName(code: string): LanguageVersion | `unknown(${string})` {
  const entry = Object.entries(LANGUAGE_VERSION_CODES).find(([, c]) => c === code);
  return entry ? (entry[0] as LanguageVersion) : `unknown(${code})`;
}

/** The writable subset of the REST package representation. */
export interface PackageDefinition {
  name: string;
  description: string;
  /** Language of `description`. Empty on create (SAP uses the logon
   * language). An edit must re-send it: on `cloud-erp` a PUT without it returned
   * 200 and silently kept the old description. */
  masterLanguage: string;
  responsible: string;
  packageType: string;
  recordChanges: boolean;
  /** Language version *code* (see LANGUAGE_VERSION_CODES). */
  languageVersion: string;
  superPackage: string;
  applicationComponent: string;
  softwareComponent: string;
  transportLayer: string;
  /**
   * "Adding further objects not possible". SAP's attribute reads the other way round:
   * `pak:isAddingObjectsAllowed="true"` on a package with the box checked, whose creates fail with
   * "Cannot add further development objects to package …", `"false"` where they work.
   */
  addingObjectsNotPossible?: boolean;
}

export function packageUri(name: string): string {
  return `${PACKAGES_PATH}/${encodeURIComponent(name.toLowerCase())}`;
}

function attr(xml: string, element: string, attribute: string): string | undefined {
  const tag = xml.match(new RegExp(`<${element}\\b[^>]*>`))?.[0];
  const value = tag?.match(new RegExp(`\\s${attribute}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

export function parsePackageXml(xml: string): PackageDefinition {
  const name = attr(xml, 'pak:package', 'adtcore:name');
  if (!name) throw new Error('not a pak:package representation');
  const transport = xml.match(/<pak:transport>[\s\S]*?<\/pak:transport>/)?.[0] ?? '';
  return {
    name,
    description: attr(xml, 'pak:package', 'adtcore:description') ?? '',
    masterLanguage: attr(xml, 'pak:package', 'adtcore:masterLanguage') ?? '',
    responsible: attr(xml, 'pak:package', 'adtcore:responsible') ?? '',
    packageType: attr(xml, 'pak:attributes', 'pak:packageType') ?? 'development',
    recordChanges: attr(xml, 'pak:attributes', 'pak:recordChanges') === 'true',
    languageVersion: attr(xml, 'pak:attributes', 'pak:languageVersion') ?? '',
    ...(attr(xml, 'pak:attributes', 'pak:isAddingObjectsAllowed') === 'true' ? { addingObjectsNotPossible: true } : {}),
    superPackage: attr(xml, 'pak:superPackage', 'adtcore:name') ?? '',
    applicationComponent: attr(xml, 'pak:applicationComponent', 'pak:name') ?? '',
    softwareComponent: attr(transport, 'pak:softwareComponent', 'pak:name') ?? '',
    transportLayer: attr(transport, 'pak:transportLayer', 'pak:name') ?? '',
  };
}

/** Full v2 body in the element order SAP's deserializer insists on. */
export function buildPackageXml(p: PackageDefinition): string {
  const e = escapeXml;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core"' +
    ` adtcore:name="${e(p.name)}" adtcore:type="DEVC/K" adtcore:description="${e(p.description)}"` +
    (p.masterLanguage
      ? ` adtcore:masterLanguage="${e(p.masterLanguage)}" adtcore:language="${e(p.masterLanguage)}"`
      : '') +
    ` adtcore:responsible="${e(p.responsible)}">` +
    `<adtcore:packageRef adtcore:name="${e(p.name)}"/>` +
    `<pak:attributes pak:packageType="${e(p.packageType)}" pak:recordChanges="${p.recordChanges}"` +
    ` pak:languageVersion="${e(p.languageVersion)}"` +
    // Sent back only when set, so an edit keeps it; a create's body stays as verified.
    (p.addingObjectsNotPossible ? ' pak:isAddingObjectsAllowed="true"' : '') +
    '/>' +
    `<pak:superPackage adtcore:name="${e(p.superPackage)}"/>` +
    `<pak:applicationComponent pak:name="${e(p.applicationComponent)}"/>` +
    '<pak:transport>' +
    `<pak:softwareComponent pak:name="${e(p.softwareComponent)}"/>` +
    `<pak:transportLayer pak:name="${e(p.transportLayer)}"/>` +
    '</pak:transport>' +
    '<pak:translation/><pak:useAccesses/><pak:packageInterfaces/><pak:subPackages/>' +
    '</pak:package>'
  );
}

/** GET the REST representation; `undefined` on 404. */
export async function readPackageDefinition(rest: RawAdtClient, name: string): Promise<PackageDefinition | undefined> {
  const res = await rest.request('GET', packageUri(name), { headers: { Accept: PACKAGE_MEDIA_TYPE } });
  if (res.status === 404) return undefined;
  if (res.status >= 400) {
    throw new RawAdtError(res.status, undefined, res.body.slice(0, 300), `read package ${name}`);
  }
  return parsePackageXml(res.body);
}

interface FallbackMeta {
  via: 'rest-fallback';
  /** true once this system offers the operation natively — the fallback is retirable. */
  nativeAvailable: boolean | null;
}

function meta(native: boolean | undefined): FallbackMeta {
  return { via: 'rest-fallback', nativeAvailable: native ?? null };
}

export interface PackageValidation {
  severity: string;
  shortText: string;
  longText: string;
}

export interface ValidatePackageInput {
  name: string;
  superPackage: string;
  description: string;
  softwareComponent: string;
  transportLayer: string;
  recordChanges: boolean;
  applicationComponent?: string;
}

/** SAP's own pre-create check (the call ADT's new-package wizard makes). */
export async function validatePackage(rest: RawAdtClient, input: ValidatePackageInput): Promise<PackageValidation> {
  const res = await rest.expectOk('POST', `${PACKAGES_PATH}/validation`, `validate package ${input.name}`, {
    changesNothing: true,
    headers: { Accept: 'application/xml, */*' },
    query: {
      objname: input.name.toUpperCase(),
      packagename: input.superPackage.toUpperCase(),
      description: input.description,
      objtype: 'DEVC/K',
      packagetype: 'development',
      swcomp: input.softwareComponent,
      transportlayer: input.transportLayer,
      recordChanges: String(input.recordChanges),
      appcomp: input.applicationComponent ?? '',
      checkmode: 'full',
    },
  });
  const field = (tag: string) => decodeXml(res.body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '');
  return { severity: field('SEVERITY'), shortText: field('SHORT_TEXT'), longText: field('LONG_TEXT') };
}

/**
 * The language version (AFF name) a new object in `pkg` gets: on a cloud system ABAP for Cloud
 * Development, the only one there; elsewhere its package's default (AFF's
 * `defaultAbapLanguageVersion`), from `known` when the caller has read the package already.
 */
export async function newObjectLanguageVersion(
  rest: RawAdtClient,
  destination: Destination,
  pkg: string,
  known?: PackageDefinition,
): Promise<LanguageVersion> {
  if (destination.kind === 'cloud') return 'cloudDevelopment';
  const definition = known ?? (await readPackageDefinition(rest, pkg));
  if (!definition) throw new Error(`package "${pkg}" does not exist`);
  const version = languageVersionName(definition.languageVersion);
  if (version.startsWith('unknown(')) throw new Error(`package ${pkg} has language version code "${definition.languageVersion}", which adt+ doesn't know`);
  return version as LanguageVersion;
}

function isValidationFailure(v: PackageValidation): boolean {
  return !['OK', 'INFO', 'WARNING', ''].includes(v.severity.toUpperCase());
}

export interface CreatePackageInput {
  name: string;
  superPackage: string;
  description: string;
  softwareComponent?: string;
  transportLayer?: string;
  applicationComponent?: string;
  recordChanges?: boolean;
  languageVersion?: LanguageVersion;
  transport?: string;
}

interface ResolvedCreate {
  definition: PackageDefinition;
  validation: PackageValidation;
}

/**
 * A new package's language version as code, before any call: on a cloud system ABAP for Cloud
 * Development, the only one there; elsewhere the call's, undefined for none (the superpackage's
 * then). A package's version is only the default of the objects created in it; what its software
 * component allows, SAP decides on create.
 */
function requestedPackageLanguageVersion(destination: Destination, requested: string | undefined): string | undefined {
  if (requested !== undefined && !Object.hasOwn(LANGUAGE_VERSION_CODES, requested)) {
    throw new Error(`unknown ABAP language version "${requested}"; use one of ${Object.keys(LANGUAGE_VERSION_CODES).join(', ')}`);
  }
  if (destination.kind === 'cloud') {
    if (requested && requested !== 'cloudDevelopment') {
      throw new Error(`adt+ system "${destination.id}" is a cloud system: new packages use language version "cloudDevelopment", not "${requested}"`);
    }
    return LANGUAGE_VERSION_CODES.cloudDevelopment;
  }
  return requested ? LANGUAGE_VERSION_CODES[requested as LanguageVersion] : undefined;
}

/**
 * Work out the full definition a create would send, and SAP's verdict on
 * it, without changing anything. Defaults from the super package: software
 * component, transport layer, change recording and, off a cloud system, the
 * language version. A software component neither names is refused: the
 * user picks it.
 */
async function resolveCreate(
  rest: RawAdtClient,
  destination: Destination,
  input: CreatePackageInput,
  lookupChain?: PackageChainLookup,
): Promise<ResolvedCreate> {
  const name = input.name.toUpperCase();
  const superPackageName = input.superPackage.toUpperCase();
  // A new package lands in its superpackage, so that is what the allowlist decides.
  await assertPackageWritable(destination, superPackageName, { lookupChain });
  const requestedVersion = requestedPackageLanguageVersion(destination, input.languageVersion);

  // The logged-on user, as ADT's new-package wizard proposes (ADR-018; AFF has no such field).
  const responsible = await ownUser(rest, destination);
  if (!responsible) throw new Error(`adt+ system "${destination.id}": the logon user is unknown here, so a new package has no responsible user`);

  const superPackage = await readPackageDefinition(rest, superPackageName);
  if (!superPackage) throw new Error(`super package "${superPackageName}" does not exist`);
  // Without the call's, the superpackage's: SAP can refuse a package in another component (TR458).
  const softwareComponent = input.softwareComponent || superPackage.softwareComponent;
  if (!softwareComponent) {
    throw new Error(
      `package ${name}: super package ${superPackageName} has no software component, so pass softwareComponent; ask the user which one`,
    );
  }

  const definition: PackageDefinition = {
    name,
    description: input.description,
    masterLanguage: '',
    responsible,
    packageType: 'development',
    recordChanges: input.recordChanges ?? superPackage.recordChanges,
    languageVersion: requestedVersion ?? superPackage.languageVersion,
    superPackage: superPackageName,
    applicationComponent: input.applicationComponent ?? '',
    softwareComponent,
    transportLayer: input.transportLayer ?? superPackage.transportLayer,
  };
  const validation = await validatePackage(rest, definition);
  return { definition, validation };
}

export async function validateCreatePackage(
  rest: RawAdtClient,
  destination: Destination,
  input: CreatePackageInput,
  native?: NativeSupport,
  lookupChain?: PackageChainLookup,
): Promise<ResolvedCreate & { valid: boolean } & FallbackMeta> {
  const resolved = await resolveCreate(rest, destination, input, lookupChain);
  return { ...resolved, valid: !isValidationFailure(resolved.validation), ...meta(native?.packageCreate) };
}

/**
 * Create a development package under an allowlisted package, then read it
 * back and refuse to report success unless the language version and
 * software component really are what was sent.
 */
export async function createPackage(
  rest: RawAdtClient,
  destination: Destination,
  input: CreatePackageInput,
  native?: NativeSupport,
  lookupChain?: PackageChainLookup,
): Promise<{ package: PackageDefinition; transport: string | null } & FallbackMeta> {
  const { definition, validation } = await resolveCreate(rest, destination, input, lookupChain);
  if (isValidationFailure(validation)) {
    throw new Error(`package ${definition.name} failed SAP validation (${validation.severity}): ${validation.shortText}`);
  }
  if (definition.recordChanges && !input.transport) {
    throw new Error(
      `package ${definition.name} records changes (inherited from ${definition.superPackage}) and needs a transport — ` +
        'pass "transport" (see adtplus_transport list/create)',
    );
  }

  await rest.expectOk('POST', PACKAGES_PATH, `create package ${definition.name}`, {
    query: { corrNr: input.transport ?? '' },
    headers: { 'Content-Type': PACKAGE_MEDIA_TYPE, Accept: PACKAGE_MEDIA_TYPE },
    body: buildPackageXml(definition),
  });

  const created = await readPackageDefinition(rest, definition.name);
  if (!created) throw new Error(`package ${definition.name}: create returned OK but the package cannot be read`);
  const mismatches: string[] = [];
  if (created.languageVersion !== definition.languageVersion) {
    mismatches.push(
      `language version is ${languageVersionName(created.languageVersion)}, expected ${languageVersionName(definition.languageVersion)}`,
    );
  }
  if (created.softwareComponent !== definition.softwareComponent) {
    mismatches.push(`software component is ${created.softwareComponent}, expected ${definition.softwareComponent}`);
  }
  if (mismatches.length) {
    throw new Error(`package ${definition.name} was created, but ${mismatches.join('; ')} — fix or delete it`);
  }
  return { package: created, transport: input.transport ?? null, ...meta(native?.packageCreate) };
}

/** The transport that already holds a lock on the package, if any. */
async function lockingTransport(adt: AdtLsClient, name: string): Promise<string | undefined> {
  const check = (await adt.transport
    .check({ name, objectType: 'DEVC/K', operation: 'MODIFY' })
    .catch(() => null)) as { locks?: { number?: string }[] } | null;
  return check?.locks?.find((l) => l.number)?.number;
}

interface LockResult {
  handle: string;
  corrNr: string;
}

async function lockPackage(rest: RawAdtClient, name: string, corrNr: string): Promise<LockResult> {
  const res = await rest.expectOk('POST', packageUri(name), `lock package ${name}`, {
    stateful: true,
    changesNothing: true,
    query: { _action: 'LOCK', accessMode: 'MODIFY', corrNr },
    headers: { Accept: LOCK_RESULT_MEDIA_TYPE },
  });
  const handle = res.body.match(/<LOCK_HANDLE>([\s\S]*?)<\/LOCK_HANDLE>/)?.[1]?.trim();
  if (!handle) throw new Error(`lock package ${name}: no LOCK_HANDLE in response`);
  return { handle, corrNr: res.body.match(/<CORRNR>([\s\S]*?)<\/CORRNR>/)?.[1]?.trim() ?? '' };
}

async function unlockPackage(rest: RawAdtClient, name: string, handle: string): Promise<void> {
  await rest
    .request('POST', packageUri(name), { stateful: true, changesNothing: true, query: { _action: 'UNLOCK', lockHandle: handle } })
    .catch(() => undefined);
}

/** S_ABPLNGVS is the tell-tale for a language-version/authorization mismatch. */
function explainLockError(err: unknown): never {
  if (err instanceof RawAdtError && /S_ABPLNGVS/.test(err.message)) {
    throw new Error(
      `${err.message} — this user may not change packages of this ABAP language version; ` +
        'adt+ cannot work around it (needs an authorization or a package with the right language version)',
    );
  }
  throw err;
}

/**
 * Read a package that is about to be edited or deleted, refusing unless its
 * superpackage — where the package itself lives — is writable. An allowlist
 * root therefore stays untouchable unless its own parent is listed.
 */
async function readManaged(
  adt: AdtLsClient,
  rest: RawAdtClient,
  destination: Destination,
  name: string,
): Promise<PackageDefinition> {
  const current = await readPackageDefinition(rest, name.toUpperCase());
  if (!current) throw new Error(`package "${name.toUpperCase()}" does not exist`);
  await assertPackageWritable(destination, current.superPackage, { lookupChain: lookupPackageChain(adt) });
  return current;
}

export interface EditPackageInput {
  name: string;
  description?: string;
  applicationComponent?: string;
  transport?: string;
}

/**
 * Change a package's description / application component. Read-merge-write:
 * the PUT is a full replace, so every other field — language version and
 * change recording included — is re-sent as read.
 */
export async function editPackage(
  adt: AdtLsClient,
  rest: RawAdtClient,
  destination: Destination,
  input: EditPackageInput,
  native?: NativeSupport,
): Promise<{ package: PackageDefinition; transport: string | null } & FallbackMeta> {
  if (input.description === undefined && input.applicationComponent === undefined) {
    throw new Error('package edit needs "description" and/or "applicationComponent"');
  }
  const current = await readManaged(adt, rest, destination, input.name);
  const wanted: PackageDefinition = {
    ...current,
    description: input.description ?? current.description,
    applicationComponent: input.applicationComponent ?? current.applicationComponent,
  };
  const requestedCorrNr = input.transport ?? (await lockingTransport(adt, current.name)) ?? '';

  const transport = await rest
    .stateful(async () => {
      const lock = await lockPackage(rest, current.name, requestedCorrNr);
      const corrNr = requestedCorrNr || lock.corrNr;
      try {
        await rest.expectOk('PUT', packageUri(current.name), `update package ${current.name}`, {
          stateful: true,
          query: { lockHandle: lock.handle, corrNr },
          headers: { 'Content-Type': PACKAGE_MEDIA_TYPE, Accept: PACKAGE_MEDIA_TYPE },
          body: buildPackageXml(wanted),
        });
      } finally {
        // A successful PUT still leaves the package checked out.
        await unlockPackage(rest, current.name, lock.handle);
      }
      return corrNr;
    })
    .catch(explainLockError);

  const after = await readPackageDefinition(rest, current.name);
  if (
    !after ||
    after.description !== wanted.description ||
    after.applicationComponent !== wanted.applicationComponent
  ) {
    throw new Error(`package ${current.name}: update returned OK but the change is not visible on read-back`);
  }
  return { package: after, transport: transport || null, ...meta(native?.packageCreate) };
}

export interface DeletePackageInput {
  name: string;
  transport?: string;
  confirm?: boolean;
}

/** Delete an (empty) package; SAP itself refuses a non-empty one. */
export async function deletePackage(
  adt: AdtLsClient,
  rest: RawAdtClient,
  destination: Destination,
  input: DeletePackageInput,
  native?: NativeSupport,
): Promise<{ name: string; deleted: true; transport: string | null } & FallbackMeta> {
  assertConfirmed('package delete', input.confirm);
  const current = await readManaged(adt, rest, destination, input.name);
  const requestedCorrNr = input.transport ?? (await lockingTransport(adt, current.name)) ?? '';

  const transport = await rest
    .stateful(async () => {
      const lock = await lockPackage(rest, current.name, requestedCorrNr);
      const corrNr = requestedCorrNr || lock.corrNr;
      try {
        await rest.expectOk('DELETE', packageUri(current.name), `delete package ${current.name}`, {
          stateful: true,
          query: { lockHandle: lock.handle, corrNr },
        });
      } catch (err) {
        await unlockPackage(rest, current.name, lock.handle);
        throw err;
      }
      return corrNr;
    })
    .catch(explainLockError);

  if (await readPackageDefinition(rest, current.name)) {
    throw new Error(`package ${current.name}: delete returned OK but the package is still readable`);
  }
  return { name: current.name, deleted: true, transport: transport || null, ...meta(native?.packageCreate) };
}
