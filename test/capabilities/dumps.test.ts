import { describe, expect, it } from 'vitest';
import {
  chapterTexts,
  compactLines,
  dumpSegment,
  feedStamp,
  listDumps,
  MAX_DUMP_CHARS,
  parseDumpFeed,
  prepareList,
  readDump,
} from '../../src/capabilities/dumps.js';
import type { Destination } from '../../src/core/destinations.js';
import { answeringRest } from '../helpers/rest.js';

const destination: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: [],
  user: 'developer',
  allowRuntimeLogs: true,
};

const ID = '20261012071723myhost_DEV_00%20%20%20%20%20DEVELOPER%20%20%20%20100%20%20%20%209';

/** One entry as ONPREM sends it, the summary shortened. */
function entry(id: string, user: string, labels = ['ABAP runtime error', 'Terminated ABAP program']): string {
  return (
    `<atom:entry xml:lang="EN"><atom:author FullName="${user}"><atom:name>${user}</atom:name></atom:author>` +
    `<atom:category term="COMPUTE_INT_ZERODIVIDE" label="${labels[0]}"/>` +
    `<atom:category term="ZCL_FLDBG_DUMP================CP" label="${labels[1]}"/>` +
    `<atom:id>/sap/bc/adt/vit/runtime/dumps/${id}</atom:id>` +
    `<atom:link href="adt://DEV/sap/bc/adt/vit/runtime/dumps/${id}" rel="alternate" type="application/vnd.sap.adt.sapgui"/>` +
    `<atom:link href="adt://DEV/sap/bc/adt/runtime/dump/${id}" rel="self" type="text/plain"/>` +
    '<atom:published>2026-10-12T05:17:23Z</atom:published>' +
    '<atom:summary type="html">&lt;p&gt;Variables: secret&lt;/p&gt;</atom:summary></atom:entry>'
  );
}

