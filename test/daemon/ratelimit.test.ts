import { describe, expect, it, vi } from 'vitest';
import { RawAdtClient, RawAdtError, withLimit } from '../../src/backends/rawadt.js';
import { DEFAULT_PER_MINUTE, RateLimiter, ThrottledError, bulkCaps, limitAdt, parseRetryAfter, unitsOf } from '../../src/daemon/ratelimit.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('RateLimiter concurrency', () => {
  it('runs at most `concurrency` calls at once, the rest in FIFO order', async () => {
    const limiter = new RateLimiter('onprem', { concurrency: 2 });
    const gates = [gate(), gate(), gate(), gate()];
    const order: number[] = [];
    const calls = gates.map((g, i) =>
      limiter.run(async () => {
        order.push(i);
        await g.opened;
      }),
    );
    await tick();
    expect(order).toEqual([0, 1]);
    gates[1]!.open();
    await tick();
    expect(order).toEqual([0, 1, 2]);
    gates[0]!.open();
    await tick();
    expect(order).toEqual([0, 1, 2, 3]);
    gates[2]!.open();
    gates[3]!.open();
    await Promise.all(calls);
  });

  it('a call made inside another takes no second slot, so it cannot deadlock', async () => {
    const limiter = new RateLimiter('cloud-erp', { concurrency: 1 });
    // adt-ls's logon callback minting a ticket over REST while the adt-ls call holds the only slot.
    await expect(limiter.run(() => limiter.run(async () => 'ticket'))).resolves.toBe('ticket');
  });

  it('refuses a new command while too many calls wait', async () => {
    const limiter = new RateLimiter('onprem', { concurrency: 1 });
    const g = gate();
    const calls = Array.from({ length: 6 }, () => limiter.run(() => g.opened));
    await tick();
    expect(() => limiter.admit()).toThrow(ThrottledError);
    expect(() => limiter.admit()).toThrow(/5 calls already waiting/);
    g.open();
    await Promise.all(calls);
    expect(() => limiter.admit()).not.toThrow();
  });
});

describe('RateLimiter budget', () => {
  it('refuses admission once the last minute holds the budget, and admits again as calls age out', async () => {
    const c = clock();
    const limiter = new RateLimiter('onprem', { perMinute: 3 }, c.now);
    for (let i = 0; i < 3; i += 1) {
      await limiter.run(async () => null);
      c.advance(10_000);
    }
    let refusal: ThrottledError | undefined;
    try {
      limiter.admit();
    } catch (err) {
      refusal = err as ThrottledError;
    }
    expect(refusal).toBeInstanceOf(ThrottledError);
    expect(refusal?.message).toMatch(/adt\+ system "onprem": throttled — 3 requests \(estimated\) in the last minute \(budget 3\); retry in 30 s/);
    expect(refusal?.retryAfterMs).toBe(30_000);
    c.advance(30_000);
    expect(() => limiter.admit()).not.toThrow();
  });

  it('lets an admitted command finish past the budget; the overshoot delays the next admission', async () => {
    const c = clock();
    const limiter = new RateLimiter('onprem', { perMinute: 2 }, c.now);
    limiter.admit();
    for (let i = 0; i < 5; i += 1) await limiter.run(async () => null);
    let refusal: ThrottledError | undefined;
    try {
      limiter.admit();
    } catch (err) {
      refusal = err as ThrottledError;
    }
    // 5 calls at t0: the window is below the budget of 2 only once all of the first 4 aged out.
    expect(refusal?.retryAfterMs).toBe(60_000);
    c.advance(60_000);
    expect(() => limiter.admit()).not.toThrow();
  });
});

