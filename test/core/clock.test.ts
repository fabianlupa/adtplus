import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawAdtError, type RawAdtClient } from '../../src/backends/rawadt.js';
import { ThrottledError } from '../../src/daemon/ratelimit.js';
import { feedBound, feedTime, fromFeed, localToUtc, measureClock, notesOf, offsetOf, type SystemClock } from '../../src/core/clock.js';

// Shapes from ONPREM's answers (2026-10-12): the clock at UTC+1, the feeds at UTC-1.
const NOW = Date.parse('2026-10-12T08:44:06Z');
const ONPREM: SystemClock = { localOffsetMinutes: 60, feedOffsetMinutes: -60, measuredAt: '2026-10-12T08:44:06Z' };
const LOCAL = '/sap/bc/adt/cts/transportrequests';
const FEED = '/sap/bc/adt/runtime/dumps';

function fakeRest(answers: Record<string, string | Error>): RawAdtClient & { calls: Array<{ path: string; query?: Record<string, string> }> } {
  const calls: Array<{ path: string; query?: Record<string, string> }> = [];
  return {
    calls,
    expectOk: async (_m: string, path: string, _c: string, opts: { query?: Record<string, string> } = {}) => {
      calls.push({ path, query: opts.query });
      const a = answers[path];
      if (a instanceof Error) throw a;
      return { status: 200, headers: new Headers(), body: a ?? '' };
    },
  } as unknown as RawAdtClient & { calls: Array<{ path: string; query?: Record<string, string> }> };
}

const LIST = (at: string) => `<tm:root adtcore:name="ADTPLUS_NOBODY" adtcore:changedAt="${at}" xmlns:tm="t" xmlns:adtcore="a"/>`;
const DUMPS = (at: string) => `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>ABAP Short Dump Analysis</atom:title><atom:updated>${at}</atom:updated></atom:feed>`;
const never = () => false;

describe('measureClock', () => {
  afterEach(() => vi.useRealTimers());

  it("takes each scale less the Mac's clock, to 15 minutes, reading no dump", async () => {
    vi.useFakeTimers({ now: NOW });
    const rest = fakeRest({ [LOCAL]: LIST('2026-10-12T09:44:04Z'), [FEED]: DUMPS('2026-10-12T07:44:04Z') });
    expect(await measureClock(rest, never)).toEqual({ clock: ONPREM, settled: true });
    expect(rest.calls.find((c) => c.path === FEED)!.query).toEqual({ $top: '1', $query: 'and(equals(user,ADTPLUS_NOBODY))' });
  });

  it("keeps the scale that measured; a refusal or an answer without time is settled", async () => {
    vi.useFakeTimers({ now: NOW });
    const refused = fakeRest({ [LOCAL]: LIST('2026-10-12T09:44:04Z'), [FEED]: new RawAdtError(403, undefined, 'no authorization', 'x') });
    const a = await measureClock(refused, never);
    expect(a.clock).toMatchObject({ localOffsetMinutes: 60, errors: { feed: expect.stringMatching(/no authorization/) } });
    expect(a.clock.feedOffsetMinutes).toBeUndefined();
    expect(a.settled).toBe(true);
    const timeless = await measureClock(fakeRest({ [LOCAL]: '<tm:root/>', [FEED]: DUMPS('2026-10-12T07:44:04Z') }), never);
    expect(timeless).toMatchObject({ clock: { feedOffsetMinutes: -60, errors: { local: 'the request list named no time' } }, settled: true });
  });

  it('calls a passing failure unsettled, and throws what the caller calls fatal', async () => {
    const blip = await measureClock(fakeRest({ [LOCAL]: new RawAdtError(503, undefined, 'down', 'x'), [FEED]: DUMPS('2026-10-12T07:44:04Z') }), never);
    expect(blip.settled).toBe(false);
    const network = await measureClock(fakeRest({ [LOCAL]: new Error('ECONNRESET'), [FEED]: DUMPS('2026-10-12T07:44:04Z') }), never);
    expect(network.settled).toBe(false);
    const throttled = new ThrottledError('over budget', 1000);
    await expect(measureClock(fakeRest({ [LOCAL]: throttled, [FEED]: DUMPS('x') }), (e) => e instanceof ThrottledError)).rejects.toBe(throttled);
  });
});

describe('conversions', () => {
  it('rounds an offset to 15 minutes, never -0', () => {
    expect(offsetOf('2026-10-12T08:44:04Z', NOW)).toBe(0);
    expect(Object.is(offsetOf('2026-10-12T08:43:04Z', NOW), 0)).toBe(true);
    expect(offsetOf('2026-10-12T14:14:06Z', NOW)).toBe(330);
    expect(offsetOf('x', NOW)).toBeUndefined();
  });

  it('turns feed times into UTC and UTC bounds into the feed scale, only when the feed measured', () => {
    expect(fromFeed('2026-10-07T07:38:21Z', -60)).toBe('2026-10-07T08:38:21Z');
    expect(feedTime('2026-10-07T07:38:21Z', ONPREM)).toBe('2026-10-07T08:38:21Z');
    expect(feedTime('2026-10-07T07:38:21Z', { localOffsetMinutes: 60, measuredAt: 'x' })).toBe('2026-10-07T07:38:21Z');
    expect(feedTime('', ONPREM)).toBe('');
    expect(feedBound('20261012080000', ONPREM)).toBe('20261012070000');
    expect(feedBound('20261012080000', undefined)).toBe('20261012080000');
  });

  it("agrees with a release's request time on ONPREM", () => {
    // DEVK914179: lastchanged 09:38:32 local, its version's feed time 07:38:21Z: the same release.
    expect(localToUtc('20261007093832', ONPREM.localOffsetMinutes!)).toBe('2026-10-07T08:38:32Z');
    expect(feedTime('2026-10-07T07:38:21Z', ONPREM)).toBe('2026-10-07T08:38:21Z');
  });

  it('notes a scale that did not measure, with why', () => {
    expect(notesOf(ONPREM, 'feed')).toEqual({});
    expect(notesOf(undefined, 'feed')).toEqual({});
    expect(notesOf({ localOffsetMinutes: 60, errors: { feed: 'refused' }, measuredAt: 'x' }, 'feed').notes?.[0]).toMatch(/not corrected to UTC.*\(refused\)/);
  });
});