const feed = (...entries: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>ABAP Short Dump Analysis</atom:title>${entries.join('')}</atom:feed>`;

describe('feedStamp', () => {
  it.each([
    ['20261012080000', '20261012080000'],
    ['2026-10-12', '20261012000000'],
    ['2026-10-12T08:00:00Z', '20261012080000'],
    ['2026-10-12T08:00', '20261012080000'],
    ['2026-10-12T10:00:00+02:00', '20261012080000'],
    ['2026-10-12T08:00:00.123Z', '20261012080000'],
  ])('reads %s as UTC %s', (value, stamp) => {
    expect(feedStamp(value, 'from')).toBe(stamp);
  });

  it('takes a whole day as "to"', () => {
    expect(feedStamp('2026-10-12', 'to')).toBe('20261012235959');
  });

  it.each(['yesterday', '2026-02-30', '20260230000000', '2026-10-12 08:00', '1760256000', ''])('refuses %j: SAP would ignore it and send the whole feed', (value) => {
    expect(() => feedStamp(value, 'to')).toThrow(/"to" must be a time/);
  });
});

describe('prepareList', () => {
  it('refuses a system without allowRuntimeLogs: true, naming the setting', () => {
    expect(() => prepareList({ ...destination, allowRuntimeLogs: undefined }, {})).toThrow(/runtime logs are off here\. They need "allowRuntimeLogs": true/);
  });

  it.each(['a,b', 'x) or(y', 'two words', ''])('refuses user %j, which would change the query', (user) => {
    expect(() => prepareList(destination, { user })).toThrow(/"user" must be an SAP user name/);
  });

  it.each([0, 101, 1.5])('refuses maxResults %j', (maxResults) => {
    expect(() => prepareList(destination, { maxResults })).toThrow(/maxResults/);
  });
});

describe('parseDumpFeed', () => {
  it('keeps metadata only, never the summary', () => {
    const [dump] = parseDumpFeed(feed(entry(ID, 'DEVELOPER')));
    expect(dump).toEqual({
      id: ID,
      time: '2026-10-12T05:17:23Z',
      runtimeError: 'COMPUTE_INT_ZERODIVIDE',
      program: 'ZCL_FLDBG_DUMP================CP',
      user: 'DEVELOPER',
    });
    expect(JSON.stringify(dump)).not.toContain('secret');
  });

  it('takes error and program by position when the labels are in another language', () => {
    const [dump] = parseDumpFeed(feed(entry(ID, 'DEVELOPER', ['ABAP-Laufzeitfehler', 'Abgebrochenes ABAP-Programm'])));
    expect(dump).toMatchObject({ runtimeError: 'COMPUTE_INT_ZERODIVIDE', program: 'ZCL_FLDBG_DUMP================CP' });
  });

  it('refuses what is not a feed', () => {
    expect(() => parseDumpFeed('<html/>')).toThrow(/not an Atom feed/);
  });
});

describe('listDumps', () => {
  it('lists the logon user\'s own dumps by default, one feed request with $top', async () => {
    const rest = answeringRest({ '/core/http/systeminformation': '{"userName":"developer"}', '/runtime/dumps': feed(entry(ID, 'DEVELOPER')) });
    const res = await listDumps(rest, destination, prepareList(destination, {}), undefined);
    expect(rest.calls[1]).toMatchObject({
      method: 'GET',
      path: '/sap/bc/adt/runtime/dumps',
      opts: { query: { $top: '20', $query: 'and(equals(user,DEVELOPER))' } },
    });
    expect(res).toMatchObject({ user: 'DEVELOPER', dumps: [{ id: ID }], via: 'rest-fallback', nativeAvailable: null });
    expect(res.mayHaveMore).toBeUndefined();
  });

  it('lists everyone\'s with "*", a window, and says when there may be more', async () => {
    const rest = answeringRest({ '/runtime/dumps': feed(entry(ID, 'A'), entry(`${ID}2`, 'B')) });
    const res = await listDumps(rest, destination, prepareList(destination, { user: '*', from: '2026-10-01', to: '2026-10-12T08:00:00Z', maxResults: 2 }), undefined);
    expect(rest.calls).toHaveLength(1);
    expect(rest.calls[0]!.opts.query).toEqual({ $top: '2', from: '20261001000000', to: '20261012080000' });
    expect(res).toMatchObject({ user: '*', mayHaveMore: true });
  });

  it('sends a window in the feeds\' scale and returns UTC times, by the measured clock (ADR-016)', async () => {
    const clock = { localOffsetMinutes: 60, feedOffsetMinutes: -60, measuredAt: 'x' };
    const rest = answeringRest({ '/runtime/dumps': feed(entry(ID, 'A')) });
    const res = await listDumps(rest, destination, prepareList(destination, { user: '*', from: '2026-10-12T08:00:00Z' }), undefined, clock);
    expect(rest.calls[0]!.opts.query).toMatchObject({ from: '20261012070000' });
    expect(res.dumps[0]!.time).toBe('2026-10-12T06:17:23Z');
    expect(res.notes).toBeUndefined();
    const unmeasured = await listDumps(answeringRest({ '/runtime/dumps': feed(entry(ID, 'A')) }), destination, prepareList(destination, { user: '*' }), undefined, { measuredAt: 'x', errors: { feed: 'x' } });
    expect(unmeasured.notes?.[0]).toMatch(/not corrected to UTC/);
  });

  it('reads the logon user once per session', async () => {
    const rest = answeringRest({ '/core/http/systeminformation': '{"userName":"developer"}', '/runtime/dumps': feed() });
    await listDumps(rest, destination, prepareList(destination, {}), undefined);
    await listDumps(rest, destination, prepareList(destination, {}), undefined);
    expect(rest.calls.map((c) => c.path.split('/').at(-1))).toEqual(['systeminformation', 'dumps', 'dumps']);
  });

  it('refuses when the logon user is unknown, rather than listing everyone\'s', async () => {
    const rest = answeringRest({ '/core/http/systeminformation': '{}' });
    await expect(listDumps(rest, { ...destination, user: undefined }, prepareList(destination, {}), undefined)).rejects.toThrow(/logon user is unknown here; pass "user"/);
  });
});

describe('dumpSegment', () => {
  it('keeps an id from the feed as it is and encodes a pasted one', () => {
    expect(dumpSegment(ID)).toBe(ID);
    expect(dumpSegment(decodeURIComponent(ID))).toBe(ID);
  });

  it.each(['../dumps', 'a/b', '%2F..%2Fx', 'x?y=1', '%E0%A4%A', '   '])('refuses %j', (id) => {
    expect(() => dumpSegment(id)).toThrow(/is not a dump id/);
  });
});

const HEADER =
  '<?xml version="1.0" encoding="utf-8"?><dump:dump title="Runtime Error" error="COMPUTE_INT_ZERODIVIDE" author="DEVELOPER" ' +
  'exception="CX_SY_ZERODIVIDE" terminatedProgram="ZCL_FLDBG_DUMP================CP" datetime="2026-10-12T05:17:23Z" ' +
  'xmlns:dump="http://www.sap.com/adt/categories/dump"><dump:chapters>' +
  '<dump:chapter name="kap1" title="What happened?" category="User View" line="4"/>' +
  '<dump:chapter name="kap0" title="Short Text" category="ABAP Developer View" line="1"/>' +
  '<dump:chapter name="kap10" title="Selected Variables" category="ABAP Developer View" line="6"/>' +
  '<dump:chapter name="kap5" title="System environment" category="System Environment" line="8"/>' +
  '</dump:chapters></dump:dump>';
const TEXT = ['Short Text', '  Division by 0', '', 'What happened?', '  Error in ZCL_FLDBG_DUMP', 'Selected Variables', '  LV_SECRET 42', 'System environment', '  SAP Release 758'].join('\r\n');

describe('readDump', () => {
  it('returns the header and the developer chapters, names the others, never the variables unasked', async () => {
    const rest = answeringRest({ [`/runtime/dump/${ID}`]: HEADER, '/formatted': TEXT });
    const res = await readDump(rest, destination, { id: ID }, undefined);
    expect(res).toMatchObject({
      id: ID,
      runtimeError: 'COMPUTE_INT_ZERODIVIDE',
      exception: 'CX_SY_ZERODIVIDE',
      program: 'ZCL_FLDBG_DUMP================CP',
      user: 'DEVELOPER',
      time: '2026-10-12T05:17:23Z',
      chapters: [
        { name: 'kap0', title: 'Short Text', text: 'Short Text\n  Division by 0' },
        { name: 'kap1', title: 'What happened?', text: 'What happened?\n  Error in ZCL_FLDBG_DUMP' },
      ],
      otherChapters: [
        { name: 'kap10', title: 'Selected Variables' },
        { name: 'kap5', title: 'System environment' },
      ],
      via: 'rest-fallback',
    });
    expect(JSON.stringify(res)).not.toContain('LV_SECRET');
    expect(rest.calls.map((c) => c.opts.headers?.Accept)).toEqual(['application/vnd.sap.adt.runtime.dump.v1+xml', 'text/plain']);
  });

  it('returns the chapters named, by title or name, the last one up to the end', async () => {
    const rest = answeringRest({ [`/runtime/dump/${ID}`]: HEADER, '/formatted': TEXT });
    const res = await readDump(rest, destination, { id: ID, chapters: ['selected variables', 'KAP5'] }, undefined);
    expect(res.chapters.map((c) => c.text)).toEqual(['Selected Variables\n  LV_SECRET 42', 'System environment\n  SAP Release 758']);
  });

  it('reads empty chapters as the default', async () => {
    const rest = answeringRest({ [`/runtime/dump/${ID}`]: HEADER, '/formatted': TEXT });
    const res = await readDump(rest, destination, { id: ID, chapters: [''] }, undefined);
    expect(res.chapters.map((c) => c.name)).toEqual(['kap0', 'kap1']);
  });

  it('lists the chosen chapters the size limit cut or left out, so each can be asked for', async () => {
    const long = TEXT.replace('  Division by 0', 'x'.repeat(MAX_DUMP_CHARS + 10));
    const rest = answeringRest({ [`/runtime/dump/${ID}`]: HEADER, '/formatted': long });
    const res = await readDump(rest, destination, { id: ID }, undefined);
    expect(res).toMatchObject({ truncated: true });
    expect(res.chapters.map((c) => c.name)).toEqual(['kap0']);
    expect(res.otherChapters.map((c) => c.name)).toEqual(['kap0', 'kap1', 'kap10', 'kap5']);
  });

  it('names the chapters there are when one asked for isn\'t', async () => {
    const rest = answeringRest({ [`/runtime/dump/${ID}`]: HEADER, '/formatted': TEXT });
    await expect(readDump(rest, destination, { id: ID, chapters: ['Memory'] }, undefined)).rejects.toThrow(/no chapter "Memory"; it has: kap0 \(Short Text\)/);
  });

  it('refuses a system without allowRuntimeLogs before any call', async () => {
    const rest = answeringRest({});
    await expect(readDump(rest, { ...destination, allowRuntimeLogs: false }, { id: ID }, undefined)).rejects.toThrow(/runtime logs are off here/);
    expect(rest.calls).toEqual([]);
  });
});

describe('compactLines', () => {
  it('unboxes SAP\'s padded lines, drops dash rows and repeated blank lines, keeps indentation', () => {
    const lines = [
      `|Short Text${' '.repeat(90)}|`,
      `|    Division by 0 (type I or INT8)${' '.repeat(66)}|`,
      '-'.repeat(100),
      '',
      '-'.repeat(100),
      `|${' '.repeat(98)}|`,
      `|    1|  METHOD main.${' '.repeat(70)}|`,
      '',
    ];
    expect(compactLines(lines)).toBe('Short Text\n    Division by 0 (type I or INT8)\n\n    1|  METHOD main.');
  });
});

describe('chapterTexts', () => {
  it('cuts the returned text at the size limit and says so', () => {
    const big = ['Short Text', 'x'.repeat(MAX_DUMP_CHARS), 'What happened?', 'y'].join('\n');
    const index = [{ name: 'kap0', title: 'Short Text', line: 1 }, { name: 'kap1', title: 'What happened?', line: 3 }];
    const res = chapterTexts(big, index, index);
    expect(res.truncated).toBe(true);
    expect(res.chapters).toHaveLength(1);
    expect(res.chapters[0]!.text.length).toBe(MAX_DUMP_CHARS + 1);
  });
});
