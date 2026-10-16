import { afterEach, describe, expect, it, vi } from 'vitest';
import { outsideRestCall, parseAdtException, RawAdtClient, RawAdtError, RawAdtTimeoutError, REST_TIMEOUT_MS, endsLoop, trackWrites, withLimit, withTimeout, type RequestLimit } from '../../src/backends/rawadt.js';

type Call = { url: URL; init: RequestInit };

function stubFetch(responder: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const call = { url: new URL(String(url)), init };
      calls.push(call);
      return responder(call, calls.length - 1);
    }),
  );
  return calls;
}

const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

function basicClient(): RawAdtClient {
  return new RawAdtClient({
    baseUrl: 'https://onprem.example:44300',
    client: '100',
    auth: { kind: 'basic', user: 'DEVELOPER', password: 'pw"x' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('RawAdtClient', () => {
  it('sends Basic auth, sap-client and cookies; fetches CSRF once for writes', async () => {
    const calls = stubFetch((call) =>
      call.url.pathname === '/sap/bc/adt/core/discovery'
        ? new Response('', { headers: [['x-csrf-token', 'tok1'], ['set-cookie', 'SAP_SESSIONID_DEV_100=abc; path=/']] })
        : new Response('<ok/>'),
    );
    const rest = basicClient();

    await rest.request('POST', '/sap/bc/adt/packages', { body: '<x/>' });
    await rest.request('POST', '/sap/bc/adt/packages', { body: '<y/>' });

    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/sap/bc/adt/core/discovery',
      '/sap/bc/adt/packages',
      '/sap/bc/adt/packages',
    ]);
    const post = calls[1]!;
    expect(post.url.searchParams.get('sap-client')).toBe('100');
    expect(header(post, 'Authorization')).toBe(`Basic ${Buffer.from('DEVELOPER:pw"x').toString('base64')}`);
    expect(header(post, 'X-CSRF-Token')).toBe('tok1');
    expect(header(post, 'Cookie')).toBe('SAP_SESSIONID_DEV_100=abc');
  });

  it('a language goes as sap-language on every request, the CSRF fetch too; none without one', async () => {
    const calls = stubFetch((call) =>
      call.url.pathname === '/sap/bc/adt/core/discovery' ? new Response('', { headers: [['x-csrf-token', 'tok1']] }) : new Response('<ok/>'),
    );
    const rest = new RawAdtClient({ baseUrl: 'https://onprem.example:44300', client: '100', language: 'EN', auth: { kind: 'basic', user: 'U', password: 'p' } });
    await rest.request('POST', '/sap/bc/adt/packages', { body: '<x/>' });
    await basicClient().request('GET', '/sap/bc/adt/packages/zx');
    expect(calls.map((c) => c.url.searchParams.get('sap-language'))).toEqual(['EN', 'EN', null]);
  });

  it('refuses sap-language and sap-client in a query before sending anything', async () => {
    const calls = stubFetch(() => new Response('<ok/>'));
    const rest = basicClient();
    await expect(rest.request('GET', '/sap/bc/adt/messageclass/zx', { query: { 'sap-language': 'DE' } })).rejects.toThrow(/RequestOptions\.language/);
    await expect(rest.request('GET', '/sap/bc/adt/messageclass/zx', { query: { 'SAP-Client': '100' } })).rejects.toThrow(/session's client/);
    await expect(rest.request('GET', '/sap/bc/adt/messageclass/zx?sap-language=DE')).rejects.toThrow(/RequestOptions\.language/);
    // A write fetches no CSRF token for a refused call.
    await expect(rest.request('POST', '/sap/bc/adt/messageclass/zx', { query: { 'sap-language': 'DE' }, body: '<x/>' })).rejects.toThrow(
      /RequestOptions\.language/,
    );
    expect(calls).toEqual([]);
    await rest.request('GET', '/sap/bc/adt/messageclass/zx', { language: 'DE' });
    expect(calls.map((c) => c.url.searchParams.get('sap-language'))).toEqual(['DE']);
  });

  it('GET needs no CSRF token', async () => {
    const calls = stubFetch(() => new Response('<pak:package/>'));
    await basicClient().request('GET', '/sap/bc/adt/packages/zx');
    expect(calls).toHaveLength(1);
    expect(header(calls[0]!, 'X-CSRF-Token')).toBeUndefined();
  });

  it('retries once with a fresh token when SAP answers "CSRF token required"', async () => {
    let token = 0;
    let rejected = false;
    const calls = stubFetch((call) => {
      if (call.url.pathname.endsWith('/discovery')) {
        return new Response('', { headers: { 'x-csrf-token': `tok${++token}` } });
      }
      if (!rejected) {
        rejected = true;
        return new Response('', { status: 403, headers: { 'x-csrf-token': 'Required' } });
      }
      return new Response('ok');
    });

    const res = await basicClient().request('DELETE', '/sap/bc/adt/packages/zx');

    expect(res.status).toBe(200);
    expect(header(calls[3]!, 'X-CSRF-Token')).toBe('tok2');
  });

  it('never retries a 401 and flags it as an auth failure', async () => {
    const calls = stubFetch(() => new Response('', { status: 401 }));
    const err = await basicClient()
      .expectOk('GET', '/sap/bc/adt/packages/zx', 'read')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RawAdtError);
    expect((err as RawAdtError).isAuthFailure).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('marks stateful requests with the ADT session type header', async () => {
    const calls = stubFetch(() => new Response('ok'));
    await basicClient().request('GET', '/x', { stateful: true });
    expect(header(calls[0]!, 'X-sap-adt-sessiontype')).toBe('stateful');
  });

  it('runs stateful sequences one after another, even after a failure', async () => {
    const rest = basicClient();
    const order: string[] = [];
    const step = (name: string, ms: number, fail = false) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      if (fail) throw new Error(name);
    };

    await Promise.allSettled([
      rest.stateful(step('a', 20, true)),
      rest.stateful(step('b', 1)),
    ]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('ends the stateful context after a sequence so the next one starts fresh', async () => {
    const calls = stubFetch((call) => {
      if (call.url.pathname.endsWith('/discovery')) return new Response('', { headers: { 'x-csrf-token': 't' } });
      return new Response('ok', { headers: [['set-cookie', 'sap-contextid=ctx1; path=/']] });
    });
    const rest = basicClient();

    await rest.stateful(() => rest.request('POST', '/lock', { stateful: true }));
    await rest.stateful(() => rest.request('POST', '/lock', { stateful: true }));

    const closes = calls.filter((c) => header(c, 'X-sap-adt-sessiontype') === 'stateless');
    expect(closes).toHaveLength(2);
    expect(header(closes[0]!, 'Cookie')).toContain('sap-contextid=ctx1');
    const secondLock = calls.filter((c) => c.url.pathname === '/lock')[1]!;
    expect(header(secondLock, 'Cookie') ?? '').not.toContain('sap-contextid');
  });

  it('mints a reentrance redirect only when the Location carries a ticket', async () => {
    stubFetch((_call, i) =>
      i === 0
        ? new Response('', { status: 307, headers: { location: 'http://localhost:4711/adt/redirect?reentrance-ticket=T&_=1' } })
        : new Response('<html>logon</html>', { status: 200 }),
    );
    const rest = new RawAdtClient({ baseUrl: 'https://my1-api.example', client: '100', auth: { kind: 'cookie' } });

    expect(await rest.mintReentranceRedirect('https://my1.example/sap/bc/adt/core/http/reentranceticket')).toMatch(
      /reentrance-ticket=T/,
    );
    expect(await rest.mintReentranceRedirect('https://my1.example/sap/bc/adt/core/http/reentranceticket')).toBeUndefined();
  });
});

describe('REST timeout', () => {
  afterEach(() => vi.useRealTimers());

  type Answer = Response | 'silent' | ((signal: AbortSignal) => Promise<Response>);

  /** Answers per path; 'silent' never answers, so the request ends only when its signal aborts. */
  function stubAnswers(answer: (path: string) => Answer): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, init: RequestInit = {}) => {
        const call = { url: new URL(String(url)), init };
        calls.push(call);
        const signal = init.signal!;
        const a = answer(call.url.pathname);
        if (a === 'silent') return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
        return typeof a === 'function' ? a(signal) : Promise.resolve(a);
      }),
    );
    return calls;
  }

  const token = () => new Response('', { headers: [['x-csrf-token', 'tok1']] });
  /** A 200 whose body starts and then stalls until the signal aborts. */
  const stalledBody = (signal: AbortSignal) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('<partial'));
            signal.addEventListener('abort', () => c.error(signal.reason));
          },
        }),
      ),
    );

  it("gives up a read SAP doesn't answer after REST_TIMEOUT_MS, as RawAdtTimeoutError rather than RawAdtError", async () => {
    vi.useFakeTimers();
    stubAnswers(() => 'silent');
    const pending = basicClient().request('GET', '/sap/bc/adt/messageclass/zadtplus_x').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REST_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err).toBeInstanceOf(RawAdtTimeoutError);
    expect(err).not.toBeInstanceOf(RawAdtError);
    expect((err as Error).message).toBe('GET /sap/bc/adt/messageclass/zadtplus_x got no answer from SAP within 120 s and was given up');
    expect((err as RawAdtTimeoutError).mayHaveWritten).toBe(false);
  });

  it('a write without an answer may have been done: counted as written, and its message says so', async () => {
    stubAnswers((path) => (path === '/sap/bc/adt/core/discovery' ? token() : 'silent'));
    const run = await trackWrites(() => basicClient().request('POST', '/sap/bc/adt/packages', { body: '<x/>', timeoutMs: 20 }));
    expect(run.ok).toBe(false);
    expect(run.wrote).toBe(true);
    const err = (run as { error: RawAdtTimeoutError }).error;
    expect(err.mayHaveWritten).toBe(true);
    expect(err.message).toBe('POST /sap/bc/adt/packages got no answer from SAP within 20 ms and was given up; whether SAP did it is unknown, so read the current state before trying again');
  });

  it("a write answered 2xx whose body doesn't come counts as written", async () => {
    stubAnswers((path) => (path === '/sap/bc/adt/core/discovery' ? token() : stalledBody));
    const run = await trackWrites(() => basicClient().request('POST', '/sap/bc/adt/packages', { body: '<x/>', timeoutMs: 20 }));
    expect(run.wrote).toBe(true);
    expect(String((run as { error: unknown }).error)).toMatch(/answered HTTP 200, but the rest of the answer didn't come within 20 ms/);
  });

  it("a CSRF fetch that times out sent nothing: the write isn't sent nor counted, and the error is the token fetch's", async () => {
    const calls = stubAnswers(() => 'silent');
    const run = await trackWrites(() => basicClient().request('POST', '/sap/bc/adt/packages', { body: '<x/>', timeoutMs: 20 }));
    expect(calls.map((c) => c.url.pathname)).toEqual(['/sap/bc/adt/core/discovery']);
    expect(run.wrote).toBe(false);
    const err = (run as { error: RawAdtTimeoutError }).error;
    expect(err.path).toBe('/sap/bc/adt/core/discovery');
    expect(err.mayHaveWritten).toBe(false);
  });

  it('one limit covers the CSRF fetch and the request together', async () => {
    vi.useFakeTimers();
    const slowToken = () => new Promise<Response>((resolve) => setTimeout(() => resolve(token()), 70_000));
    stubAnswers((path) => (path === '/sap/bc/adt/core/discovery' ? slowToken : 'silent'));
    const pending = basicClient().request('POST', '/sap/bc/adt/packages', { body: '<x/>' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REST_TIMEOUT_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(RawAdtTimeoutError);
    expect((err as RawAdtTimeoutError).path).toBe('/sap/bc/adt/packages');
  });

  it("the call's limit (withTimeout) replaces the default; a request's own timeoutMs wins over it", async () => {
    stubAnswers(() => 'silent');
    const rest = basicClient();
    const err = await withTimeout(20, () => rest.request('GET', '/sap/bc/adt/packages/z')).catch((e: unknown) => e);
    expect((err as RawAdtTimeoutError).timeoutMs).toBe(20);
    const own = await withTimeout(60_000, () => rest.request('GET', '/sap/bc/adt/packages/z', { timeoutMs: 10 })).catch((e: unknown) => e);
    expect((own as RawAdtTimeoutError).timeoutMs).toBe(10);
    const outside = await withTimeout(20, () => outsideRestCall(() => rest.request('GET', '/sap/bc/adt/packages/z', { timeoutMs: 15 }))).catch((e: unknown) => e);
    expect((outside as RawAdtTimeoutError).timeoutMs).toBe(15);
  });

  it("a command's second timeout with no answer while it waited ends loops (endsLoop); an answer in between starts over", async () => {
    stubAnswers((path) => (path === '/ok' ? new Response('<ok/>') : 'silent'));
    const rest = basicClient();
    const get = (path: string) => rest.request('GET', path, { timeoutMs: 20 }).then(() => undefined, (e: unknown) => e as RawAdtTimeoutError);
    await withTimeout(undefined, async () => {
      const first = await get('/a');
      expect(endsLoop(first)).toBe(false);
      await get('/ok');
      // An answer in the same millisecond a request begins counts as one during its wait.
      await new Promise((r) => setTimeout(r, 2));
      expect(endsLoop(await get('/b'))).toBe(false);
      const ends = await get('/c');
      expect(endsLoop(ends)).toBe(true);
      expect(ends!.message).toMatch(/given up; no request of this command got an answer during this wait or the one just before it, so SAP has likely stopped answering$/);
      // Once SAP is quiet, every later timeout says so too.
      expect(endsLoop(await get('/d'))).toBe(true);
    });
    // Outside a command's scope nothing is counted.
    expect(endsLoop(await get('/e'))).toBe(false);
    expect(endsLoop(await get('/f'))).toBe(false);
  });

  it('a quiet timeout long after the last one is a stuck object, not SAP: a pull with message classes far apart', async () => {
    vi.useFakeTimers();
    stubAnswers(() => 'silent');
    const rest = basicClient();
    const get = (path: string) => rest.request('GET', path).catch((e: unknown) => e);
    const result = withTimeout(undefined, async () => {
      const first = get('/msag/a');
      await vi.advanceTimersByTimeAsync(REST_TIMEOUT_MS);
      const a = await first;
      // Minutes of adt-ls reads, which don't count, then the next message class.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const second = get('/msag/b');
      await vi.advanceTimersByTimeAsync(REST_TIMEOUT_MS);
      const b = await second;
      // Right after it, the next one: SAP silent for two waits in a row.
      const third = get('/msag/c');
      await vi.advanceTimersByTimeAsync(REST_TIMEOUT_MS);
      return [a, b, await third];
    });
    expect((await result).map(endsLoop)).toEqual([false, false, true]);
  });

  it('requests at once count together: two that hang while a third is answered say those objects hang, not SAP', async () => {
    vi.useFakeTimers();
    const later = () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('<ok/>')), 60_000));
    stubAnswers((path) => (path === '/ok' ? later : 'silent'));
    const rest = basicClient();
    const get = (path: string) => rest.request('GET', path).catch((e: unknown) => e);
    const both = withTimeout(undefined, () => Promise.all([get('/a'), get('/b'), get('/ok')]));
    await vi.advanceTimersByTimeAsync(REST_TIMEOUT_MS);
    const [a, b] = await both;
    expect(a).toBeInstanceOf(RawAdtTimeoutError);
    expect([endsLoop(a), endsLoop(b)]).toEqual([false, false]);

    // Without the answer, the second of them ends loops.
    const quiet = withTimeout(undefined, () => Promise.all([get('/c'), get('/d')]));
    await vi.advanceTimersByTimeAsync(REST_TIMEOUT_MS);
    const [c, d] = await quiet;
    expect([endsLoop(c), endsLoop(d)].sort()).toEqual([false, true]);
  });

  it("an answered request leaves no timer behind; other fetch errors pass through", async () => {
    vi.useFakeTimers();
    stubFetch((call) => (call.url.pathname === '/sap/bc/adt/core/discovery' ? token() : new Response('<ok/>')));
    await basicClient().request('POST', '/sap/bc/adt/packages', { body: '<x/>' });
    expect(vi.getTimerCount()).toBe(0);

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))));
    await expect(basicClient().request('GET', '/sap/bc/adt/packages/z')).rejects.toThrow(TypeError);
  });
});

