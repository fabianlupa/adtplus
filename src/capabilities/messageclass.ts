import { escapeXml, RawAdtError, startTags, xmlAttr, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import type { Destination } from '../core/destinations.js';
import type { PackageChainLookup } from '../core/placement.js';
import { logonLanguage } from '../core/session.js';
import { matchingLines } from './object.js';
import { newObjectLanguageVersion } from './package.js';
import { assertConfirmed, assertPackageWritable } from './policy.js';
import { assertRecordable, validationMessage, writeLocked, type LockedObject } from './rest-lock.js';

// --- REST fallback ---------------------------------------------------------
//
// adt-ls 1.1.2 serves a message class as a placeholder and refuses to write or delete it
// ("Object type not supported: MSAG/N"), though it bundles SAP's Eclipse plug-in.
// Wire protocol, verified on `onprem`:
//   GET    /sap/bc/adt/messageclass/{name}        → header and every message
//   POST   /sap/bc/adt/messageclass/validation?objname=&description=   200 empty: ok; 400: SAP's reason
//   POST   /sap/bc/adt/messageclass?corrNr=       → create
//   POST   {uri}?_action=LOCK&accessMode=MODIFY&corrNr=   (answers the class's request in CORRNR)
//   PUT    {uri}?lockHandle=&corrNr=              → an upsert: messages it leaves out stay;
//          `mc:deletedmessages` entries delete. Then always UNLOCK.
//   DELETE {uri}?lockHandle=&corrNr=
// A message class has no inactive version: every write is live at once. SAP checks little: an
// over-long text fails with a deserialization error naming no field, deleting a message that
// doesn't exist answers 200, and a write to a class in no open request goes through unrecorded
// even where the package records changes. All three are checked here before sending.
// A GET answers in the logon language, falling back to the master language per message; a PUT
// writes the language its body names, the master language. So reads that a write builds on or
// verifies are made in the master language.

const PATH = '/sap/bc/adt/messageclass';
const MEDIA_TYPE = 'application/vnd.sap.adt.mc.messageclass+xml';

/** T100's text field (`NATXT`). */
export const MAX_TEXT_LENGTH = 73;

/** T100A's short text: SAP cuts a longer description without a word. */
export const MAX_DESCRIPTION_LENGTH = 60;

function checkDescription(description: string | undefined): void {
  const length = description === undefined ? 0 : [...description].length;
  if (length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`the description has ${length} characters, SAP takes at most ${MAX_DESCRIPTION_LENGTH}`);
  }
}

/** The object types that name a message class. */
export function isMessageClassType(objectType: string): boolean {
  return /^MSAG(\/N)?$/i.test(objectType.trim());
}

export interface Message {
  /** Three digits, `000`–`999`. */
  number: string;
  text: string;
  /** Needs no long text. */
  selfExplanatory: boolean;
}

export interface MessageClass {
  name: string;
  description: string;
  package: string;
  /** The language the texts are written in; a write sends it back. */
  masterLanguage: string;
  /** The language the texts were read in: the master language for every read here. */
  language: string;
  messages: Message[];
}

interface FallbackMeta {
  via: 'rest-fallback';
  /** true once this system offers message classes natively — the fallback is retirable. */
  nativeAvailable: boolean | null;
}

function meta(native: NativeSupport | undefined): FallbackMeta {
  return { via: 'rest-fallback', nativeAvailable: native?.messageClass ?? null };
}

export function messageClassUri(name: string): string {
  return `${PATH}/${encodeURIComponent(name.toLowerCase())}`;
}

/** `7`, `"7"`, `"007"` → `"007"`; anything but a whole number 0–999 is refused. */
export function messageNumber(value: string | number): string {
  const text = String(value).trim();
  if (!/^\d{1,3}$/.test(text)) throw new Error(`message number "${value}" is not a number from 000 to 999`);
  return text.padStart(3, '0');
}

const attr = xmlAttr;
const tag = startTags;

export function parseMessageClassXml(xml: string): MessageClass {
  const head = xml.match(tag('mc:messageClass'))?.[0];
  const name = head && attr(head, 'adtcore:name');
  if (!head || !name) throw new Error('not a mc:messageClass representation');
  const packageRef = xml.match(tag('adtcore:packageRef'))?.[0] ?? '';
  const messages = [...xml.matchAll(tag('mc:messages'))].map(([t]) => ({
    number: attr(t, 'mc:msgno') ?? '',
    text: attr(t, 'mc:msgtext') ?? '',
    selfExplanatory: attr(t, 'mc:selfexplainatory') === 'true',
  }));
  return {
    name,
    description: attr(head, 'adtcore:description') ?? '',
    package: attr(packageRef, 'adtcore:name') ?? '',
    masterLanguage: attr(head, 'adtcore:masterLanguage') ?? '',
    language: attr(head, 'adtcore:language') ?? '',
    messages,
  };
}

