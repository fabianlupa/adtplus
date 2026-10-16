import { RawAdtError, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import type { Destination } from '../core/destinations.js';
import type { PackageChainLookup } from '../core/placement.js';
import { logonLanguage } from '../core/session.js';
import { assertConfirmed, assertPackageWritable } from './policy.js';
import type { RestActivationObject } from './rest-activation.js';
import { assertRecordable, validationMessage, writeLocked } from './rest-lock.js';

// --- REST fallback: the lifecycle of a form-based DDIC object ---------------------------------
//
// ADT serves a domain and a data element the same way, each under its own path and media type:
//   GET    {path}/{name}       → the inactive version if there is one, else the active
//   POST   {path}/validation?objname=&description=&packagename=   200: ok; 400: SAP's reason
//   POST   {path}?corrNr=      → create, never active (`new`), with its whole content
//   lock → PUT {uri}?lockHandle=&corrNr= → unlock  (rest-lock.ts): replaces the whole object;
//          the result is inactive.
//   lock → DELETE {uri}?lockHandle=&corrNr= → unlock
// A read answers the texts in the master language whatever the logon language; a create naming
// another master language than the session's leaves the texts inconsistent, so a create is in the
// logon language and a write sends the master language. What is particular to one type is its
// kind's (domain.ts, dataelement.ts).

/** The short text (DD01T, DD04T): AFF `header.description`. */
export const MAX_DESCRIPTION_LENGTH = 60;

/** What every form-based object has besides its content. */
export interface FormObject {
  name: string;
  description: string;
  package: string;
  /** The language the texts are written in; a write sends it back. */
  masterLanguage: string;
  /** AFF's names: `standard`, `keyUser`, `cloudDevelopment`. */
  abapLanguageVersion: string;
  /** `active`, `inactive`, or `new` (never activated). */
  version: string;
}

/** A new object's content: a create gives its name, package and description, the content the rest. */
export type FormObjectContent<T extends FormObject> = Omit<T, keyof FormObject>;

type NativeFlag = { [K in keyof NativeSupport]: NativeSupport[K] extends boolean ? K : never }[keyof NativeSupport];

/** One form-based type: where ADT serves it, its XML, and what SAP refuses or changes of it. */
export interface FormObjectKind<T extends FormObject> {
  /** The type as SAP's activation messages name it and `formType` routes it: `DOMA` (an AFF schema in properties.ts's FORM_TYPES). */
  type: string;
  /** In messages: `domain`. */
  kind: string;
  /** In a refusal naming several types: `domains`. */
  plural: string;
  path: string;
  mediaType: string;
  /** The `NativeSupport` flag that says this system offers the type natively. */
  native: NativeFlag;
  parse: (xml: string) => T;
  build: (object: T, options?: { create?: boolean }) => string;
  /** What SAP stores that a write can't have sent as it was (trailing blanks of CHAR fields), as a read-back compares it. */
  stored: (object: T) => Record<string, unknown>;
  /** What SAP's activation would refuse and a PUT stores anyway, refused before any call; with `current`, only what the write changes. */
  check?: (object: T, current?: T) => void;
  /** Refuses an update of `current` that the whole-object PUT would damage. */
  refuseUpdate?: (current: T) => void;
  /** SAP's create doesn't store every field as sent: a PUT follows when the read-back differs. */
  rewriteAfterCreate?: boolean;
}

/** A kind's names and place, whatever its object type. */
export type KindName = Pick<FormObjectKind<FormObject>, 'type' | 'kind' | 'plural' | 'path' | 'native'>;

interface FallbackMeta {
  via: 'rest-fallback';
  /** true once this system offers the type natively: the fallback is retirable. */
  nativeAvailable: boolean | null;
}

function meta(kind: KindName, native: NativeSupport | undefined): FallbackMeta {
  return { via: 'rest-fallback', nativeAvailable: native?.[kind.native] ?? null };
}

export function formObjectUri(kind: KindName, name: string): string {
  return `${kind.path}/${encodeURIComponent(name.toLowerCase())}`;
}

/** GET the object: its inactive version if it has one, else the active; `undefined` on 404. */
export async function readFormObject<T extends FormObject>(kind: FormObjectKind<T>, rest: RawAdtClient, name: string): Promise<T | undefined> {
  const res = await rest.request('GET', formObjectUri(kind, name), { headers: { Accept: kind.mediaType } });
  if (res.status === 404) return undefined;
  if (res.status >= 400) throw new RawAdtError(res.status, undefined, res.body.slice(0, 300), `read ${kind.kind} ${name.toUpperCase()}`);
  return kind.parse(res.body);
}

async function readExisting<T extends FormObject>(kind: FormObjectKind<T>, rest: RawAdtClient, name: string): Promise<T> {
  const object = await readFormObject(kind, rest, name);
  if (!object) throw new Error(`${kind.kind} "${name.toUpperCase()}" does not exist`);
  return object;
}

export async function readFormObjectDefinition<T extends FormObject>(
  kind: FormObjectKind<T>,
  rest: RawAdtClient,
  name: string,
  native?: NativeSupport,
): Promise<{ object: T } & FallbackMeta> {
  return { object: await readExisting(kind, rest, name), ...meta(kind, native) };
}

/** The fields a read-back has other than the write sent: empty when SAP stored it as sent. */
function differences<T extends FormObject>(kind: FormObjectKind<T>, sent: T, after: T): string[] {
  const a = { description: sent.description.trimEnd(), ...kind.stored(sent) };
  const b = { description: after.description.trimEnd(), ...kind.stored(after) };
  return Object.keys(a).filter((k) => JSON.stringify(a[k as keyof typeof a]) !== JSON.stringify(b[k as keyof typeof b]));
}

function check<T extends FormObject>(kind: FormObjectKind<T>, object: T, current?: T): void {
  const length = [...object.description].length;
  if (length > MAX_DESCRIPTION_LENGTH) throw new Error(`the description has ${length} characters, SAP takes at most ${MAX_DESCRIPTION_LENGTH}`);
  kind.check?.(object, current);
}

/** A PUT of the whole object under a lock; returns the request it went to. */
function put<T extends FormObject>(kind: FormObjectKind<T>, rest: RawAdtClient, object: T, transport: string | undefined, action: string): Promise<string> {
  const uri = formObjectUri(kind, object.name);
  return writeLocked(rest, { kind: kind.kind, name: object.name, uri, package: object.package }, transport, (lockHandle, corrNr) =>
    rest.expectOk('PUT', uri, action, {
      stateful: true,
      query: { lockHandle, corrNr },
      headers: { 'Content-Type': kind.mediaType, Accept: kind.mediaType },
      body: kind.build(object),
    }),
  );
}

export interface CreateFormObjectInput<T extends FormObject> {
  name: string;
  packageName: string;
  description: string;
  content: FormObjectContent<T>;
  transport?: string;
}

/**
 * Create the object, never activated, in an allowlisted package, after SAP's own name check, and
 * read it back. Its texts are in the logon language; its ABAP language version is the system's
 * (`languageVersion` in systems.json), sent when not standard.
 */
export async function createFormObject<T extends FormObject>(
  kind: FormObjectKind<T>,
  rest: RawAdtClient,
  destination: Destination,
  input: CreateFormObjectInput<T>,
  lookupChain: PackageChainLookup,
  native?: NativeSupport,
): Promise<{ object: T; transport: string | null } & FallbackMeta> {
  const name = input.name.toUpperCase();
  const pkg = input.packageName.toUpperCase();
  const object = {
    ...input.content,
    name,
    description: input.description,
    package: pkg,
    masterLanguage: logonLanguage(destination),
    abapLanguageVersion: destination.languageVersion ?? 'standard',
    version: 'new',
  } as T;
  check(kind, object);
  await assertPackageWritable(destination, pkg, { lookupChain });
  if (!input.transport) await assertRecordable(rest, pkg, kind.kind, `${kind.kind} ${name} not created`);
  const validation = await rest.request('POST', `${kind.path}/validation`, {
    changesNothing: true,
    query: { objname: name, description: input.description, packagename: pkg },
    headers: { Accept: 'application/vnd.sap.as+xml, application/xml' },
  });
  if (validation.status >= 400) {
    throw new RawAdtError(validation.status, undefined, validationMessage(validation.body), `create ${kind.kind} ${name}`);
  }
  await rest.expectOk('POST', kind.path, `create ${kind.kind} ${name}`, {
    query: { corrNr: input.transport ?? '' },
    headers: { 'Content-Type': kind.mediaType, Accept: kind.mediaType },
    body: kind.build(object, { create: true }),
  });
  let created = await readFormObject(kind, rest, name);
  if (!created) throw new Error(`${kind.kind} ${name}: create returned OK but the ${kind.kind} cannot be read`);
  if (kind.rewriteAfterCreate && differences(kind, object, created).length > 0) {
    await put(kind, rest, { ...object, masterLanguage: created.masterLanguage }, input.transport, `create ${kind.kind} ${name}: its content`).catch((err: unknown) => {
      throw new Error(`${kind.kind} ${name} was created, but its content was not written as sent: ${err instanceof Error ? err.message : String(err)}`);
    });
    created = await readExisting(kind, rest, name);
  }
  const off = differences(kind, object, created);
  if (off.length > 0) throw new Error(`${kind.kind} ${name}: create returned OK but ${off.join(', ')} not as sent on read-back`);
  return { object: created, transport: input.transport ?? null, ...meta(kind, native) };
}

export interface UpdateFormObjectInput<T extends FormObject> {
  name: string;
  /** The object as it should be, from the current one (`domainUpdate`, `dataElementUpdate`). */
  change: (current: T) => T;
  transport?: string;
}

/**
 * Write the object `change` makes of the current one: one lock → PUT → unlock, which replaces the
 * whole object, then a read-back. The result is the inactive version; `activate` activates it.
 */
export async function updateFormObject<T extends FormObject>(
  kind: FormObjectKind<T>,
  rest: RawAdtClient,
  destination: Destination,
  input: UpdateFormObjectInput<T>,
  lookupChain: PackageChainLookup,
  native?: NativeSupport,
): Promise<{ object: T; previous: T; transport: string | null } & FallbackMeta> {
  const current = await readExisting(kind, rest, input.name);
  await assertPackageWritable(destination, current.package, { lookupChain });
  kind.refuseUpdate?.(current);
  const next = input.change(current);
  check(kind, next, current);
  const transport = await put(kind, rest, next, input.transport, `update ${kind.kind} ${current.name}`);
  const after = await readExisting(kind, rest, current.name);
  const off = differences(kind, next, after);
  if (off.length > 0) throw new Error(`${kind.kind} ${current.name}: update returned OK but ${off.join(', ')} not as sent on read-back`);
  return { object: after, previous: current, transport: transport || null, ...meta(kind, native) };
}

/** Read and gate each object of an activation batch: one outside the allowlist refuses the whole batch. */
export async function gateFormObjects<T extends FormObject>(
  kind: FormObjectKind<T>,
  rest: RawAdtClient,
  destination: Destination,
  names: string[],
  lookupChain: PackageChainLookup,
): Promise<RestActivationObject[]> {
  const objects = await Promise.all(names.map((n) => readExisting(kind, rest, n)));
  for (const o of objects) await assertPackageWritable(destination, o.package, { lookupChain });
  return objects.map((o) => ({
    uri: formObjectUri(kind, o.name),
    name: o.name,
    object: `${kind.type} ${o.name}`,
    version: async (r) => (await readFormObject(kind, r, o.name))?.version,
  }));
}

export interface DeleteFormObjectInput {
  name: string;
  transport?: string;
  confirm?: boolean;
}

export async function deleteFormObject<T extends FormObject>(
  kind: FormObjectKind<T>,
  rest: RawAdtClient,
  destination: Destination,
  input: DeleteFormObjectInput,
  lookupChain: PackageChainLookup,
  native?: NativeSupport,
): Promise<{ name: string; deleted: true; transport: string | null } & FallbackMeta> {
  assertConfirmed('object delete', input.confirm);
  const current = await readExisting(kind, rest, input.name);
  await assertPackageWritable(destination, current.package, { lookupChain });
  const uri = formObjectUri(kind, current.name);
  const transport = await writeLocked(rest, { kind: kind.kind, name: current.name, uri, package: current.package }, input.transport, (lockHandle, corrNr) =>
    rest.expectOk('DELETE', uri, `delete ${kind.kind} ${current.name}`, { stateful: true, query: { lockHandle, corrNr } }),
  );
  if (await readFormObject(kind, rest, current.name)) throw new Error(`${kind.kind} ${current.name}: delete returned OK but the ${kind.kind} is still readable`);
  return { name: current.name, deleted: true, transport: transport || null, ...meta(kind, native) };
}