describe('RateLimiter units (ADR-008)', () => {
  it('defaults to 600 estimated requests a minute', () => {
    expect(DEFAULT_PER_MINUTE).toBe(600);
    expect(new RateLimiter('onprem').perMinute).toBe(600);
  });

  it('counts each call by its units, and a call of 0 units not at all', async () => {
    const c = clock();
    const limiter = new RateLimiter('onprem', { perMinute: 10 }, c.now);
    await limiter.run(async () => null, 6);
    c.advance(10_000);
    for (let i = 0; i < 20; i += 1) await limiter.run(async () => null, 0);
    await limiter.run(async () => null, 3);
    expect(() => limiter.admit()).not.toThrow();
    c.advance(10_000);
    await limiter.run(async () => null, 1);
    // 6 + 3 + 1 = 10: refused until the 6 ages out, after which 4 remain.
    expect(() => limiter.admit()).toThrow(/10 requests \(estimated\) in the last minute \(budget 10\); retry in 40 s/);
    c.advance(40_000);
    expect(() => limiter.admit()).not.toThrow();
  });

  it('weighs SDK methods by their traced cost', () => {
    expect(unitsOf('repository', 'abapStat', [])).toBe(0);
    expect(unitsOf('repository', 'search', ['Z*'])).toBe(1);
    expect(unitsOf('repository', 'getLsUri', [''])).toBe(1);
    expect(unitsOf('repository', 'readDirectory', [''])).toBe(1);
    expect(unitsOf('lifecycle', 'resolveAffUri', [{}])).toBe(2);
    expect(unitsOf('repository', 'readFile', [''])).toBe(2);
    expect(unitsOf('source', 'read', [{ name: 'ZX', objectType: 'CLAS/OC' }])).toBe(2);
    expect(unitsOf('lifecycle', 'update', [{}])).toBe(6);
    expect(unitsOf('repository', 'writeFile', ['', ''])).toBe(6);
    expect(unitsOf('lifecycle', 'create', [{}])).toBe(6);
  });

  it('weighs raw.lsp by its LSP method, activation by its object URIs, the active read as untraced', () => {
    expect(unitsOf('raw', 'lsp', ['adtLs/fileSystem/abapStat', {}])).toBe(0);
    expect(unitsOf('raw', 'lsp', ['adtLs/fileSystem/getPackageName', {}])).toBe(0);
    expect(unitsOf('raw', 'lsp', ['adtLs/fileSystem/stat', {}])).toBe(1);
    expect(unitsOf('raw', 'lsp', ['adtLs/activation/activate', { fileUris: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }])).toBe(24);
    expect(unitsOf('raw', 'lsp', ['adtLs/activation/activate', { fileUris: [] }])).toBe(3);
    expect(unitsOf('raw', 'lsp', ['adtLs/something/else', {}])).toBe(3);
    expect(unitsOf('source', 'read', [{ name: 'ZX', objectType: 'CLAS/OC', version: 'active' }])).toBe(3);
  });

  it('weighs an untraced method 3, prototype names included', () => {
    expect(unitsOf('quality', 'runAtc', [{}])).toBe(3);
    expect(unitsOf('repository', 'delete', [''])).toBe(3);
    expect(unitsOf('repository', 'constructor', [])).toBe(3);
  });
});

