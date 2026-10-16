import { describe, expect, it } from 'vitest';
import {
  buildMessageClassXml,
  createMessageClass,
  deleteMessageClass,
  deleteMessages,
  isMessageClassType,
  messageNumber,
  parseMessageClassXml,
  readMessages,
  updateMessageClass,
  type Message,
} from '../../src/capabilities/messageclass.js';
import type { Destination } from '../../src/core/destinations.js';
import { routedRest } from '../helpers/rest.js';

// Trimmed from the live ONPREM GET.
function classXml(
  messages: Message[],
  o: { name?: string; description?: string; pkg?: string; master?: string; language?: string } = {},
): string {
  const name = o.name ?? 'ZADTPLUS_MSG';
  return (
    `<?xml version="1.0" encoding="utf-8"?><mc:messageClass adtcore:responsible="DEVELOPER" adtcore:masterLanguage="${o.master ?? 'EN'}" ` +
    `adtcore:masterSystem="DEV" adtcore:name="${name}" adtcore:type="MSAG/N" adtcore:changedAt="2026-10-10T13:51:34Z" ` +
    `adtcore:version="active" adtcore:description="${o.description ?? 'Demo'}" adtcore:language="${o.language ?? o.master ?? 'EN'}" ` +
    'xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/zpkg" adtcore:type="DEVC/K" adtcore:name="${o.pkg ?? 'ZPKG'}"/>` +
    messages
      .map(
        (m) =>
          `<mc:messages mc:msgno="${m.number}" mc:msgtext="${m.text.replace(/&/g, '&amp;')}" mc:selfexplainatory="${m.selfExplanatory}" ` +
          `mc:documented="${!m.selfExplanatory}" mc:lastchangedby="DEVELOPER" mc:lastmodified="2026-10-10" adtcore:name="">` +
          `<atom:link href="/sap/bc/adt/messageclass/${name.toLowerCase()}/messages/${m.number}" rel="http://www.sap.com/adt/relations/messageclasses/messages" xmlns:atom="http://www.w3.org/2005/Atom"/>` +
          '</mc:messages>',
      )
      .join('') +
    '</mc:messageClass>'
  );
}

/** Just what `readPackageDefinition` needs. */
const packageXml = (recordChanges: boolean) =>
  '<pak:package adtcore:name="ZPKG" xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core">' +
  `<pak:attributes pak:packageType="development" pak:recordChanges="${recordChanges}" pak:languageVersion=""/></pak:package>`;

/** SAP's lock on a class that no request holds (ONPREM, ZCL_ADTPLUS_DUMMY). */
const LOCK_NO_REQUEST = '<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/></DATA></asx:values></asx:abap>';

const LOCK = '<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>DEVK900001</CORRNR></DATA></asx:values></asx:abap>';
const URI = '/sap/bc/adt/messageclass/zadtplus_msg';

