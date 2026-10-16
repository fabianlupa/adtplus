import type { RawAdtClient } from '../backends/rawadt.js';

/**
 * The system's two time scales besides UTC, measured (docs/decisions/016-system-clock.md).
 *
 * - **Local**: the system clock, as CTS answers (`tm:lastchanged_timestamp`, a `tm:root`'s
 *   `adtcore:changedAt`, labelled `Z`).
 * - **Feed**: ADT's feed times, labelled `Z` (version feeds, dumps, gateway errors, system
 *   messages, and the filters on them).
 *
 * SAP names neither zone, so each offset is a "now" in that scale less the Mac's clock, rounded to
 * 15 minutes, which absorbs the request's own time and a few seconds of drift.
 */
export interface SystemClock {
  /** The system clock ahead of UTC, in minutes; absent when it didn't measure (`errors.local`). */
  localOffsetMinutes?: number;
  /** ADT's feed times ahead of UTC, in minutes; absent when they didn't measure (`errors.feed`). */
  feedOffsetMinutes?: number;
  /** Why a scale didn't measure. */
  errors?: { local?: string; feed?: string };
  /** When it was measured (UTC). */
  measuredAt: string;
}

/** A request list matching no one: its root's `changedAt` is the answer's own time, nothing else (0.3 KB). */
const LOCAL_NOW = '/sap/bc/adt/cts/transportrequests';
/**
 * The dump feed asked for a user that doesn't exist: no entry, so no runtime log is read, and its
 * own `atom:updated` is the answer's time in the feed scale (0.6 KB).
 */
const FEED_NOW = '/sap/bc/adt/runtime/dumps';
const NOBODY = 'ADTPLUS_NOBODY';

/** `ms` as ISO 8601 UTC without milliseconds, as SAP writes its times. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Minutes `stamp` (labelled UTC) runs ahead of `at` (the Mac's time of the answer), to 15 minutes. */
export function offsetOf(stamp: string | undefined, at: number): number | undefined {
  const t = stamp === undefined ? NaN : Date.parse(stamp);
  if (Number.isNaN(t)) return undefined;
  // `|| 0` turns a rounded -0 into 0.
  return Math.round((t - at) / (15 * 60_000)) * 15 || 0;
}

/** How far the clock runs ahead of UTC, from a `tm:root` list's `changedAt`; undefined when it has none. */
export function clockOffset(xml: string, at: number): number | undefined {
  return offsetOf(xml.match(/<tm:root\b[^>]*\badtcore:changedAt="([^"]*)"/)?.[1], at);
}

/** An Atom feed's own `atom:updated` (before its first entry). */
function feedUpdated(xml: string): string | undefined {
  const head = xml.split(/<atom:entry\b/)[0]!;
  return head.match(/<atom:updated>([^<]*)<\/atom:updated>/)?.[1];
}

/** A scale that didn't measure: whether asking again soon could change that. */
export class ClockError extends Error {
  constructor(
    message: string,
    /** A refusal (4xx other than 401) or an answer without a time: the same next time. */
    readonly settled: boolean,
  ) {
    super(message);
  }
}

/**
 * Both offsets, 2 requests at once, each scale on its own: one that doesn't measure leaves the
 * other. `settled` says whether the result holds (both measured, or each failure is one that would
 * repeat); a passing failure (network, 5xx, a logon) is worth asking again at the next call. The
 * rate limit's refusal is thrown.
 */
export async function measureClock(rest: RawAdtClient, isFatal: (err: unknown) => boolean): Promise<{ clock: SystemClock; settled: boolean }> {
  const timed = async (path: string, query: Record<string, string>, accept: string, read: (body: string, at: number) => number | undefined, what: string) => {
    const sent = Date.now();
    let body: string;
    try {
      body = (await rest.expectOk('GET', path, 'measure the system clock', { query, headers: { Accept: accept } })).body;
    } catch (err) {
      if (isFatal(err)) throw err;
      const status = (err as { status?: unknown }).status;
      const settled = typeof status === 'number' && status >= 400 && status < 500 && status !== 401;
      throw new ClockError(err instanceof Error ? err.message : String(err), settled);
    }
    const offset = read(body, (sent + Date.now()) / 2);
    if (offset === undefined) throw new ClockError(`${what} named no time`, true);
    return offset;
  };
  const [local, feed] = await Promise.allSettled([
    timed(LOCAL_NOW, { user: NOBODY, targets: 'false' }, 'application/vnd.sap.adt.transportorganizertree.v1+xml', clockOffset, 'the request list'),
    timed(FEED_NOW, { $top: '1', $query: `and(equals(user,${NOBODY}))` }, 'application/atom+xml;type=feed', (b, at) => offsetOf(feedUpdated(b), at), 'the dump feed'),
  ]);
  for (const r of [local, feed]) if (r.status === 'rejected' && !(r.reason instanceof ClockError)) throw r.reason;
  const why = (r: PromiseSettledResult<number>) => (r.status === 'rejected' ? (r.reason as ClockError).message : undefined);
  const errors = { ...(why(local) ? { local: why(local) } : {}), ...(why(feed) ? { feed: why(feed) } : {}) };
  const clock: SystemClock = {
    ...(local.status === 'fulfilled' ? { localOffsetMinutes: local.value } : {}),
    ...(feed.status === 'fulfilled' ? { feedOffsetMinutes: feed.value } : {}),
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
    measuredAt: isoUtc(Date.now()),
  };
  const settled = [local, feed].every((r) => r.status === 'fulfilled' || (r.reason as ClockError).settled);
  return { clock, settled };
}

/** A feed time (labelled `Z`) as UTC; one that isn't a time is returned as it is. */
export function fromFeed(stamp: string, feedOffsetMinutes: number): string {
  const t = Date.parse(stamp);
  return Number.isNaN(t) ? stamp : isoUtc(t - feedOffsetMinutes * 60_000);
}

/** A local `YYYYMMDDhhmmss` as UTC ISO, given the clock's offset; undefined when it isn't one. */
export function localToUtc(stamp: string | undefined, offsetMinutes: number): string | undefined {
  const m = stamp?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1990) return undefined;
  return isoUtc(Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000);
}

/** What a capability gets: the measured clock (a scale that didn't measure is absent in it). */
export type ClockRead = SystemClock;

/** A feed time as UTC when the feed scale measured, else as sent. */
export function feedTime(stamp: string, clock: ClockRead | undefined): string {
  return clock?.feedOffsetMinutes !== undefined ? fromFeed(stamp, clock.feedOffsetMinutes) : stamp;
}

/** A UTC `YYYYMMDDhhmmss` bound in the feed scale (the dumps' `from`/`to`), else as it is. */
export function feedBound(stamp: string | undefined, clock: ClockRead | undefined): string | undefined {
  if (stamp === undefined || clock?.feedOffsetMinutes === undefined) return stamp;
  // A UTC stamp shifted into the feed scale: `localToUtc` with the offset negated.
  const iso = localToUtc(stamp, -clock.feedOffsetMinutes);
  return iso ? iso.replace(/[-:TZ]/g, '') : stamp;
}

/** `{ notes }` when `scale`'s times stay as the system sent them, else nothing. */
export function notesOf(clock: ClockRead | undefined, scale: 'local' | 'feed'): { notes?: string[] } {
  if (!clock) return {};
  const measured = scale === 'local' ? clock.localOffsetMinutes : clock.feedOffsetMinutes;
  if (measured !== undefined) return {};
  const why = clock.errors?.[scale] ?? 'not measured';
  return { notes: [`times as the system sent them, not corrected to UTC: the system clock didn't measure (${why})`] };
}