describe('RateLimiter bulk lane (ADR-008)', () => {
  it('caps calls in flight per channel, apart from the interactive slots', async () => {
    const limiter = new RateLimiter('onprem', { concurrency: 1 });
    const g = gate();
    const started: string[] = [];
    const call = (name: string, channel: 'adt' | 'rest') =>
      limiter.run(
        async () => {
          started.push(name);
          await g.opened;
        },
        1,
        channel,
      );
    const bulk = limiter.bulk({ adt: 2, rest: 3 }, () =>
      Promise.all([call('a1', 'adt'), call('a2', 'adt'), call('a3', 'adt'), call('r1', 'rest'), call('r2', 'rest'), call('r3', 'rest')]),
    );
    const interactive = call('i1', 'adt');
    await tick();
    expect(started.sort()).toEqual(['a1', 'a2', 'i1', 'r1', 'r2', 'r3']);
    g.open();
    await Promise.all([bulk, interactive]);
    expect(started).toContain('a3');
  });

  it('keeps its units out of the per-minute budget', async () => {
    const limiter = new RateLimiter('onprem', { perMinute: 2 });
    await limiter.bulk({ adt: 3, rest: 3 }, async () => {
      for (let i = 0; i < 5; i += 1) await limiter.run(async () => {}, 2, 'adt');
    });
    expect(() => limiter.admit()).not.toThrow();
  });

  it('a call made inside a bulk call takes no second slot', async () => {
    const limiter = new RateLimiter('cloud-erp', {});
    const result = limiter.bulk({ adt: 1, rest: 1 }, () => limiter.run(() => limiter.run(async () => 'ticket'), 1, 'adt'));
    await expect(result).resolves.toBe('ticket');
  });

  it('stops for a cooldown like the interactive lane', async () => {
    const limiter = new RateLimiter('onprem', {});
    limiter.observe(429, '5');
    await expect(limiter.bulk({ adt: 3, rest: 3 }, () => limiter.run(async () => {}, 1, 'adt'))).rejects.toThrow(ThrottledError);
  });

  it('what a bulk command opens outside the lane stays interactive, its later callbacks too', async () => {
    const limiter = new RateLimiter('onprem', { perMinute: 2 });
    let later!: Promise<void>;
    await limiter.bulk({ adt: 3, rest: 3 }, () =>
      limiter.outsideBulk(async () => {
        // A session's callback, fired after the command: here a timer set up while opening it.
        later = new Promise((resolve) => setTimeout(() => void limiter.run(async () => {}, 2).then(resolve), 0));
      }),
    );
    await later;
    expect(() => limiter.admit()).toThrow(/2 requests \(estimated\)/);
  });

  it('shares one pool per channel when commands bring other caps, sized by the latest', async () => {
    const limiter = new RateLimiter('onprem', {});
    const g = gate();
    let running = 0;
    let most = 0;
    const call = () =>
      limiter.run(async () => {
        running += 1;
        most = Math.max(most, running);
        await g.opened;
        running -= 1;
      });
    const first = limiter.bulk({ adt: 1, rest: 1 }, () => Promise.all([call(), call()]));
    const second = limiter.bulk({ adt: 2, rest: 2 }, () => Promise.all([call(), call()]));
    await tick();
    expect(running).toBe(2);
    g.open();
    await Promise.all([first, second]);
    expect(most).toBe(2);
  });

  it('takes mirror.concurrency as its caps: REST in full, adt-ls at most 3, 5 at most', () => {
    expect(bulkCaps()).toEqual({ rest: 3, adt: 3 });
    expect(bulkCaps(1)).toEqual({ rest: 1, adt: 1 });
    expect(bulkCaps(5)).toEqual({ rest: 5, adt: 3 });
    expect(bulkCaps(9)).toEqual({ rest: 5, adt: 3 });
  });
});