export interface MessageClassBody {
  name: string;
  description: string;
  package: string;
  masterLanguage: string;
  /** A message without `selfExplanatory` leaves the flag to SAP. */
  messages?: Array<{ number: string; text: string; selfExplanatory?: boolean }>;
  deleted?: string[];
  /** `cloudDevelopment` etc.; sent only on a create, and only when not standard. */
  abapLanguageVersion?: string;
}

export function buildMessageClassXml(b: MessageClassBody): string {
  const e = escapeXml;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core"' +
    ` adtcore:name="${e(b.name)}" adtcore:type="MSAG/N" adtcore:description="${e(b.description)}"` +
    ` adtcore:masterLanguage="${e(b.masterLanguage)}" adtcore:language="${e(b.masterLanguage)}"` +
    (b.abapLanguageVersion ? ` adtcore:abapLanguageVersion="${e(b.abapLanguageVersion)}"` : '') +
    '>' +
    `<adtcore:packageRef adtcore:name="${e(b.package)}"/>` +
    (b.messages ?? [])
      .map(
        (m) =>
          `<mc:messages mc:msgno="${e(m.number)}" mc:msgtext="${e(m.text)}"` +
          (m.selfExplanatory === undefined ? '' : ` mc:selfexplainatory="${m.selfExplanatory}"`) +
          '/>',
      )
      .join('') +
    (b.deleted ?? []).map((n) => `<mc:deletedmessages mc:msgno="${e(n)}"/>`).join('') +
    '</mc:messageClass>'
  );
}

/** GET the message class, in `language` if given; `undefined` on 404. */
export async function readMessageClassDefinition(rest: RawAdtClient, name: string, language?: string): Promise<MessageClass | undefined> {
  const res = await rest.request('GET', messageClassUri(name), { headers: { Accept: MEDIA_TYPE }, ...(language ? { language } : {}) });
  if (res.status === 404) return undefined;
  if (res.status >= 400) throw new RawAdtError(res.status, undefined, res.body.slice(0, 300), `read message class ${name}`);
  return parseMessageClassXml(res.body);
}

/** The class in its master language: read again when the logon language is another, or read in `masterLanguage` when it is known. */
/** The class in its master language with the requests it took (1, or 2 when the first answered in another); undefined when it doesn't exist. */
export async function readMaster(
  rest: RawAdtClient,
  name: string,
  masterLanguage?: string,
): Promise<{ messageClass: MessageClass; requests: number } | undefined> {
  const current = await readMessageClassDefinition(rest, name.toUpperCase(), masterLanguage || undefined);
  if (!current) return undefined;
  if (!current.masterLanguage || current.language === current.masterLanguage) return { messageClass: current, requests: 1 };
  const master = await readMessageClassDefinition(rest, current.name, current.masterLanguage);
  return master ? { messageClass: master, requests: 2 } : undefined;
}

export async function readInMasterLanguage(rest: RawAdtClient, name: string, masterLanguage?: string): Promise<MessageClass> {
  const read = await readMaster(rest, name, masterLanguage);
  if (!read) throw new Error(`message class "${name.toUpperCase()}" does not exist`);
  return read.messageClass;
}

export interface ReadMessagesInput {
  name: string;
  /** Only the messages whose number or text matches this regex (case-insensitive). */
  grep?: string;
}

export type ReadMessagesResult = MessageClass & { totalMessages: number } & FallbackMeta;

export async function readMessages(rest: RawAdtClient, input: ReadMessagesInput, native?: NativeSupport): Promise<ReadMessagesResult> {
  const mc = await readInMasterLanguage(rest, input.name);
  const messages =
    input.grep === undefined
      ? mc.messages
      : (() => {
          const hits = new Set(matchingLines(mc.messages.map((m) => `${m.number} ${m.text}`), input.grep));
          return mc.messages.filter((_, i) => hits.has(i));
        })();
  return { ...mc, messages, totalMessages: mc.messages.length, ...meta(native) };
}

export interface CreateMessageClassInput {
  name: string;
  packageName: string;
  description: string;
  transport?: string;
}

/**
 * Create an empty message class in an allowlisted package, after SAP's own name check, and read
 * it back. The texts' language is the logon language; the ABAP language version is its package's
 * default, on a cloud system ABAP for Cloud Development (`newObjectLanguageVersion`), sent when
 * not standard.
 */
