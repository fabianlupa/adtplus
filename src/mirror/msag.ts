import type { RawAdtClient } from '../backends/rawadt.js';
import { MAX_DESCRIPTION_LENGTH, MAX_TEXT_LENGTH, readMaster, type MessageClass } from '../capabilities/messageclass.js';
import { messageClassProperties } from '../capabilities/properties.js';
import { affName, objectId } from './layout.js';
import type { WalkedObject } from './walk.js';

/**
 * Message classes in a mirror (docs/decisions/014-message-classes-in-the-mirror.md): adt-ls serves
 * them as a `.msagn.jsonc` stub, so the mirror reads and writes them over REST
 * (`capabilities/messageclass.ts`) as AFF's `<name>.msag.json` (`msag-v1`). REST fallback (ADR-002)
 * until adt-ls serves the file itself.
 */

/** The type adt-ls's stub file names (`zx.msagn.jsonc`). */
const STUB_TYPE = 'MSAGN';
export const MSAG_TYPE = 'MSAG';

/** `ZX` → `zx.msag.json`. */
export function msagFileName(name: string): string {
  return `${affName(name).toLowerCase()}.msag.json`;
}

/** A walked stub becomes the mirror's `MSAG <name>` with its one `.msag.json`; any other object stays as it is. */
export function asMessageClass(o: WalkedObject): WalkedObject {
  if (o.type !== STUB_TYPE) return o;
  return { ...o, id: objectId(MSAG_TYPE, o.name), type: MSAG_TYPE, files: [msagFileName(o.name)] };
}

/** The `MSAG <name>` a stub's manifest id (`MSAGN <name>`) is replaced by; undefined for any other id, a move's `(was …)` entry too. */
export function replacedStub(id: string): string | undefined {
  return id.startsWith(`${STUB_TYPE} `) && !id.includes(' (was ') ? objectId(MSAG_TYPE, id.slice(STUB_TYPE.length + 1)) : undefined;
}

/** The class as AFF `msag-v1` (its `properties`): messages by number, two-space JSON, as AFF's example. */
export function renderMsag(mc: Pick<MessageClass, 'description' | 'masterLanguage' | 'messages'>): string {
  return `${JSON.stringify(messageClassProperties(mc), null, 2)}\n`;
}

/** What a `.msag.json` holds. */
export interface MsagFile {
  description: string;
  /** Upper case, as SAP names it: `EN`. */
  originalLanguage: string;
  messages: Array<{ number: string; text: string }>;
}

const CONTROL = /[\u0000-\u001f]/;

/**
 * A `.msag.json` read and checked against what SAP stores: `msag-v1`'s fields only (a field SAP
 * has no place for would be dropped without a word), three-digit numbers once each, the lengths
 * counted in characters, no line break (XML attribute normalization would store a blank). A
 * string is the reason it can't be sent.
 */
export function parseMsag(text: string): MsagFile | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return `not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const extra = (o: Record<string, unknown>, keys: string[], where: string) => {
    const unknown = Object.keys(o).filter((k) => !keys.includes(k));
    return unknown.length > 0 ? `${where} has ${unknown.map((k) => `"${k}"`).join(', ')}, which msag-v1 doesn't know` : undefined;
  };
  if (!isObject(json)) return 'not a JSON object';
  const top = extra(json, ['formatVersion', 'header', 'messages'], 'the file');
  if (top) return top;
  if (json.formatVersion !== '1') return 'formatVersion is not "1"';
  const header = json.header;
  if (!isObject(header)) return 'no header';
  const head = extra(header, ['description', 'originalLanguage'], 'header');
  if (head) return head;
  const { description, originalLanguage } = header;
  if (typeof description !== 'string') return 'header.description is not a string';
  const length = [...description].length;
  if (length > MAX_DESCRIPTION_LENGTH) return `header.description has ${length} characters, SAP takes at most ${MAX_DESCRIPTION_LENGTH}`;
  if (CONTROL.test(description)) return 'header.description has a line break or control character';
  if (typeof originalLanguage !== 'string' || !/^[a-z]{2}$/i.test(originalLanguage)) return 'header.originalLanguage is not a language like "en"';
  if (!Array.isArray(json.messages)) return 'messages is not a list';
  const messages: MsagFile['messages'] = [];
  const seen = new Set<string>();
  for (const [i, m] of json.messages.entries()) {
    if (!isObject(m)) return `messages[${i}] is not an object`;
    const more = extra(m, ['number', 'text'], `messages[${i}]`);
    if (more) return more;
    const { number, text: msg } = m;
    if (typeof number !== 'string' || !/^\d{3}$/.test(number)) return `messages[${i}].number is not three digits like "001"`;
    if (seen.has(number)) return `message ${number} is in the file twice`;
    seen.add(number);
    if (typeof msg !== 'string') return `message ${number}: text is not a string`;
    const chars = [...msg].length;
    if (chars > MAX_TEXT_LENGTH) return `message ${number}: the text has ${chars} characters, SAP takes at most ${MAX_TEXT_LENGTH}`;
    if (CONTROL.test(msg)) return `message ${number}: the text has a line break or control character`;
    messages.push({ number, text: msg });
  }
  return { description, originalLanguage: originalLanguage.toUpperCase(), messages };
}

/** What a push sends to make the system hold `local`. */
export interface MsagChanges {
  /** The new description, when it changed. */
  description?: string;
  /** New and changed messages. */
  messages: Array<{ number: string; text: string }>;
  /** Messages the system has and the file doesn't: never deleted by a push (ADR-014). */
  removed: string[];
}

/** SAP's text fields are CHAR: trailing blanks are not stored. */
const same = (a: string, b: string) => a.trimEnd() === b.trimEnd();

export function msagChanges(current: Pick<MessageClass, 'description' | 'messages'>, local: MsagFile): MsagChanges {
  const before = new Map(current.messages.map((m) => [m.number, m.text]));
  const wanted = new Set(local.messages.map((m) => m.number));
  return {
    ...(same(current.description, local.description) ? {} : { description: local.description }),
    messages: local.messages.filter((m) => !before.has(m.number) || !same(before.get(m.number)!, m.text)),
    removed: current.messages.map((m) => m.number).filter((n) => !wanted.has(n)),
  };
}

/**
 * The class's `.msag.json` as the system has it now, and its package; undefined when the class
 * doesn't exist. Read in the master language: a GET answers in the logon language where a
 * translation exists, and a push writes the master language.
 */
export async function readMsag(rest: RawAdtClient, name: string): Promise<{ text: string; package: string; messageClass: MessageClass; requests: number } | undefined> {
  const read = await readMaster(rest, name);
  if (!read) return undefined;
  const mc = read.messageClass;
  return { text: renderMsag(mc), package: mc.package.toUpperCase(), messageClass: mc, requests: read.requests };
}
