import { describe, expect, it } from 'vitest';
import { MAX_DUMP_CHARS } from '../../src/capabilities/dumps.js';
import {
  gatewayErrorPath,
  gatewayQuery,
  htmlText,
  listGatewayErrors,
  listSystemMessages,
  parseGatewayDetail,
  parseGatewayFeed,
  parseSystemMessages,
  prepareGatewayList,
  readGatewayError,
} from '../../src/capabilities/runtime-logs.js';
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

const ID = 'FrontendError/00505685567E1FE1B1C12001984A5DBB';

/** Shaped like ONPREM's entry, the summary shortened. */
const ENTRY =
  '<atom:entry><atom:author><atom:name>DEVELOPER (Some Name)</atom:name></atom:author>' +
  `<atom:id>${ID}</atom:id>` +
  '<atom:summary type="html">&lt;h4 id="HEADER"&gt;secret payload&lt;/h4&gt;</atom:summary>' +
  "<atom:title>Frontend Error: Service group 'ZADTPLUS_PROBE_NONE' not published</atom:title>" +
  '<atom:updated>2026-10-12T06:48:57Z</atom:updated></atom:entry>';

const feed = (...entries: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><atom:feed xml:lang="EN" xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>SAP Gateway Error Log</atom:title>${entries.join('')}</atom:feed>`;

/** The detail page's shape: contents, tables, the source extract's two columns, the stack. */
const DETAIL =
  '<h4 id="OVERVIEW"><u>Content</u></h4><a href="#HEADER">Header Information</a><br>' +
  '<h4 id="HEADER"><u>Header Information</u></h4><table cellspacing="3">' +
  '<tr><td>&nbsp;&nbsp;<b>Type</b></td><td>  </td></tr>' +
  "<tr><td>&nbsp;&nbsp;<b>Short Text</b></td><td> <span lang=\"EN\">Service group 'Z_X' not published</span> </td></tr>" +
  '<tr><td>&nbsp;&nbsp;<b>Transaction ID</b></td><td> &nbsp;<a href="adt://DEV/sap/bc/adt/vit/gw/client/project/00505685567E1FE1B1C12001984A5DBB,1">(Replay in GW Client)</a> </td></tr></table>' +
  '<h4 id="CONTEXT"><u>Error Context</u></h4><table cellspacing="3">' +
  '<tr><td><b>&nbsp;&ndash;Exceptions</b></td><td></td></tr>' +
  '<tr><td><b>&nbsp;&nbsp;&nbsp;&nbsp;Text</b></td><td><span>Unknown error &lt;x&gt;</span></td></tr>' +
  '<tr><td>&nbsp;&nbsp;&nbsp;&nbsp;Attr</td><td></td><td>X</td></tr><tr><td></td><td>404</td></tr></table>' +
  '<h4 id="SOURCE"><u>Source Code Extract</u></h4><style>.keyword { color: blue }</style><table id="sourcetable"><tr>' +
  '<td id="sourcetablecolumn"><span class="linenumber style="color:grey;">1</span><span class="linenumber style="color:grey;">2</span>' +
  '<span class="linenumber"><a href="adt://DEV/x#start=3"><span class="indicator">>></span></a></span></td>' +
  '<td id="sourcetablecolumn"><div class="sourceline"><span>&nbsp;&nbsp;<span class="keyword">METHOD</span> check<span class="keyword">.</span></span></div>' +
  '<div class="sourceline"><span>&nbsp;&nbsp;&nbsp;&nbsp;<span class="keyword">IF</span> sy-subrc &lt;&gt; 0.</span></div>' +
  '<div class="sourceline highlight"><a href="adt://DEV/x#start=3"><span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;RAISE EXCEPTION NEW cx_x( ).</span></a></div></td></tr></table>' +
  '<h4 id="STACK"><u>Active Calls/Events</u></h4><table cellspacing="5"><tr><th>No.</th><th>Event</th><th>Program</th></tr>' +
  '<tr><td><code><a href="adt://DEV/x">2</a></code></td><td><code>METHOD</code></td><td><code>/IWFND/CL_X===CP</code></td></tr></table>';

describe('gatewayQuery', () => {
  it('filters on user and the timestamp, which SAP honours where it ignores from/to', () => {
    expect(gatewayQuery('DEVELOPER', '20261012000000', '20261012235959')).toBe(
      'and(equals(username,DEVELOPER),greaterOrEquals(timestamp,20261012000000),lessOrEquals(timestamp,20261012235959))',
    );
    expect(gatewayQuery('DEVELOPER', undefined, undefined)).toBe('and(equals(username,DEVELOPER),greaterOrEquals(timestamp,19700101000000))');
    // Without a query SAP sends recent entries only: everyone's, unbounded, still gets one.
    expect(gatewayQuery('*', undefined, undefined)).toBe('and(greaterOrEquals(timestamp,19700101000000))');
  });
});

describe('parseGatewayFeed', () => {
  it('keeps metadata only: type, short text, the user name without the full name', () => {
    expect(parseGatewayFeed(feed(ENTRY))).toEqual([
      { id: ID, time: '2026-10-12T06:48:57Z', type: 'Frontend', shortText: "Service group 'ZADTPLUS_PROBE_NONE' not published", user: 'DEVELOPER' },
    ]);
    expect(JSON.stringify(parseGatewayFeed(feed(ENTRY)))).not.toMatch(/secret|Some Name/);
  });
});

describe('listGatewayErrors', () => {
  it('lists the logon user\'s own with $top and a $query, one feed request after the user', async () => {
    const rest = answeringRest({ '/core/http/systeminformation': '{"userName":"developer"}', '/gw/errorlog': feed(ENTRY) });
    const res = await listGatewayErrors(rest, destination, prepareGatewayList(destination, { from: '2026-10-12' }), undefined);
    expect(rest.calls[1]).toMatchObject({
      path: '/sap/bc/adt/gw/errorlog',
      opts: { query: { $top: '20', $query: 'and(equals(username,DEVELOPER),greaterOrEquals(timestamp,20261012000000))' } },
    });
    expect(res).toMatchObject({ user: 'DEVELOPER', errors: [{ id: ID }], via: 'rest-fallback', nativeAvailable: null });
  });

  it('lists everyone\'s with "*", still capped by $top', async () => {
    const rest = answeringRest({ '/gw/errorlog': feed(ENTRY) });
    const res = await listGatewayErrors(rest, destination, prepareGatewayList(destination, { user: '*', maxResults: 1 }), undefined);
    expect(rest.calls[0]!.opts.query).toEqual({ $top: '1', $query: 'and(greaterOrEquals(timestamp,19700101000000))' });
    expect(res.mayHaveMore).toBe(true);
  });

  // prepareGatewayList is prepareList (dumps.test.ts): only the time check is new here.
  it('refuses a time that is not one before any call', () => {
    expect(() => prepareGatewayList(destination, { to: 'today' })).toThrow(/"to" must be a time/);
  });
});

describe('gatewayErrorPath', () => {
  it('takes an id from the list and refuses anything that leaves the path', () => {
    expect(gatewayErrorPath(` ${ID} `)).toBe(`/sap/bc/adt/gw/errorlog/${ID}`);
    for (const bad of ['../x', 'FrontendError/../../x', 'FrontendError/a?b=1', 'x']) expect(() => gatewayErrorPath(bad)).toThrow(/not a gateway error id/);
  });
});

describe('htmlText', () => {
  it('drops tags and styles, decodes entities, keeps &nbsp; indentation', () => {
    expect(htmlText('<style>x{}</style>&nbsp;&nbsp;<b>a</b> &lt;&gt; &amp; &#39;&#x41;&ndash;<br>b')).toBe("  a <> & 'A–\nb");
  });

  it('leaves an entity past Unicode as written instead of failing', () => {
    expect(htmlText('a&#1114112;b&#x110000;')).toBe('a&#1114112;b&#x110000;');
  });
});

describe('parseGatewayDetail', () => {
  it('turns the page into sections: tables as key: value, the source zipped with its numbers, the stack as rows', () => {
    expect(parseGatewayDetail(DETAIL)).toEqual([
      { name: 'HEADER', title: 'Header Information', text: "  Type\n  Short Text: Service group 'Z_X' not published\n  Transaction ID: 00505685567E1FE1B1C12001984A5DBB" },
      { name: 'CONTEXT', title: 'Error Context', text: ' –Exceptions\n    Text: Unknown error <x>\n    Attr: X\n404' },
      { name: 'SOURCE', title: 'Source Code Extract', text: '   1      METHOD check.\n   2        IF sy-subrc <> 0.\n   3 >>       RAISE EXCEPTION NEW cx_x( ).' },
      { name: 'STACK', title: 'Active Calls/Events', text: 'No. | Event | Program\n2 | METHOD | /IWFND/CL_X===CP' },
    ]);
  });

  it('numbers the raising line from its neighbours when it opens the extract', () => {
    const page =
      '<h4 id="SOURCE"><u>Source Code Extract</u></h4><table><tr><td><span class="linenumber"><span class="indicator">>></span></span>' +
      '<span class="linenumber">141</span></td><td><div class="sourceline highlight"><span>RAISE x.</span></div><div class="sourceline"><span>ENDIF.</span></div></td></tr></table>';
    expect(parseGatewayDetail(page)[0]!.text).toBe(' 140 >> RAISE x.\n 141    ENDIF.');
  });

  it('refuses a page without sections', () => {
    expect(() => parseGatewayDetail('<html/>')).toThrow(/not a gateway error page/);
  });
});

describe('readGatewayError', () => {
  it('reads one error as HTML and returns its sections', async () => {
    const rest = answeringRest({ [ID]: DETAIL });
    const res = await readGatewayError(rest, destination, { id: ID }, undefined);
    expect(rest.calls[0]).toMatchObject({ path: `/sap/bc/adt/gw/errorlog/${ID}`, opts: { headers: { Accept: 'text/html' } } });
    expect(res).toMatchObject({ id: ID, via: 'rest-fallback' });
    expect(res.sections.map((s) => s.title)).toEqual(['Header Information', 'Error Context', 'Source Code Extract', 'Active Calls/Events']);
    expect(res.truncated).toBeUndefined();
  });

  it('cuts at the size limit, says so, and names the sections cut or left out', async () => {
    const big = DETAIL.replace('Unknown error', 'y'.repeat(MAX_DUMP_CHARS));
    const res = await readGatewayError(answeringRest({ [ID]: big }), destination, { id: ID }, undefined);
    expect(res.truncated).toBe(true);
    expect(res.sections.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(MAX_DUMP_CHARS + 1);
    expect(res.otherSections.map((s) => s.name)).toEqual(['CONTEXT', 'SOURCE', 'STACK']);
  });

  it('returns the sections named, by name or title', async () => {
    const res = await readGatewayError(answeringRest({ [ID]: DETAIL }), destination, { id: ID, sections: ['stack', 'Error Context'] }, undefined);
    expect(res.sections.map((s) => s.name)).toEqual(['CONTEXT', 'STACK']);
    expect(res.otherSections.map((s) => s.name)).toEqual(['HEADER', 'SOURCE']);
    await expect(readGatewayError(answeringRest({ [ID]: DETAIL }), destination, { id: ID, sections: ['memory'] }, undefined)).rejects.toThrow(
      /no section "memory"; it has: HEADER \(Header Information\)/,
    );
  });

  it('refuses a system without allowRuntimeLogs before any call', async () => {
    const rest = answeringRest({});
    await expect(readGatewayError(rest, { ...destination, allowRuntimeLogs: undefined }, { id: ID }, undefined)).rejects.toThrow(/runtime logs are off here/);
    expect(rest.calls).toEqual([]);
  });
});

describe('system messages', () => {
  const message =
    '<atom:entry><atom:author><atom:name>ADMIN</atom:name></atom:author><atom:id>/sap/bc/adt/runtime/systemmessages/1</atom:id>' +
    '<atom:published>2026-10-12T06:00:00Z</atom:published><atom:summary type="html">&lt;p&gt;Downtime &amp;amp; upgrade at 18:00&lt;/p&gt;</atom:summary>' +
    '<atom:title>Maintenance</atom:title><atom:updated>2026-10-12T06:00:00Z</atom:updated></atom:entry>';

  it('reads each message in full', () => {
    expect(parseSystemMessages(feed(message))).toEqual([
      {
        id: '/sap/bc/adt/runtime/systemmessages/1',
        title: 'Maintenance',
        text: 'Downtime & upgrade at 18:00',
        author: 'ADMIN',
        published: '2026-10-12T06:00:00Z',
        updated: '2026-10-12T06:00:00Z',
      },
    ]);
  });

  it('reads HTML in atom:content as text when there is no summary', () => {
    const content = message.replace(/<atom:summary[\s\S]*?<\/atom:summary>/, '<atom:content type="html">&lt;p&gt;Downtime&lt;/p&gt;</atom:content>');
    expect(parseSystemMessages(feed(content))[0]!.text).toBe('Downtime');
  });

  it('lists them as a REST fallback; none is an empty list', async () => {
    const rest = answeringRest({ '/runtime/systemmessages': feed() });
    expect(await listSystemMessages(rest, undefined)).toEqual({ messages: [], via: 'rest-fallback', nativeAvailable: null });
  });
});