export async function createMessageClass(
  rest: RawAdtClient,
  destination: Destination,
  input: CreateMessageClassInput,
  lookupChain: PackageChainLookup,
  native?: NativeSupport,
): Promise<{ messageClass: MessageClass; transport: string | null } & FallbackMeta> {
  const name = input.name.toUpperCase();
  checkDescription(input.description);
  const pkg = input.packageName.toUpperCase();
  await assertPackageWritable(destination, pkg, { lookupChain });
  const read = input.transport ? undefined : await assertRecordable(rest, pkg, 'message class', `message class ${name} not created`);
  const validation = await rest.request('POST', `${PATH}/validation`, {
    changesNothing: true,
    query: { objname: name, description: input.description, packagename: pkg },
    headers: { Accept: 'application/vnd.sap.as+xml, application/xml' },
  });
  if (validation.status >= 400) {
    throw new RawAdtError(validation.status, undefined, validationMessage(validation.body), `create message class ${name}`);
  }
  const languageVersion = await newObjectLanguageVersion(rest, destination, pkg, read);
  await rest.expectOk('POST', PATH, `create message class ${name}`, {
    query: { corrNr: input.transport ?? '' },
    headers: { 'Content-Type': MEDIA_TYPE, Accept: MEDIA_TYPE },
    body: buildMessageClassXml({
      name,
      description: input.description,
      package: pkg,
      masterLanguage: logonLanguage(destination),
      ...(languageVersion !== 'standard' ? { abapLanguageVersion: languageVersion } : {}),
    }),
  });
  const created = await readMessageClassDefinition(rest, name);
  if (!created) throw new Error(`message class ${name}: create returned OK but the message class cannot be read`);
  return { messageClass: created, transport: input.transport ?? null, ...meta(native) };
}


/** The class as `writeLocked` locks it. */
function locked(mc: Pick<MessageClass, 'name' | 'package'>): LockedObject {
  return { kind: 'message class', name: mc.name, uri: messageClassUri(mc.name), package: mc.package };
}

export interface MessageInput {
  number: string | number;
  text: string;
  selfExplanatory?: boolean;
}

/**
 * A PUT that changes the description is recorded as `LIMU MESS <class>`, without a message number,
 * and SAP's object directory then holds a message class named the class without its last three
 * characters, in the same package (`onprem`: three classes).
 * Messages alone, and a create's description, are recorded right. Refused until a path that
 * records it right is known.
 */
export function descriptionRefusal(name: string): Error {
  return new Error(
    `message class ${name}: changing the description is refused: SAP records it in the request without a message ` +
      `number (LIMU MESS ${name}) and leaves a phantom message class ${name.slice(0, -3)} in the package. ` +
      'Change it outside adt+',
  );
}

/** Messages as SAP would store them, or why not: numbers, texts, each number once. No SAP call. */
export function checkMessages(messages: MessageInput[]): Array<{ number: string; text: string; selfExplanatory?: boolean }> {
  const wanted = messages.map((m) => {
    const number = messageNumber(m.number);
    if (typeof m.text !== 'string') throw new Error(`message ${number}: "text" is missing`);
    const length = [...m.text].length;
    if (length > MAX_TEXT_LENGTH) {
      throw new Error(`message ${number}: the text has ${length} characters, SAP takes at most ${MAX_TEXT_LENGTH}`);
    }
    // A line break or tab doesn't survive XML attribute normalization: SAP would store another text.
    if (/[\u0000-\u001f]/.test(m.text)) throw new Error(`message ${number}: the text has a line break or control character`);
    return { number, text: m.text, selfExplanatory: m.selfExplanatory };
  });
  const twice = wanted.map((m) => m.number).filter((n, i, all) => all.indexOf(n) !== i);
  if (twice.length > 0) throw new Error(`message ${twice[0]} is given twice`);
  return wanted;
}

export interface UpdateMessageClassInput {
  name: string;
  description?: string;
  messages?: MessageInput[];
  transport?: string;
}

export interface WrittenMessage extends Message {
  /** The message before the write; null for a new one. */
  previous: Omit<Message, 'number'> | null;
}

/**
 * Add or change messages; a changed description is refused (`descriptionRefusal`). Only the messages given are sent: SAP keeps
 * the others. A changed message keeps its self-explanatory flag unless one is given. Every
 * change is checked on a read-back.
 */
