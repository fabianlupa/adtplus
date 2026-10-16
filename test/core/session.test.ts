import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../src/core/destinations.js';
import type { SessionProvider } from '../../src/core/session.js';

const createAdtLsMock = vi.fn();
const customMock = vi.fn((register: (driver: unknown) => void) => ({
  kind: 'custom',
  register,
}));
const interactiveMock = vi.fn((cb: unknown) => ({ kind: 'interactive', ...(cb as object) }));

vi.mock('@arc-mcp/adt-ls', () => ({
  createAdtLs: createAdtLsMock,
  custom: customMock,
  interactive: interactiveMock,
}));

const readKeychainSecretMock = vi.fn(async () => 'super"secret');
vi.mock('../../src/core/keychain.js', () => ({
  readKeychainSecret: readKeychainSecretMock,
}));

const { AdtLsBasicProvider, AdtLsInteractiveProvider, SessionManager } = await import(
  '../../src/core/session.js'
);
const { RawAdtError, markWrite } = await import('../../src/backends/rawadt.js');
type RawAdtClient = import('../../src/backends/rawadt.js').RawAdtClient;
type ConnectContext = import('../../src/core/session.js').ConnectContext;

/**
 * Pull the logon handler out of the `custom()` strategy the provider
 * registered. `custom()` runs after the keychain read resolves, so give the
 * connect a few microtasks to get there.
 */
async function logonHandler(): Promise<(params: unknown) => boolean> {
  for (let i = 0; i < 20 && customMock.mock.calls.length === 0; i++) await Promise.resolve();
  const registerFn = customMock.mock.calls[0]![0] as (driver: {
    setRequestHandler: (method: string, handler: (params: unknown) => boolean) => void;
  }) => void;
  let handler: ((params: unknown) => boolean) | undefined;
  registerFn({
    setRequestHandler: (_method, h) => {
      handler = h;
    },
  });
  return handler!;
}

const LOGON_PARAMS = {
  url: 'https://onprem.example/sap/bc/adt/core/http/reentranceticket?redirect-url=x&_=1',
};

/** adt-ls only settles createAdtLs once the logon completes — never, if it failed. */
const NEVER = new Promise<never>(() => undefined);

function fakeAdtClient(destination: string): AdtLsClient {
  return {
    health: () => ({ connected: true, backendLive: true, destination, mcpPort: 1234 }),
    dispose: vi.fn(async () => undefined),
  } as unknown as AdtLsClient;
}

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example:44300',
  user: 'DEVELOPER',
  keychainService: 'DEV_100_SECRET',
  extraCaCerts: ['/ca.pem'],
  writeAllowlist: ['ZADTPLUS_TEST'],
};

const cloudErp: Destination = {
  id: 'cloud-erp',
  kind: 'cloud',
  auth: 'interactive',
  client: '100',
  systemUrl: 'https://my000000-api.s4hana.cloud.sap',
  extraCaCerts: [],
  writeAllowlist: ['ZADTPLUS_TEST'],
};

beforeEach(() => {
  createAdtLsMock.mockReset();
  customMock.mockClear();
  interactiveMock.mockClear();
  readKeychainSecretMock.mockClear();
});

