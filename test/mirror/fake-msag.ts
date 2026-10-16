import { RawAdtError, decodeXml, escapeXml, type RawAdtClient, type RequestOptions } from '../../src/backends/rawadt.js';
import { parseMessageClassXml } from '../../src/capabilities/messageclass.js';

/** One message class as the fake system holds it: texts per language, the master language's always there. */
export interface FakeClass {
  description: string;
  package: string;
  master: string;
  /** Number → language → text. */
  messages: Map<string, Map<string, string>>;
  /** Number → self-explanatory flag. */
  selfExplanatory: Map<string, boolean>;
}

/**
 * The message class REST API over an in-memory store:
 * a GET answers in the logon language with the master language as fallback per message, a PUT is
 * an upsert in the language its body names, `mc:deletedmessages` deletes, a lock names `request`.
 */
export function fakeMessageClasses(o: { logon?: string; recording?: string[] } = {}) {
  const logon = o.logon ?? 'EN';
  const classes = new Map<string, FakeClass>();
  const calls: Array<{ method: string; path: string; query?: Record<string, string> }> = [];
  const state = {
    classes,
    calls,
    /** Packages that record changes. */
    recording: new Set(o.recording ?? []),
    /** The request a lock names; '' for none. */
    request: 'DEVK900001',
    /** Throws on a PUT for which this returns an error message. */
    failPut: (_name: string): string | undefined => undefined,
    /** Answers a PUT with this error after storing it, as a write that went through and then failed. */
    failAfterPut: undefined as string | undefined,
  };

  const xmlOf = (name: string, c: FakeClass, language: string) =>
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<mc:messageClass adtcore:masterLanguage="${c.master}" adtcore:name="${name}" adtcore:type="MSAG/N" ` +
    `adtcore:changedAt="2026-10-10T13:51:34Z" adtcore:description="${escapeXml(c.description)}" adtcore:language="${language}" ` +
    'xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<adtcore:packageRef adtcore:type="DEVC/K" adtcore:name="${c.package}"/>` +
    [...c.messages]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([no, texts]) =>
          `<mc:messages mc:msgno="${no}" mc:msgtext="${escapeXml(texts.get(language) ?? texts.get(c.master) ?? '')}" ` +
          `mc:selfexplainatory="${c.selfExplanatory.get(no) ?? false}" mc:documented="false"/>`,
      )
      .join('') +
    '</mc:messageClass>';

  const request = async (method: string, path: string, opts: RequestOptions = {}) => {
    calls.push({ method, path, ...(opts.query ? { query: opts.query as Record<string, string> } : {}) });
    const ok = (body = '', status = 200) => ({ status, headers: new Headers(), body });
    const pkg = path.match(/^\/sap\/bc\/adt\/packages\/([^/?]+)$/);
    if (pkg && method === 'GET') {
      const name = decodeURIComponent(pkg[1]!).toUpperCase();
      return ok(
        `<pak:package adtcore:name="${name}" xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core">` +
          `<pak:attributes pak:packageType="development" pak:recordChanges="${state.recording.has(name)}" pak:languageVersion=""/></pak:package>`,
      );
    }
    if (path === '/sap/bc/adt/messageclass/validation' && method === 'POST') {
      const name = String(opts.query?.objname ?? '').toUpperCase();
      return classes.has(name)
        ? ok(`<exc:exception><localizedMessage lang="EN">Message class ${name} already exists</localizedMessage></exc:exception>`, 400)
        : ok();
    }
    if (path === '/sap/bc/adt/messageclass' && method === 'POST') {
      const mc = parseMessageClassXml(String(opts.body));
      classes.set(mc.name, { description: mc.description, package: mc.package, master: mc.masterLanguage, messages: new Map(), selfExplanatory: new Map() });
      return ok('', 201);
    }
    const m = path.match(/^\/sap\/bc\/adt\/messageclass\/([^/?]+)$/);
    if (!m) return ok('', 404);
    const name = decodeURIComponent(m[1]!).toUpperCase();
    const c = classes.get(name);
    if (!c) return ok('', 404);
    if (method === 'GET') return ok(xmlOf(name, c, opts.language ?? logon));
    if (method === 'POST' && opts.query?._action === 'LOCK') {
      return ok(`<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>${state.request}</CORRNR></DATA></asx:values></asx:abap>`);
    }
    if (method === 'POST' && opts.query?._action === 'UNLOCK') return ok();
    if (method === 'PUT') {
      const failed = state.failPut(name);
      if (failed) return ok(failed, 403);
      const body = String(opts.body);
      const sent = parseMessageClassXml(body);
      c.description = sent.description;
      for (const msg of sent.messages) {
        const texts = c.messages.get(msg.number) ?? new Map<string, string>();
        texts.set(sent.language, msg.text.trimEnd());
        c.messages.set(msg.number, texts);
      }
      // A flag the body leaves out stays; a new message without one gets SAP's default.
      for (const [tag] of body.matchAll(/<mc:messages\b[^>]*>/g)) {
        const no = tag.match(/mc:msgno="([^"]*)"/)![1]!;
        const flag = tag.match(/mc:selfexplainatory="(\w+)"/)?.[1];
        if (flag) c.selfExplanatory.set(no, flag === 'true');
        else if (!c.selfExplanatory.has(no)) c.selfExplanatory.set(no, false);
      }
      for (const [, no] of body.matchAll(/<mc:deletedmessages mc:msgno="([^"]*)"/g)) c.messages.delete(decodeXml(no!));
      return state.failAfterPut ? ok(state.failAfterPut, 500) : ok();
    }
    if (method === 'DELETE') {
      classes.delete(name);
      return ok();
    }
    return ok('', 405);
  };

  const rest = {
    authKind: 'basic',
    request,
    expectOk: async (method: string, path: string, context: string, opts: RequestOptions = {}) => {
      const res = await request(method, path, opts);
      if (res.status >= 400) throw new RawAdtError(res.status, 'ExceptionX', res.body, context);
      return res;
    },
    stateful: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as RawAdtClient;

  /** Put a class on the fake system. */
  const add = (name: string, c: { description?: string; package?: string; master?: string; messages?: Record<string, string>; translations?: Record<string, Record<string, string>> }) => {
    const master = c.master ?? 'EN';
    const messages = new Map<string, Map<string, string>>();
    for (const [no, text] of Object.entries(c.messages ?? {})) messages.set(no, new Map([[master, text]]));
    for (const [language, texts] of Object.entries(c.translations ?? {})) {
      for (const [no, text] of Object.entries(texts)) messages.get(no)?.set(language, text);
    }
    classes.set(name, { description: c.description ?? name, package: c.package ?? 'ZADTPLUS_A', master, messages, selfExplanatory: new Map() });
  };

  /** A class's master-language texts by number. */
  const texts = (name: string) => {
    const c = classes.get(name)!;
    return Object.fromEntries([...c.messages].map(([no, t]) => [no, t.get(c.master)]));
  };

  return { state, rest, add, texts, withRest: <T>(fn: (rest: RawAdtClient) => Promise<T>) => fn(rest) };
}