describe('RateLimiter cooldown', () => {
  it('honours a 429 Retry-After in seconds: admissions and calls mid-command are refused until then', async () => {
    const c = clock();
    const limiter = new RateLimiter('onprem', {}, c.now);
    limiter.observe(429, '12');
    expect(() => limiter.admit()).toThrow(/SAP asked adt\+ to back off; retry in 12 s/);
    const fn = vi.fn(async () => null);
    await expect(limiter.run(fn)).rejects.toBeInstanceOf(ThrottledError);
    expect(fn).not.toHaveBeenCalled();
    c.advance(12_000);
    await expect(limiter.run(fn)).resolves.toBeNull();
  });

  it('reads Retry-After as an HTTP date, and waits 30 s after a 503 without one', () => {
    const c = clock(Date.parse('2026-09-28T12:00:00Z'));
    expect(parseRetryAfter('Mon, 28 Sep 2026 12:00:45 GMT', c.now())).toBe(45_000);
    expect(parseRetryAfter('garbage', c.now())).toBeUndefined();
    const limiter = new RateLimiter('cloud-erp', {}, c.now);
    limiter.observe(503, null);
    c.advance(29_000);
    expect(() => limiter.admit()).toThrow(ThrottledError);
    c.advance(1_000);
    expect(() => limiter.admit()).not.toThrow();
  });

  it('ignores other statuses', () => {
    const limiter = new RateLimiter('onprem');
    limiter.observe(500, '60');
    limiter.observe(401, null);
    expect(() => limiter.admit()).not.toThrow();
  });

  it('backs off after an adt-ls error that names HTTP 429 or 503, never on a bare number', async () => {
    const c = clock();
    const limiter = new RateLimiter('onprem', {}, c.now);
    await expect(
      limiter.run(async () => {
        throw new Error('Syntax error in line 503: field "X" is unknown');
      }),
    ).rejects.toThrow();
    expect(() => limiter.admit()).not.toThrow();
    await expect(
      limiter.run(async () => {
        throw new Error('Execution of request "GET /sap/bc/adt/x" failed: HTTP/1.1 429 Too Many Requests');
      }),
    ).rejects.toThrow(/429/);
    expect(() => limiter.admit()).toThrow(ThrottledError);
  });

  it('backs off after a REST 429, taking Retry-After from the response', async () => {
    const c = clock();
    const limiter = new RateLimiter('onprem', {}, c.now);
    const rest = new RawAdtClient({ baseUrl: 'https://onprem.example', client: '100', auth: { kind: 'cookie' } });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }));
    try {
      const res = await withLimit(limiter, () => rest.request('GET', '/sap/bc/adt/packages/x'));
      expect(res.status).toBe(429);
      expect(() => limiter.admit()).toThrow(/retry in 7 s/);
      await expect(withLimit(limiter, () => rest.request('GET', '/sap/bc/adt/packages/y'))).rejects.toBeInstanceOf(ThrottledError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('counts each REST request against the limit of the call it runs in, on one shared client', async () => {
    const a = new RateLimiter('onprem', { perMinute: 100 });
    const b = new RateLimiter('onprem', { perMinute: 100 });
    const runs = { a: vi.spyOn(a, 'run'), b: vi.spyOn(b, 'run') };
    const rest = new RawAdtClient({ baseUrl: 'https://onprem.example', client: '100', auth: { kind: 'cookie' } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<ok/>'));
    try {
      // A's call is still running when B's starts: B must not take over A's later requests.
      const callA = withLimit(a, async () => {
        await rest.request('GET', '/sap/bc/adt/a1');
        await gate;
        await rest.request('GET', '/sap/bc/adt/a2');
      });
      await vi.waitFor(() => expect(runs.a).toHaveBeenCalledTimes(1));
      await withLimit(b, () => rest.request('GET', '/sap/bc/adt/b1'));
      release();
      await callA;
      expect(runs.a).toHaveBeenCalledTimes(2);
      expect(runs.b).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('does not treat a RawAdtError other than 429/503 as a back-off', async () => {
    const limiter = new RateLimiter('onprem');
    await expect(
      limiter.run(async () => {
        throw new RawAdtError(500, undefined, 'boom', 'package read');
      }),
    ).rejects.toThrow();
    expect(() => limiter.admit()).not.toThrow();
  });
});

describe('limitAdt', () => {
  it('counts every namespaced SDK call by its units, and leaves top-level methods alone', async () => {
    const c = clock();
    const limiter = new RateLimiter('onprem', { perMinute: 2 }, c.now);
    const adt = {
      health: vi.fn(() => ({ destination: 'adtplus_onprem' })),
      lifecycle: { resolveAffUri: vi.fn(async (r: { name: string }) => `abap:/${r.name}`) },
      raw: { lsp: vi.fn(async (_method: string, _params: unknown) => ({ version: 0 })) },
    };
    const limited = limitAdt(adt, limiter);

    await expect(limited.lifecycle.resolveAffUri({ name: 'ZX' })).resolves.toBe('abap:/ZX');
    expect(() => limiter.admit()).toThrow(/2 requests \(estimated\) in the last minute/);
    // abapStat over raw.lsp weighs nothing; health is not an SDK call to SAP.
    await limited.raw.lsp('adtLs/fileSystem/abapStat', {});
    limited.health();
    expect(() => limiter.admit()).toThrow(/2 requests \(estimated\)/);
    expect(adt.lifecycle.resolveAffUri).toHaveBeenCalledWith({ name: 'ZX' });
  });
});
