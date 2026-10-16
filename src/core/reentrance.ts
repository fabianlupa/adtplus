import { createServer } from 'node:http';
import { RawAdtClient } from '../backends/rawadt.js';

const REENTRANCE_PATH = '/sap/bc/adt/core/http/reentranceticket';
const DEFAULT_CAPTURE_TIMEOUT_MS = 180_000;

/**
 * The SSO host a cloud system's reentrance logon runs on: the API host
 * without `-api` (my000000-api.s4hana.cloud.sap → my000000.s4hana.cloud.sap).
 * adt-ls's own logonUrl uses that host too.
 */
export function defaultReentranceUrl(systemUrl: string): string {
  const url = new URL(systemUrl);
  url.hostname = url.hostname.replace(/-api(?=\.)/, '');
  return url.origin;
}

export interface CaptureOptions {
  reentranceUrl: string;
  openUrl: (url: string) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Open one browser window at the reentrance logon and wait for SAP to
 * redirect back to a one-shot localhost listener with `reentrance-ticket`.
 * The ticket is single-use (ADR-001) and never logged.
 */
export function captureReentranceTicket(opts: CaptureOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const ticket = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('reentrance-ticket');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h3>adt+: connected. You can close this tab.</h3></body></html>');
      if (!ticket) return;
      clearTimeout(timer);
      server.close();
      resolve(ticket);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`reentrance logon timed out after ${(opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS) / 1000}s`));
    }, opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const logonUrl = new URL(REENTRANCE_PATH, opts.reentranceUrl);
      logonUrl.searchParams.set('redirect-url', `http://localhost:${port}/adt/redirect`);
      logonUrl.searchParams.set('_', String(Date.now()));
      opts.openUrl(logonUrl.toString()).catch((err: unknown) => {
        clearTimeout(timer);
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  });
}

/**
 * Redeem a reentrance ticket into a REST session on the API host:
 * `MYSAPSSO2: <ticket>` + `x-sap-security-session: create` on the discovery
 * document mints `SAP_SESSIONID_*` and a CSRF token (verified live on `cloud-erp`).
 */
export async function redeemReentranceTicket(baseUrl: string, client: string, ticket: string, language?: string): Promise<RawAdtClient> {
  const rest = new RawAdtClient({ baseUrl, client, ...(language ? { language } : {}), auth: { kind: 'cookie' } });
  const url = new URL('/sap/bc/adt/core/discovery', baseUrl);
  url.searchParams.set('sap-client', client);
  if (language) url.searchParams.set('sap-language', language);
  const res = await fetch(url, {
    redirect: 'manual',
    headers: {
      MYSAPSSO2: ticket,
      'x-sap-security-session': 'create',
      'X-CSRF-Token': 'Fetch',
      'X-sap-client': client,
      Accept: 'application/atomsvc+xml',
    },
  });
  await res.text();
  if (res.status !== 200) {
    throw new Error(`reentrance ticket redeem failed (HTTP ${res.status})`);
  }
  rest.absorbCookies(res.headers);
  rest.setCsrfToken(res.headers.get('x-csrf-token') ?? undefined);
  return rest;
}