describe('AdtLsBasicProvider (ONPREM)', () => {
  it('logs adt-ls on in the system\'s language, EN unless set', async () => {
    createAdtLsMock.mockResolvedValue(fakeAdtClient('adtplus_onprem'));
    await new AdtLsBasicProvider().connect('onprem', onprem);
    await new AdtLsBasicProvider().connect('onprem', { ...onprem, language: 'de' });
    const languages = createAdtLsMock.mock.calls.slice(-2).map(([opts]) => (opts as { connection: { language: string } }).connection.language);
    expect(languages).toEqual(['EN', 'DE']);
  });

  it('appends sap-client to the reentrance URL and sends Basic auth, exactly once', async () => {
    createAdtLsMock.mockResolvedValue(fakeAdtClient('adtplus_onprem'));
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      headers: new Headers(),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AdtLsBasicProvider();
    await provider.connect('onprem', onprem);

    expect(readKeychainSecretMock).toHaveBeenCalledWith('DEV_100_SECRET');
    expect(customMock).toHaveBeenCalledTimes(1);

    // Pull out the handler the register callback installed on the fake driver.
    const registerFn = customMock.mock.calls[0]![0] as (driver: {
      setRequestHandler: (method: string, handler: (params: unknown) => boolean) => void;
    }) => void;
    let handler: ((params: unknown) => boolean) | undefined;
    registerFn({
      setRequestHandler: (_method, h) => {
        handler = h;
      },
    });

    const params = { url: 'https://onprem.example/sap/bc/adt/core/http/reentranceticket?redirect-url=x&_=1' };
    expect(handler!(params)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('sap-client=100');
    const auth = calledInit!.headers as Record<string, string>;
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('DEVELOPER:super"secret').toString('base64')}`);

    // Second attempt within the same connect() call must not retry (ADR-001 finding 3).
    expect(handler!(params)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes connection options through to createAdtLs', async () => {
    createAdtLsMock.mockResolvedValue(fakeAdtClient('adtplus_onprem'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ headers: new Headers() })));

    await new AdtLsBasicProvider().connect('onprem', onprem);

    expect(createAdtLsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          systemUrl: onprem.systemUrl,
          client: '100',
          extraCaCerts: ['/ca.pem'],
        }),
        destinationId: 'adtplus_onprem',
        keepAlive: true,
      }),
    );
  });

  it('fails the connect with the TLS cause instead of waiting out adt-ls', async () => {
    createAdtLsMock.mockReturnValue(NEVER);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('unable to get local issuer certificate'), {
            code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
          }),
        });
      }),
    );

    const connecting = new AdtLsBasicProvider().connect('onprem', onprem);
    (await logonHandler())(LOGON_PARAMS);

    await expect(connecting).rejects.toThrow(
      /Basic reentrance logon failed: fetch failed \(UNABLE_TO_GET_ISSUER_CERT_LOCALLY/,
    );
    // The hint has to name the knob that fixes it.
    await expect(connecting).rejects.toThrow(/extraCaCerts/);
  });

  it('reports a rejected password without retrying it', async () => {
    createAdtLsMock.mockReturnValue(NEVER);
    const fetchMock = vi.fn(async () => ({ status: 401, headers: new Headers() }));
    vi.stubGlobal('fetch', fetchMock);

    const connecting = new AdtLsBasicProvider().connect('onprem', onprem);
    (await logonHandler())(LOGON_PARAMS);

    await expect(connecting).rejects.toThrow(/user "DEVELOPER" was rejected by client 100 \(HTTP 401\)/);
    await expect(connecting).rejects.toThrow(/account lock counter/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still resolves when the logon succeeds', async () => {
    createAdtLsMock.mockResolvedValue(fakeAdtClient('adtplus_onprem'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 302,
        headers: new Headers({ location: 'http://localhost:8080/?reentrance-ticket=abc' }),
      })),
    );

    const client = await new AdtLsBasicProvider().connect('onprem', onprem);
    (await logonHandler())(LOGON_PARAMS);

    expect(client.health().destination).toBe('adtplus_onprem');
  });
});

describe('AdtLsInteractiveProvider (cloud-erp)', () => {
  it('uses one interactive() strategy with an openUrl callback', async () => {
    createAdtLsMock.mockResolvedValue(fakeAdtClient('adtplus_cloud-erp'));

    await new AdtLsInteractiveProvider().connect('cloud-erp', cloudErp);

    expect(interactiveMock).toHaveBeenCalledTimes(1);
    const cb = interactiveMock.mock.calls[0]![0] as { openUrl: unknown; user?: string };
    expect(typeof cb.openUrl).toBe('function');
  });
});

describe('SessionManager', () => {
  function fakeProvider(kind: 'basic' | 'interactive', delayMs = 0) {
    const connect = vi.fn(async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return fakeAdtClient(`adtplus_${kind}`);
    });
    return { kind, connect } as unknown as SessionProvider & { connect: typeof connect };
  }

  it('shares one in-flight connect across concurrent get() calls', async () => {
    const provider = fakeProvider('basic', 20);
    const manager = new SessionManager({ onprem }, () => provider);

    const [a, b] = await Promise.all([manager.get('onprem'), manager.get('onprem')]);

    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('status() reports null before connecting and session info after', async () => {
    const provider = fakeProvider('interactive');
    const manager = new SessionManager({ 'cloud-erp': cloudErp }, () => provider);

    expect(manager.status('cloud-erp')).toBeNull();
    await manager.get('cloud-erp');
    const info = manager.status('cloud-erp');
    expect(info?.logonKind).toBe('interactive');
  });

  it('disposeIdle evicts sessions past the idle threshold', async () => {
    const provider = fakeProvider('basic');
    const manager = new SessionManager({ onprem }, () => provider);

    const handle = await manager.get('onprem');
    handle.info.lastUsedAt = new Date(Date.now() - 1000).toISOString();

    await manager.disposeIdle(500);

    expect(handle.adt.dispose).toHaveBeenCalledTimes(1);
    expect(manager.status('onprem')).toBeNull();
  });

  it('register keys a destination by its connection, sharing a session across policy-only changes', async () => {
    const provider = fakeProvider('basic');
    const manager = new SessionManager({}, () => provider);

    const key = manager.register(onprem);
    const policyOnly = manager.register({ ...onprem, writeAllowlist: ['ZCUST'], allowRun: true, vfsMount: 'X' });
    const otherClient = manager.register({ ...onprem, client: '200' });
    const otherCa = manager.register({ ...onprem, extraCaCerts: ['/cust-ca.pem'] });
    const otherId = manager.register({ ...cloudErp, id: 'dev' });
    const sameIdOtherCustomer = manager.register({ ...cloudErp, id: 'dev', systemUrl: 'https://other.example' });

    expect(key).toBe('onprem');
    expect(policyOnly).toBe('onprem');
    expect(otherClient).toMatch(/^onprem@[0-9a-f]{8}$/);
    expect(otherCa).toMatch(/^onprem@[0-9a-f]{8}$/);
    expect(otherCa).not.toBe(otherClient);
    expect(otherId).toBe('dev');
    expect(sameIdOtherCustomer).toMatch(/^dev@/);

    await manager.get(otherClient);
    // adt-ls still gets the plain system id: its destination id stays adtplus_onprem.
    expect((provider.connect.mock.calls[0] as unknown[])[0]).toBe('onprem');
    expect(manager.status(otherClient)?.system).toBe('onprem');
    expect(manager.status('onprem')).toBeNull();
  });

  it('register returns the constructor key for a seeded destination', () => {
    const manager = new SessionManager({ onprem });
    expect(manager.register({ ...onprem, allowRun: true })).toBe('onprem');
  });

  it('unknown system throws', async () => {
    const manager = new SessionManager({});
    await expect(manager.get('nope')).rejects.toThrow(/Unknown adt\+ system/);
  });

  it('passes providers a context bound to this system\'s REST session', async () => {
    const provider = fakeProvider('interactive');
    const rest = fakeRest('cookie');
    const restFactory = vi.fn(async () => rest);
    const manager = new SessionManager({ 'cloud-erp': cloudErp }, () => provider, restFactory);

    await manager.get('cloud-erp');
    const ctx = (provider.connect.mock.calls[0] as unknown[])[2] as ConnectContext;

    expect(await ctx.rest()).toBe(rest);
    expect(manager.restStatusAll()['cloud-erp']?.kind).toBe('reentrance');
  });
});

function fakeRest(kind: 'basic' | 'cookie'): RawAdtClient {
  return { authKind: kind } as unknown as RawAdtClient;
}

describe('SessionManager REST sessions', () => {
  it('shares one in-flight REST logon across concurrent getRest() calls', async () => {
    const restFactory = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return fakeRest('cookie');
    });
    const manager = new SessionManager({ 'cloud-erp': cloudErp }, undefined, restFactory);

    const [a, b] = await Promise.all([manager.getRest('cloud-erp'), manager.getRest('cloud-erp')]);

    expect(restFactory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('withRest re-logs on once after a 401 on a reentrance session', async () => {
    const first = fakeRest('cookie');
    const second = fakeRest('cookie');
    const restFactory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new SessionManager({ 'cloud-erp': cloudErp }, undefined, restFactory);
    const fn = vi.fn(async (rest: RawAdtClient) => {
      if (rest === first) throw new RawAdtError(401, undefined, undefined, 'read');
      return 'ok';
    });

    await expect(manager.withRest('cloud-erp', fn)).resolves.toBe('ok');
    expect(restFactory).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('withRest does not re-run a call whose writes already reached SAP before the 401', async () => {
    const restFactory = vi.fn(async () => fakeRest('cookie'));
    const manager = new SessionManager({ 'cloud-erp': cloudErp }, undefined, restFactory);
    const fn = vi.fn(async () => {
      markWrite(); // the create's POST went through
      throw new RawAdtError(401, undefined, undefined, 'read-back');
    });

    await expect(manager.withRest('cloud-erp', fn)).rejects.toThrow(/already written to SAP, so it was not repeated/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(restFactory).toHaveBeenCalledTimes(1);
  });

  it('withRest counts a write of a nested withRest call for the outer one too', async () => {
    const restFactory = vi.fn(async () => fakeRest('cookie'));
    const manager = new SessionManager({ 'cloud-erp': cloudErp }, undefined, restFactory);
    const inner = vi.fn(async () => markWrite());
    const outer = vi.fn(async () => {
      await manager.withRest('cloud-erp', inner);
      throw new RawAdtError(401, undefined, undefined, 'read-back');
    });

    await expect(manager.withRest('cloud-erp', outer)).rejects.toThrow(/not repeated/);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('withRest never retries a 401 on a basic session (password lock counter)', async () => {
    const restFactory = vi.fn(async () => fakeRest('basic'));
    const manager = new SessionManager({ onprem }, undefined, restFactory);
    const fn = vi.fn(async () => {
      throw new RawAdtError(401, undefined, undefined, 'read');
    });

    await expect(manager.withRest('onprem', fn)).rejects.toThrow(/HTTP 401/);
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(manager.relogonRest('onprem')).rejects.toThrow(/never re-logged on/);
  });

  it('withRest does not retry non-auth failures', async () => {
    const restFactory = vi.fn(async () => fakeRest('cookie'));
    const manager = new SessionManager({ 'cloud-erp': cloudErp }, undefined, restFactory);
    const fn = vi.fn(async () => {
      throw new RawAdtError(403, 'ExceptionResourceNoAccess', 'S_ABPLNGVS', 'lock');
    });

    await expect(manager.withRest('cloud-erp', fn)).rejects.toThrow(/S_ABPLNGVS/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('AdtLsInteractiveProvider with a REST context (one SSO window)', () => {
  function installHandler(ctx: ConnectContext): (params: unknown) => boolean {
    createAdtLsMock.mockResolvedValue(fakeAdtClient('adtplus_cloud-erp'));
    void new AdtLsInteractiveProvider().connect('cloud-erp', cloudErp, ctx);
    const registerFn = customMock.mock.calls.at(-1)![0] as (driver: {
      setRequestHandler: (method: string, handler: (params: unknown) => boolean) => void;
    }) => void;
    let handler: ((params: unknown) => boolean) | undefined;
    registerFn({ setRequestHandler: (_m, h) => (handler = h) });
    return handler!;
  }

  const params = { url: 'https://my000000.s4hana.cloud.sap/sap/bc/adt/core/http/reentranceticket?redirect-url=x' };

  it('mints the adt-ls ticket with the REST session and delivers it to adt-ls', async () => {
    const fetchMock = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', fetchMock);
    const mint = vi.fn(async () => 'http://localhost:5000/adt/redirect?reentrance-ticket=T');
    const ctx: ConnectContext = {
      rest: vi.fn(async () => ({ mintReentranceRedirect: mint }) as unknown as RawAdtClient),
      relogonRest: vi.fn(),
    };

    expect(installHandler(ctx)(params)).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(interactiveMock).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledWith(params.url);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('http://127.0.0.1:5000/adt/redirect?reentrance-ticket=T');
    expect(ctx.relogonRest).not.toHaveBeenCalled();
  });

  it('re-logs the REST session on when its cookie can no longer mint', async () => {
    const fetchMock = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', fetchMock);
    const stale = { mintReentranceRedirect: vi.fn(async () => undefined) };
    const fresh = { mintReentranceRedirect: vi.fn(async () => 'http://localhost:5000/r?reentrance-ticket=T2') };
    const ctx: ConnectContext = {
      rest: vi.fn(async () => stale as unknown as RawAdtClient),
      relogonRest: vi.fn(async () => fresh as unknown as RawAdtClient),
    };

    installHandler(ctx)(params);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(ctx.relogonRest).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('reentrance-ticket=T2');
  });
});