describe('trackWrites', () => {
  it('counts a write SAP answered, not a read and not a write rejected with 401', async () => {
    stubFetch((call) =>
      call.url.pathname === '/sap/bc/adt/core/discovery'
        ? new Response('', { headers: [['x-csrf-token', 'tok1']] })
        : new Response('', {
            status: call.url.pathname.endsWith('/expired') ? 401 : call.url.pathname.endsWith('/refused') ? 403 : call.url.pathname.endsWith('/logon') ? 302 : 200,
          }),
    );
    const rest = basicClient();

    expect((await trackWrites(() => rest.request('GET', '/sap/bc/adt/packages/z'))).wrote).toBe(false);
    expect((await trackWrites(() => rest.request('POST', '/sap/bc/adt/expired'))).wrote).toBe(false);
    expect((await trackWrites(() => rest.request('POST', '/sap/bc/adt/packages'))).wrote).toBe(true);
    // A validation, a lock or a query changes nothing; a write SAP refused changed nothing either.
    expect((await trackWrites(() => rest.request('POST', '/sap/bc/adt/packages/validation', { changesNothing: true }))).wrote).toBe(false);
    expect((await trackWrites(() => rest.request('POST', '/sap/bc/adt/refused'))).wrote).toBe(false);
    // A redirect (to a logon page) did nothing either.
    expect((await trackWrites(() => rest.request('POST', '/sap/bc/adt/logon'))).wrote).toBe(false);
    // A failing call still reports what it wrote before it failed.
    const failed = await trackWrites(async () => {
      await rest.request('POST', '/sap/bc/adt/packages');
      throw new Error('read-back');
    });
    expect(failed).toMatchObject({ ok: false, wrote: true });
  });
});

describe('outsideRestCall', () => {
  it("leaves the call's limit and write log, for what outlives the call", async () => {
    stubFetch((call) =>
      call.url.pathname === '/sap/bc/adt/core/discovery' ? new Response('', { headers: [['x-csrf-token', 'tok1']] }) : new Response(''),
    );
    const rest = basicClient();
    const run = vi.fn();
    const limit: RequestLimit = { run: <T>(fn: () => Promise<T>) => (run(), fn()), observe: () => undefined };
    const tracked = await trackWrites(() =>
      withLimit(limit, () => outsideRestCall(() => rest.request('POST', '/sap/bc/adt/packages'))),
    );
    expect(tracked.wrote).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('parseAdtException', () => {
  it('prefers the localized message', () => {
    const body =
      '<exc:exception xmlns:exc="x"><namespace id="com.sap.adt"/><type id="ExceptionResourceNoAccess"/>' +
      '<message lang="EN">not authorized (S_ABPLNGVS)</message><localizedMessage lang="DE">nicht berechtigt &amp; so</localizedMessage></exc:exception>';
    expect(parseAdtException(body)).toEqual({ type: 'ExceptionResourceNoAccess', message: 'nicht berechtigt & so' });
  });
});