/** A class that reads `before` until a PUT or DELETE, then `after` (undefined: gone). */
function classOnSystem(before: Message[], after: Message[] | undefined, o: { description?: string; afterDescription?: string } = {}) {
  let written = false;
  return routedRest(({ method, path, opts }) => {
    if (path === URI && method === 'GET') {
      if (!written) return { body: classXml(before, o) };
      return after ? { body: classXml(after, { description: o.afterDescription ?? o.description }) } : { status: 404 };
    }
    if (path === URI && method === 'POST' && opts.query?._action === 'LOCK') return { body: LOCK };
    if (path === URI && method === 'POST' && opts.query?._action === 'UNLOCK') return { status: 200 };
    if (path === URI && (method === 'PUT' || method === 'DELETE')) {
      written = true;
      return { status: 200 };
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

const m = (number: string, text: string, selfExplanatory = true): Message => ({ number, text, selfExplanatory });

describe('message class XML', () => {
  it('parses the header, package and every message, entities decoded', () => {
    const mc = parseMessageClassXml(classXml([m('001', 'First &1'), m('002', 'Second', false)]));
    expect(mc).toEqual({
      name: 'ZADTPLUS_MSG',
      description: 'Demo',
      package: 'ZPKG',
      masterLanguage: 'EN',
      language: 'EN',
      messages: [m('001', 'First &1'), m('002', 'Second', false)],
    });
  });

  it('builds a body with only the given messages, escaped, and the deletions', () => {
    const xml = buildMessageClassXml({
      name: 'ZADTPLUS_MSG',
      description: 'A & B',
      package: 'ZPKG',
      masterLanguage: 'EN',
      messages: [{ number: '001', text: 'Value "&1" < &2' }, { number: '002', text: 'x', selfExplanatory: false }],
      deleted: ['005'],
    });
    expect(xml).toContain('adtcore:description="A &amp; B" adtcore:masterLanguage="EN" adtcore:language="EN"');
    expect(xml).toContain('<mc:messages mc:msgno="001" mc:msgtext="Value &quot;&amp;1&quot; &lt; &amp;2"/>');
    expect(xml).toContain('<mc:messages mc:msgno="002" mc:msgtext="x" mc:selfexplainatory="false"/>');
    expect(xml).toContain('<mc:deletedmessages mc:msgno="005"/>');
    expect(xml).not.toContain('abapLanguageVersion');
    expect(parseMessageClassXml(xml).messages[0]!.text).toBe('Value "&1" < &2');
  });

  it('takes MSAG and MSAG/N as message class types', () => {
    expect(['MSAG', 'msag/n', 'MSAG/N'].every(isMessageClassType)).toBe(true);
    expect(isMessageClassType('CLAS/OC')).toBe(false);
  });

  it('pads message numbers and refuses anything outside 000–999', () => {
    expect(messageNumber(7)).toBe('007');
    expect(messageNumber(' 42 ')).toBe('042');
    expect(messageNumber('999')).toBe('999');
    expect(() => messageNumber('1000')).toThrow(/000 to 999/);
    expect(() => messageNumber('1a')).toThrow(/000 to 999/);
  });
});

describe('readMessages', () => {
  it('reads every message, or those whose number or text matches grep', async () => {
    const rest = classOnSystem([m('001', 'Order &1 not found'), m('002', 'Customer missing'), m('010', 'Other')], undefined);
    const all = await readMessages(rest, { name: 'zadtplus_msg' });
    expect(all).toMatchObject({ totalMessages: 3, via: 'rest-fallback', nativeAvailable: null });
    expect(all.messages).toHaveLength(3);
    const hits = await readMessages(rest, { name: 'ZADTPLUS_MSG', grep: 'order|^010' });
    expect(hits.messages.map((x) => x.number)).toEqual(['001', '010']);
    expect(hits.totalMessages).toBe(3);
  });

  it('says a missing class does not exist', async () => {
    await expect(readMessages(routedRest(() => undefined), { name: 'ZNOPE' })).rejects.toThrow('message class "ZNOPE" does not exist');
  });
});

describe('createMessageClass', () => {
  const created = () =>
    routedRest(({ method, path, opts }) => {
      if (path.endsWith('/validation')) return { status: 200 };
      if (method === 'POST' && path === '/sap/bc/adt/messageclass') return { status: 201 };
      if (method === 'GET' && path === URI && opts) return { body: classXml([]) };
      return undefined;
    });

  it('validates, creates in the logon language and the given request, and reads the class back', async () => {
    const rest = created();
    const res = await createMessageClass(rest, onprem, { name: 'zadtplus_msg', packageName: 'zpkg', description: 'Demo', transport: 'DEVK900001' }, noChain);
    expect(res).toMatchObject({ messageClass: { name: 'ZADTPLUS_MSG', package: 'ZPKG' }, transport: 'DEVK900001', via: 'rest-fallback' });
    const [validation, post] = rest.calls;
    expect(validation!.opts.query).toEqual({ objname: 'ZADTPLUS_MSG', description: 'Demo', packagename: 'ZPKG' });
    expect(post!.opts.query).toEqual({ corrNr: 'DEVK900001' });
    expect(post!.opts.body).toContain('adtcore:masterLanguage="EN"');
    expect(post!.opts.body).not.toContain('abapLanguageVersion');
  });

  it('sends a non-standard language version of the system', async () => {
    const rest = created();
    await createMessageClass(
      rest,
      { ...onprem, languageVersion: 'cloudDevelopment' },
      { name: 'ZADTPLUS_MSG', packageName: 'ZPKG', description: 'Demo', transport: 'DEVK900001' },
      noChain,
    );
    expect(rest.calls[1]!.opts.body).toContain('adtcore:abapLanguageVersion="cloudDevelopment"');
  });

  it("stops at SAP's validation, naming its reason", async () => {
    const rest = routedRest(({ path }) =>
      path.endsWith('/validation')
        ? { status: 400, body: '<exc:exception><localizedMessage lang="EN">Message class ZADTPLUS_MSG already exists</localizedMessage></exc:exception>' }
        : { status: 201 },
    );
    await expect(
      createMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', packageName: 'ZPKG', description: 'Demo', transport: 'DEVK900001' }, noChain),
    ).rejects.toThrow('Message class ZADTPLUS_MSG already exists');
    expect(rest.calls).toHaveLength(1);
  });

  it('refuses to create without a request in a package that records changes, before validating', async () => {
    const rest = routedRest(({ path }) => (path === '/sap/bc/adt/packages/zpkg' ? { body: packageXml(true) } : { status: 201 }));
    await expect(createMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', packageName: 'ZPKG', description: 'Demo' }, noChain)).rejects.toThrow(
      'message class ZADTPLUS_MSG not created: package ZPKG records changes and no request holds the message class; pass "transport"',
    );
    expect(rest.calls.map((c) => c.path)).toEqual(['/sap/bc/adt/packages/zpkg']);
  });

  it('creates without a request in a package that records none', async () => {
    const rest = routedRest(({ method, path }) => {
      if (path === '/sap/bc/adt/packages/zpkg') return { body: packageXml(false) };
      if (path.endsWith('/validation')) return { status: 200 };
      if (method === 'POST') return { status: 201 };
      return path === URI ? { body: classXml([]) } : undefined;
    });
    const res = await createMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', packageName: 'ZPKG', description: 'Demo' }, noChain);
    expect(res).toMatchObject({ transport: null });
    expect(rest.calls.find((c) => c.method === 'POST' && c.path === '/sap/bc/adt/messageclass')!.opts.query).toEqual({ corrNr: '' });
  });

  it('refuses a package outside the allowlist before any request', async () => {
    const rest = created();
    await expect(createMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', packageName: 'ZOTHER', description: 'Demo' }, noChain)).rejects.toThrow(
      'not in the write allowlist',
    );
    expect(rest.calls).toHaveLength(0);
  });
});

describe('updateMessageClass', () => {
  it('sends only the given messages under a lock, keeps a changed message’s flag, and reports what was there', async () => {
    const rest = classOnSystem([m('001', 'Old', false), m('002', 'Keep')], [m('001', 'New &1', false), m('002', 'Keep'), m('003', 'Added')]);
    const res = await updateMessageClass(
      rest,
      onprem,
      { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'New &1' }, { number: '3', text: 'Added' }] },
      noChain,
    );
    expect(rest.calls.map((c) => `${c.method} ${c.opts.query?._action ?? ''}`.trim())).toEqual(['GET', 'POST LOCK', 'PUT', 'POST UNLOCK', 'GET']);
    const put = rest.calls[2]!;
    expect(put.opts.query).toEqual({ lockHandle: 'H1', corrNr: 'DEVK900001' });
    expect(put.opts.body).toContain('<mc:messages mc:msgno="001" mc:msgtext="New &amp;1" mc:selfexplainatory="false"/>');
    expect(put.opts.body).toContain('<mc:messages mc:msgno="003" mc:msgtext="Added"/>');
    expect(put.opts.body).not.toContain('msgno="002"');
    expect(put.opts.body).toContain('adtcore:description="Demo"');
    expect(res).toMatchObject({
      messageClass: 'ZADTPLUS_MSG',
      transport: 'DEVK900001',
      messages: [
        { number: '001', text: 'New &1', selfExplanatory: false, previous: { text: 'Old', selfExplanatory: false } },
        { number: '003', text: 'Added', selfExplanatory: true, previous: null },
      ],
    });
  });

  it('refuses a class no request holds in a package that records changes, and unlocks', async () => {
    const rest = routedRest(({ method, path, opts }) => {
      if (method === 'GET' && path === URI) return { body: classXml([m('001', 'Old')]) };
      if (method === 'GET' && path === '/sap/bc/adt/packages/zpkg') return { body: packageXml(true) };
      if (opts.query?._action === 'LOCK') return { body: LOCK_NO_REQUEST };
      return { status: 200 };
    });
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'x' }] }, noChain)).rejects.toThrow(
      'message class ZADTPLUS_MSG not written: package ZPKG records changes and no request holds the message class; pass "transport"',
    );
    expect(rest.calls.map((c) => c.method)).not.toContain('PUT');
    expect(rest.calls.at(-1)!.opts.query).toEqual({ _action: 'UNLOCK', lockHandle: 'H1' });
  });

  it('writes a class no request holds in a package that records none', async () => {
    let written = false;
    const rest = routedRest(({ method, path, opts }) => {
      if (method === 'GET' && path === URI) return { body: classXml(written ? [m('001', 'x')] : []) };
      if (method === 'GET' && path === '/sap/bc/adt/packages/zpkg') return { body: packageXml(false) };
      if (opts.query?._action === 'LOCK') return { body: LOCK_NO_REQUEST };
      if (method === 'PUT') written = true;
      return { status: 200 };
    });
    const res = await updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'x' }] }, noChain);
    expect(res).toMatchObject({ transport: null });
  });

  it('builds on and checks the texts in the master language when the logon language is another', async () => {
    let written = false;
    const rest = routedRest(({ method, path, opts }) => {
      if (method === 'GET' && path === URI) {
        // In the logon language SAP answers its translation where there is one.
        if (opts.language !== 'DE') return { body: classXml([m('001', 'Document &1 was posted')], { master: 'DE', language: 'EN' }) };
        return { body: classXml([m('001', written ? 'Beleg &1 gebucht' : 'Beleg &1 wurde gebucht')], { master: 'DE' }) };
      }
      if (opts.query?._action === 'LOCK') return { body: LOCK };
      if (method === 'PUT') written = true;
      return { status: 200 };
    });
    const res = await updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'Beleg &1 gebucht' }] }, noChain);
    expect(rest.calls.find((c) => c.method === 'PUT')!.opts.body).toContain('adtcore:masterLanguage="DE" adtcore:language="DE"');
    expect(res.messages[0]).toMatchObject({ text: 'Beleg &1 gebucht', previous: { text: 'Beleg &1 wurde gebucht' } });
  });

  it('locks and writes in the given request', async () => {
    const rest = classOnSystem([], [m('001', 'x')]);
    await updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'x' }], transport: 'DEVK900009' }, noChain);
    expect(rest.calls[1]!.opts.query).toMatchObject({ corrNr: 'DEVK900009' });
    expect(rest.calls[2]!.opts.query).toMatchObject({ corrNr: 'DEVK900009' });
  });

  it('reads attribute values that hold an unescaped >', () => {
    const xml = classXml([m('001', 'Value > limit &1')], { description: 'A > B' });
    expect(parseMessageClassXml(xml)).toMatchObject({ description: 'A > B', messages: [{ number: '001', text: 'Value > limit &1', selfExplanatory: true }] });
  });

  it('refuses a changed description before any write, and takes the current one', async () => {
    const rest = classOnSystem([m('001', 'x')], [m('001', 'y')], { description: 'Demo' });
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', description: 'Better' }, noChain)).rejects.toThrow(
      /changing the description is refused: .*LIMU MESS ZADTPLUS_MSG.*phantom message class ZADTPLUS_ in the package/,
    );
    expect(rest.calls.map((c) => c.method)).toEqual(['GET']);
    const res = await updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', description: 'Demo ', messages: [{ number: 1, text: 'y' }] }, noChain);
    expect(res).toMatchObject({ description: 'Demo', messages: [{ number: '001', text: 'y' }] });
  });

  it('refuses a text over 73 characters, a number given twice, and an empty call before any request', async () => {
    const rest = classOnSystem([], []);
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'x'.repeat(74) }] }, noChain)).rejects.toThrow(
      'message 001: the text has 74 characters, SAP takes at most 73',
    );
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'a\nb' }] }, noChain)).rejects.toThrow(
      'message 001: the text has a line break or control character',
    );
    await expect(
      updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'a' }, { number: '001', text: 'b' }] }, noChain),
    ).rejects.toThrow('message 001 is given twice');
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG' }, noChain)).rejects.toThrow('needs "messages" and/or "description"');
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', description: 'd'.repeat(61) }, noChain)).rejects.toThrow(
      'the description has 61 characters, SAP takes at most 60',
    );
    await expect(createMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', packageName: 'ZPKG', description: 'd'.repeat(61) }, noChain)).rejects.toThrow(
      'the description has 61 characters',
    );
    expect(rest.calls).toHaveLength(0);
  });

  it('refuses a class outside the allowlist after reading it, before the lock', async () => {
    const rest = routedRest(({ method }) => (method === 'GET' ? { body: classXml([], { pkg: 'ZOTHER' }) } : { status: 200 }));
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'x' }] }, noChain)).rejects.toThrow(
      'package "ZOTHER" is not in the write allowlist',
    );
    expect(rest.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('fails when the read-back does not show the change', async () => {
    const rest = classOnSystem([], []);
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'x' }] }, noChain)).rejects.toThrow(
      'update returned OK but message 001 not as sent on read-back',
    );
  });

  it('unlocks when the PUT fails', async () => {
    const rest = routedRest(({ method, opts }) => {
      if (method === 'GET') return { body: classXml([]) };
      if (opts.query?._action === 'LOCK') return { body: LOCK };
      if (method === 'PUT') return { status: 400, body: 'deserializing' };
      return { status: 200 };
    });
    await expect(updateMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', messages: [{ number: 1, text: 'x' }] }, noChain)).rejects.toThrow(
      'update message class ZADTPLUS_MSG failed (HTTP 400',
    );
    expect(rest.calls.at(-1)!.opts.query).toEqual({ _action: 'UNLOCK', lockHandle: 'H1' });
  });
});

