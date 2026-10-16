import { RawAdtError, type RawAdtClient, type RequestOptions } from '../../src/backends/rawadt.js';

/** One REST request a fake client received. */
export interface Call {
  method: string;
  path: string;
  opts: RequestOptions;
}

/** Answers a request, or undefined for a 404. */
export type Route = (call: Call) => { status?: number; body?: string } | undefined;

/** A REST client that records every request and answers through `route`; `expectOk` throws on 4xx/5xx. */
export function routedRest(route: Route): RawAdtClient & { calls: Call[] } {
  const calls: Call[] = [];
  const request = async (method: string, path: string, opts: RequestOptions = {}) => {
    const call = { method, path, opts };
    calls.push(call);
    const res = route(call) ?? { status: 404 };
    return { status: res.status ?? 200, headers: new Headers(), body: res.body ?? '' };
  };
  return {
    calls,
    request,
    expectOk: async (method: string, path: string, context: string, opts: RequestOptions = {}) => {
      const res = await request(method, path, opts);
      if (res.status >= 400) throw new RawAdtError(res.status, 'ExceptionX', res.body, context);
      return res;
    },
    stateful: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as RawAdtClient & { calls: Call[] };
}

/** A REST client for reads only: `expectOk` answers with the body whose key the path ends with, and throws for any other path. */
export function answeringRest(answers: Record<string, string>): RawAdtClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    expectOk: async (method: string, path: string, _context: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      const key = Object.keys(answers).find((k) => path.endsWith(k));
      if (key === undefined) throw new Error(`unexpected ${path}`);
      return { status: 200, headers: new Headers(), body: answers[key]! };
    },
  } as unknown as RawAdtClient & { calls: Call[] };
}