export async function updateMessageClass(
  rest: RawAdtClient,
  destination: Destination,
  input: UpdateMessageClassInput,
  lookupChain: PackageChainLookup,
  native?: NativeSupport,
): Promise<{ messageClass: string; description: string; messages: WrittenMessage[]; transport: string | null } & FallbackMeta> {
  const wanted = checkMessages(input.messages ?? []);
  checkDescription(input.description);
  if (wanted.length === 0 && input.description === undefined) {
    throw new Error('message class update needs "messages" and/or "description"');
  }

  const current = await readInMasterLanguage(rest, input.name);
  await assertPackageWritable(destination, current.package, { lookupChain });
  if (input.description !== undefined && input.description.trimEnd() !== current.description.trimEnd()) throw descriptionRefusal(current.name);
  const before = new Map(current.messages.map((m) => [m.number, m]));
  const messages = wanted.map((m) => ({ ...m, selfExplanatory: m.selfExplanatory ?? before.get(m.number)?.selfExplanatory }));
  const description = input.description ?? current.description;
  const body = buildMessageClassXml({ ...current, description, messages });

  const transport = await writeLocked(rest, locked(current), input.transport, (lockHandle, corrNr) =>
    rest.expectOk('PUT', messageClassUri(current.name), `update message class ${current.name}`, {
      stateful: true,
      query: { lockHandle, corrNr },
      headers: { 'Content-Type': MEDIA_TYPE, Accept: MEDIA_TYPE },
      body,
    }),
  );

  const after = await readInMasterLanguage(rest, current.name, current.masterLanguage);
  const stored = new Map(after.messages.map((m) => [m.number, m]));
  // SAP's text fields are CHAR: trailing blanks are not stored.
  const same = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  const off = messages.filter((m) => {
    const s = stored.get(m.number);
    return !s || !same(s.text, m.text) || (m.selfExplanatory !== undefined && s.selfExplanatory !== m.selfExplanatory);
  });
  const descriptionOff = !same(after.description, description);
  if (off.length > 0 || descriptionOff) {
    const what = [...off.map((m) => `message ${m.number}`), ...(descriptionOff ? ['the description'] : [])];
    throw new Error(`message class ${current.name}: update returned OK but ${what.join(', ')} not as sent on read-back`);
  }
  return {
    messageClass: current.name,
    description: after.description,
    messages: messages.map((m) => {
      const prev = before.get(m.number);
      return { ...stored.get(m.number)!, previous: prev ? { text: prev.text, selfExplanatory: prev.selfExplanatory } : null };
    }),
    transport: transport || null,
    ...meta(native),
  };
}

export interface DeleteMessagesInput {
  name: string;
  numbers: Array<string | number>;
  transport?: string;
  confirm?: boolean;
}

/** Delete messages; numbers the class doesn't have refuse the whole call, since SAP would answer OK. */
export async function deleteMessages(
  rest: RawAdtClient,
  destination: Destination,
  input: DeleteMessagesInput,
  lookupChain: PackageChainLookup,
  native?: NativeSupport,
): Promise<{ messageClass: string; deleted: Message[]; transport: string | null } & FallbackMeta> {
  assertConfirmed('message delete', input.confirm);
  const numbers = [...new Set((input.numbers ?? []).map(messageNumber))];
  if (numbers.length === 0) throw new Error('message delete needs "numbers"');
  const current = await readInMasterLanguage(rest, input.name);
  await assertPackageWritable(destination, current.package, { lookupChain });
  const before = new Map(current.messages.map((m) => [m.number, m]));
  const missing = numbers.filter((n) => !before.has(n));
  if (missing.length > 0) throw new Error(`message class ${current.name} has no message ${missing.join(', ')}; nothing deleted`);

  const transport = await writeLocked(rest, locked(current), input.transport, (lockHandle, corrNr) =>
    rest.expectOk('PUT', messageClassUri(current.name), `delete messages of ${current.name}`, {
      stateful: true,
      query: { lockHandle, corrNr },
      headers: { 'Content-Type': MEDIA_TYPE, Accept: MEDIA_TYPE },
      body: buildMessageClassXml({ ...current, messages: [], deleted: numbers }),
    }),
  );

  const after = await readInMasterLanguage(rest, current.name, current.masterLanguage);
  const left = after.messages.filter((m) => numbers.includes(m.number)).map((m) => m.number);
  if (left.length > 0) throw new Error(`message class ${current.name}: delete returned OK but message ${left.join(', ')} still there`);
  return { messageClass: current.name, deleted: numbers.map((n) => before.get(n)!), transport: transport || null, ...meta(native) };
}

export interface DeleteMessageClassInput {
  name: string;
  transport?: string;
  confirm?: boolean;
}

export async function deleteMessageClass(
  rest: RawAdtClient,
  destination: Destination,
  input: DeleteMessageClassInput,
  lookupChain: PackageChainLookup,
  native?: NativeSupport,
): Promise<{ messageClass: string; deleted: true; transport: string | null } & FallbackMeta> {
  assertConfirmed('object delete', input.confirm);
  const current = await readInMasterLanguage(rest, input.name);
  await assertPackageWritable(destination, current.package, { lookupChain });
  const transport = await writeLocked(rest, locked(current), input.transport, (lockHandle, corrNr) =>
    rest.expectOk('DELETE', messageClassUri(current.name), `delete message class ${current.name}`, {
      stateful: true,
      query: { lockHandle, corrNr },
    }),
  );
  if (await readMessageClassDefinition(rest, current.name)) {
    throw new Error(`message class ${current.name}: delete returned OK but the message class is still readable`);
  }
  return { messageClass: current.name, deleted: true, transport: transport || null, ...meta(native) };
}