describe('deleteMessages', () => {
  it('needs confirm', async () => {
    await expect(deleteMessages(classOnSystem([], []), onprem, { name: 'ZADTPLUS_MSG', numbers: [1] }, noChain)).rejects.toThrow('requires confirm: true');
  });

  it('sends the numbers as deletions and reports the deleted texts', async () => {
    const rest = classOnSystem([m('001', 'One'), m('002', 'Two')], [m('002', 'Two')]);
    const res = await deleteMessages(rest, onprem, { name: 'ZADTPLUS_MSG', numbers: ['1'], confirm: true }, noChain);
    expect(rest.calls[2]!.opts.body).toContain('<mc:deletedmessages mc:msgno="001"/>');
    expect(rest.calls[2]!.opts.body).not.toContain('<mc:messages ');
    expect(res).toMatchObject({ messageClass: 'ZADTPLUS_MSG', deleted: [m('001', 'One')], transport: 'DEVK900001' });
  });

  it('refuses the whole call when a number is missing, since SAP would answer OK', async () => {
    const rest = classOnSystem([m('001', 'One')], []);
    await expect(deleteMessages(rest, onprem, { name: 'ZADTPLUS_MSG', numbers: [1, 7], confirm: true }, noChain)).rejects.toThrow(
      'message class ZADTPLUS_MSG has no message 007; nothing deleted',
    );
    expect(rest.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('fails when a message is still there after the write', async () => {
    const rest = classOnSystem([m('001', 'One')], [m('001', 'One')]);
    await expect(deleteMessages(rest, onprem, { name: 'ZADTPLUS_MSG', numbers: [1], confirm: true }, noChain)).rejects.toThrow(
      'delete returned OK but message 001 still there',
    );
  });
});

describe('deleteMessageClass', () => {
  it('needs confirm, then locks, deletes and checks it is gone', async () => {
    await expect(deleteMessageClass(classOnSystem([], undefined), onprem, { name: 'ZADTPLUS_MSG' }, noChain)).rejects.toThrow('requires confirm: true');
    const rest = classOnSystem([m('001', 'One')], undefined);
    const res = await deleteMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', confirm: true, transport: 'DEVK900009' }, noChain);
    expect(rest.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE', 'POST', 'GET']);
    expect(rest.calls[2]!.opts.query).toEqual({ lockHandle: 'H1', corrNr: 'DEVK900009' });
    expect(res).toEqual({ messageClass: 'ZADTPLUS_MSG', deleted: true, transport: 'DEVK900009', via: 'rest-fallback', nativeAvailable: null });
  });

  it('fails when the class is still readable', async () => {
    const rest = classOnSystem([], []);
    await expect(deleteMessageClass(rest, onprem, { name: 'ZADTPLUS_MSG', confirm: true }, noChain)).rejects.toThrow(
      'delete returned OK but the message class is still readable',
    );
  });
});
