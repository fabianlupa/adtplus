import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureReentranceTicket,
  defaultReentranceUrl,
  redeemReentranceTicket,
} from '../../src/core/reentrance.js';

afterEach(() => vi.unstubAllGlobals());

describe('defaultReentranceUrl', () => {
  it('drops -api from a cloud API host', () => {
    expect(defaultReentranceUrl('https://my000000-api.s4hana.cloud.sap')).toBe('https://my000000.s4hana.cloud.sap');
  });

  it('leaves other hosts alone', () => {
    expect(defaultReentranceUrl('https://onprem.example:44300/')).toBe('https://onprem.example:44300');
  });
});

describe('captureReentranceTicket', () => {
  it('opens the logon URL and resolves with the ticket SAP redirects back', async () => {
    let opened = '';
    const ticket = captureReentranceTicket({
      reentranceUrl: 'https://my1.example',
      openUrl: async (url) => {
        opened = url;
        const redirect = new URL(url).searchParams.get('redirect-url')!;
        await fetch(`${redirect}?reentrance-ticket=TICKET123&_=1`);
      },
      timeoutMs: 5000,
    });

    await expect(ticket).resolves.toBe('TICKET123');
    const logon = new URL(opened);
    expect(logon.origin + logon.pathname).toBe('https://my1.example/sap/bc/adt/core/http/reentranceticket');
    expect(logon.searchParams.get('redirect-url')).toMatch(/^http:\/\/localhost:\d+\/adt\/redirect$/);
  });

  it('rejects when opening the browser fails', async () => {
    await expect(
      captureReentranceTicket({ reentranceUrl: 'https://my1.example', openUrl: async () => Promise.reject(new Error('no open')) }),
    ).rejects.toThrow('no open');
  });
});

describe('redeemReentranceTicket', () => {
  it('redeems with MYSAPSSO2 and keeps the session cookie and CSRF token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response('', {
        headers: [
          ['set-cookie', 'SAP_SESSIONID_DEV_100=s1; path=/; secure'],
          ['set-cookie', 'sap-usercontext=sap-client=100; path=/'],
          ['x-csrf-token', 'csrf1'],
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rest = await redeemReentranceTicket('https://my1-api.example', '100', 'TICKET');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://my1-api.example/sap/bc/adt/core/discovery?sap-client=100');
    expect((init!.headers as Record<string, string>).MYSAPSSO2).toBe('TICKET');
    expect((init!.headers as Record<string, string>)['x-sap-security-session']).toBe('create');
    expect(rest.authKind).toBe('cookie');
    expect(rest.cookieHeader()).toBe('SAP_SESSIONID_DEV_100=s1; sap-usercontext=sap-client=100');
    expect(await rest.csrf()).toBe('csrf1');
  });

  it('a language goes on the redeem, where the session takes it, and on every later request', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('', { headers: [['x-csrf-token', 'csrf1']] }));
    vi.stubGlobal('fetch', fetchMock);
    const rest = await redeemReentranceTicket('https://my1-api.example', '100', 'TICKET', 'EN');
    await rest.request('GET', '/sap/bc/adt/packages/zx');
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('sap-language'))).toEqual(['EN', 'EN']);
  });

  it('throws on a failed redeem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(redeemReentranceTicket('https://my1-api.example', '100', 'T')).rejects.toThrow(/HTTP 401/);
  });
});
