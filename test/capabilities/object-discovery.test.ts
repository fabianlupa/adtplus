import type { AdtLsClient, DirectoryEntry } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import * as object from '../../src/capabilities/object.js';
import type { Destination } from '../../src/core/destinations.js';

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: ['ZADTPLUS_TEST'],
};
const cloud: Destination = { ...onprem, id: 'cloud-erp', kind: 'cloud', auth: 'interactive' };

const SRVB = { name: 'ZADTPLUS_ADTP_M6_SRVB', objectType: 'SRVB/SVB' };
const SRVB_URI = 'abap:/repotree-v1/M6_DEV/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/Business%20Services/Service%20Bindings/ZADTPLUS_ADTP_M6_SRVB/zadtplus_adtp_m6_srvb.srvb.json';

// Shapes as `onprem` and `cloud-erp` sent them.
const services = (isPublished: boolean) => ({
  bindingType: 'ODATA',
  bindingCategory: '0',
  isPublished,
  odataVersion: 'V4',
  services: [{ name: 'ZADTPLUS_ADTP_M6_SRVD', content: [{ serviceDefinition: 'ZADTPLUS_ADTP_M6_SRVD', serviceVersion: '0001' }] }],
});
const details = (over: Record<string, unknown> = {}, objectData: Record<string, unknown> = {}) => ({
  serviceBindingName: 'ZADTPLUS_ADTP_M6_SRVB',
  serviceType: 'ODATA',
  odataversion: 'V4',
  services: ['ZADTPLUS_ADTP_M6_SRVD'],
  ...over,
  objectData: { published: false, allowedAction: 'PUBLISH', version: 0, ...objectData },
});
const PUBLISH_OK = { isExecuted: true, isPublishSuccess: true, statusMessage: 'ZADTPLUS_ADTP_M6_SRVB published locally' };
const REFUSED = { isExecuted: true, isPublishSuccess: false, statusMessage: 'Local un-publish of ZADTPLUS_ADTP_M6_SRVB failed' };

function publishAdt(
  listServices: (...a: unknown[]) => unknown,
  toggle: (...a: unknown[]) => unknown = vi.fn(async () => PUBLISH_OK),
  bindingDetails: (...a: unknown[]) => unknown = async () => details(),
) {
  return {
    lifecycle: { resolveAffUri: vi.fn(async () => SRVB_URI) },
    repository: { readFile: vi.fn(async () => '{}') },
    services: {
      listServices: vi.fn(listServices),
      serviceBindingDetails: vi.fn(bindingDetails),
      publishServiceBinding: vi.fn(toggle),
    },
  } as unknown as AdtLsClient;
}

/** A fake clock so poll and settle waits are exercised without real waiting. */
function fakeClock() {
  let t = 1_000_000;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { sleep, advance: (ms: number) => (t += ms), restore: () => spy.mockRestore() };
}

describe('publishService', () => {
  it('toggles the first service definition and returns once the read-back flips after N polls', async () => {
    const clock = fakeClock();
    try {
      const reads = [services(false), services(false), services(true)];
      const adt = publishAdt(async () => reads.shift() ?? services(true));
      const res = await object.publishService(adt, onprem, {
        ref: SRVB,
        target: 'PUBLISH',
        confirm: true,
        pollIntervalMs: 1000,
        sleep: clock.sleep,
      });

      expect(adt.services.publishServiceBinding).toHaveBeenCalledWith(SRVB, { service: 'ZADTPLUS_ADTP_M6_SRVD' });
      expect(res).toMatchObject({
        wasPublished: false,
        isPublished: true,
        action: 'PUBLISH',
        verifiedVia: 'fetch_services',
        statusMessage: 'ZADTPLUS_ADTP_M6_SRVB published locally',
      });
      expect(clock.sleep).toHaveBeenCalledTimes(2);
      expect(res.waitedMs).toBe(2000);
    } finally {
      clock.restore();
    }
  });

  // cloud-erp, 2026-09-23: a V2 binding toggles the service definition sent as serviceName.
  it('names the first service definition for an OData V2 binding', async () => {
    const adt = publishAdt(
      async () => services(true),
      undefined,
      async () => details({ odataversion: 'V2', services: ['ZADTPLUS_V2_SRVD', 'ZADTPLUS_V2_OTHER'] }),
    );
    await object.publishService(adt, onprem, { ref: SRVB, target: 'PUBLISH', confirm: true });
    expect(adt.services.publishServiceBinding).toHaveBeenCalledWith(SRVB, { service: 'ZADTPLUS_V2_SRVD' });
  });

  // cloud-erp, 2026-09-23: a V2 binding reads
  // allowedAction=PUBLISH while published, and fetch_services has no isPublished.
  it('on V2, takes the direction from `published` and reads back from the details', async () => {
    const clock = fakeClock();
    try {
      let published = true;
      const v2 = async () =>
        details({ odataversion: 'V2', services: ['ZADTPLUS_BALANCE'] }, { published, allowedAction: 'PUBLISH' });
      const adt = publishAdt(
        async () => ({ ...services(false), isPublished: undefined, odataVersion: 'V2' }),
        vi.fn(async () => {
          published = false;
          return { ...PUBLISH_OK, statusMessage: 'service ZADTPLUS_BALANCE with version 0001 un-published locally' };
        }),
        v2,
      );
      const res = await object.publishService(adt, cloud, {
        ref: SRVB,
        target: 'UNPUBLISH',
        confirm: true,
        pollIntervalMs: 1000,
        sleep: clock.sleep,
      });
      expect(res).toMatchObject({
        wasPublished: true,
        isPublished: false,
        action: 'UNPUBLISH',
        verifiedVia: 'serviceBindingDetails',
      });
    } finally {
      clock.restore();
    }
  });

  it('takes its direction from allowedAction, so an un-publish waits for isPublished=false', async () => {
    const clock = fakeClock();
    try {
      const reads = [services(true), services(false)];
      const adt = publishAdt(
        async () => reads.shift() ?? services(false),
        vi.fn(async () => ({ ...PUBLISH_OK, statusMessage: 'ZADTPLUS_ADTP_M6_SRVB un-published locally' })),
        async () => details({}, { published: true, allowedAction: 'UNPUBLISH' }),
      );
      const res = await object.publishService(adt, onprem, {
        ref: SRVB,
        target: 'UNPUBLISH',
        confirm: true,
        pollIntervalMs: 1000,
        sleep: clock.sleep,
      });
      expect(res).toMatchObject({ wasPublished: true, isPublished: false, action: 'UNPUBLISH' });
    } finally {
      clock.restore();
    }
  });

  it('errors after the timeout when the state never flips, naming the last state', async () => {
    const clock = fakeClock();
    try {
      const adt = publishAdt(async () => services(false));
      await expect(
        object.publishService(adt, onprem, {
          ref: SRVB,
          target: 'PUBLISH',
          confirm: true,
          pollTimeoutMs: 5000,
          pollIntervalMs: 1000,
          sleep: clock.sleep,
        }),
      ).rejects.toThrow(/still reads isPublished=false 5 s after adt-ls reported PUBLISH success.*not confirmed/);
      expect(clock.sleep).toHaveBeenCalledTimes(5);
    } finally {
      clock.restore();
    }
  });

  it('tolerates a read error mid-poll and reports it if the state never confirms', async () => {
    const clock = fakeClock();
    try {
      const adt = publishAdt(async () => {
        throw new Error('fetch_services 503');
      });
      await expect(
        object.publishService(adt, onprem, {
          ref: SRVB,
          target: 'PUBLISH',
          confirm: true,
          pollTimeoutMs: 3000,
          pollIntervalMs: 1000,
          sleep: clock.sleep,
        }),
      ).rejects.toThrow(/Last read error: fetch_services 503/);
    } finally {
      clock.restore();
    }
  });

  it('a read error mid-poll does not stop a later successful flip', async () => {
    const clock = fakeClock();
    try {
      let n = 0;
      const adt = publishAdt(async () => {
        n += 1;
        if (n === 1) throw new Error('transient');
        return services(true);
      });
      const res = await object.publishService(adt, onprem, {
        ref: SRVB,
        target: 'PUBLISH',
        confirm: true,
        pollIntervalMs: 1000,
        sleep: clock.sleep,
      });
      expect(res.isPublished).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('refuses an inactive binding before touching the toggle', async () => {
    const adt = publishAdt(
      async () => services(false),
      vi.fn(async () => PUBLISH_OK),
      async () => details({}, { version: 1 }),
    );
    await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'PUBLISH', confirm: true })).rejects.toThrow(
      /is inactive; activate the service binding/,
    );
    expect(adt.services.publishServiceBinding).not.toHaveBeenCalled();
  });

  it('refuses a binding that exposes no services', async () => {
    const adt = publishAdt(
      async () => services(false),
      vi.fn(async () => PUBLISH_OK),
      async () => details({ services: [] }),
    );
    await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'PUBLISH', confirm: true })).rejects.toThrow(
      /exposes no services/,
    );
    expect(adt.services.publishServiceBinding).not.toHaveBeenCalled();
  });

  it('refuses when the OData version is missing (adt-ls NPEs on a null)', async () => {
    const adt = publishAdt(
      async () => services(false),
      vi.fn(async () => PUBLISH_OK),
      async () => details({ odataversion: undefined }),
    );
    await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'PUBLISH', confirm: true })).rejects.toThrow(
      /OData version/,
    );
    expect(adt.services.publishServiceBinding).not.toHaveBeenCalled();
  });

  // S/4HANA 2023 sends no `allowedAction` at all.
  it('falls back to `published` on a release that sends no allowedAction', async () => {
    const clock = fakeClock();
    try {
      const adt = publishAdt(
        async () => services(false),
        vi.fn(async () => ({ ...PUBLISH_OK, statusMessage: 'un-published locally' })),
        async () => details({}, { published: true, allowedAction: undefined }),
      );
      const res = await object.publishService(adt, onprem, {
        ref: SRVB,
        target: 'UNPUBLISH',
        confirm: true,
        pollIntervalMs: 1000,
        sleep: clock.sleep,
      });
      expect(res).toMatchObject({ wasPublished: true, isPublished: false, action: 'UNPUBLISH' });
    } finally {
      clock.restore();
    }
  });

  it('refuses when neither a published state nor an allowedAction is readable', async () => {
    const adt = publishAdt(
      async () => services(false),
      vi.fn(async () => PUBLISH_OK),
      async () => details({}, { published: undefined, allowedAction: undefined }),
    );
    await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'PUBLISH', confirm: true })).rejects.toThrow(
      /neither a published state nor an allowedAction; refusing to toggle blind/,
    );
    expect(adt.services.publishServiceBinding).not.toHaveBeenCalled();
  });

  it('refuses an allowedAction that is not a toggle direction', async () => {
    const adt = publishAdt(
      async () => services(false),
      vi.fn(async () => PUBLISH_OK),
      async () => details({}, { published: false, allowedAction: 'NONE' }),
    );
    await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'PUBLISH', confirm: true })).rejects.toThrow(
      /allowedAction=NONE, which is not a toggle direction/,
    );
    expect(adt.services.publishServiceBinding).not.toHaveBeenCalled();
  });

  it('refuses, with nothing sent, a binding already in the state asked for (ADR-018)', async () => {
    const published = publishAdt(async () => services(true), undefined, async () => details({}, { published: true, allowedAction: 'UNPUBLISH' }));
    await expect(object.publishService(published, onprem, { ref: SRVB, target: 'PUBLISH', confirm: true })).rejects.toThrow(
      'ZADTPLUS_ADTP_M6_SRVB is already published; nothing sent',
    );
    expect(published.services.publishServiceBinding).not.toHaveBeenCalled();
    // S/4HANA 2023 sends no allowedAction: the direction comes from `published`.
    const unpublished = publishAdt(async () => services(false), undefined, async () => details({}, { published: false, allowedAction: undefined }));
    await expect(object.publishService(unpublished, onprem, { ref: SRVB, target: 'UNPUBLISH', confirm: true })).rejects.toThrow(
      'ZADTPLUS_ADTP_M6_SRVB is already unpublished; nothing sent',
    );
    expect(unpublished.services.publishServiceBinding).not.toHaveBeenCalled();
    // V2 reads allowedAction=PUBLISH while published: `published` decides there too.
    const v2 = publishAdt(async () => services(true), undefined, async () => details({ odataversion: 'V2' }, { published: true, allowedAction: 'PUBLISH' }));
    await expect(object.publishService(v2, cloud, { ref: SRVB, target: 'PUBLISH', confirm: true })).rejects.toThrow(/already published/);
    expect(v2.services.publishServiceBinding).not.toHaveBeenCalled();
  });

  it('refuses without confirm before touching SAP', async () => {
    const adt = publishAdt(async () => services(false));
    await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'PUBLISH' })).rejects.toThrow(/requires confirm: true/);
    expect(adt.services.listServices).not.toHaveBeenCalled();
    expect(adt.services.serviceBindingDetails).not.toHaveBeenCalled();
    expect(adt.services.publishServiceBinding).not.toHaveBeenCalled();
  });

  // The gate stopped depending on `kind` once M6.4a proved the cloud toggle both
  // ways: only an explicit `allowPublish: false` refuses now.
  it('gates by policy only: refused when allowPublish is false, on either kind', async () => {
    for (const destination of [onprem, cloud]) {
      const adt = publishAdt(async () => services(false));
      await expect(
        object.publishService(adt, { ...destination, allowPublish: false }, { ref: SRVB, target: 'PUBLISH', confirm: true }),
      ).rejects.toThrow(/publish and unpublish are disabled here by "allowPublish": false/);
      expect(adt.services.publishServiceBinding).not.toHaveBeenCalled();
    }
  });

  it('runs on a cloud system with no publish policy set', async () => {
    const clock = fakeClock();
    try {
      const reads = [services(false), services(true)];
      const adt = publishAdt(async () => reads.shift() ?? services(true));
      const res = await object.publishService(adt, cloud, {
        ref: SRVB,
        target: 'PUBLISH',
        confirm: true,
        pollIntervalMs: 1000,
        sleep: clock.sleep,
      });
      expect(res).toMatchObject({ isPublished: true, action: 'PUBLISH' });
      expect(adt.services.publishServiceBinding).toHaveBeenCalledTimes(1);
    } finally {
      clock.restore();
    }
  });

  it('fails when adt-ls reports the action did not execute, without polling', async () => {
    const adt = publishAdt(
      async () => services(true),
      vi.fn(async () => REFUSED),
      async () => details({}, { published: true, allowedAction: 'UNPUBLISH' }),
    );
    await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'UNPUBLISH', confirm: true })).rejects.toThrow(
      /Un-publish of ZADTPLUS_ADTP_M6_SRVB failed: Local un-publish of ZADTPLUS_ADTP_M6_SRVB failed/,
    );
    expect(adt.services.listServices).not.toHaveBeenCalled();
  });

  // The cloud-erp settling window: an un-publish is refused in ~0.1 s for the first
  // minutes after a publish, then the identical call runs the real job.
  describe('settle budget for an instantly refused toggle', () => {
    const unpublishDetails = async () => details({}, { published: true, allowedAction: 'UNPUBLISH' });

    it('re-sends a fast refusal while the budget lasts, then succeeds', async () => {
      const clock = fakeClock();
      try {
        let calls = 0;
        let published = true;
        const adt = publishAdt(
          async () => services(published),
          vi.fn(async () => {
            calls += 1;
            if (calls < 3) return REFUSED;
            published = false;
            return { ...PUBLISH_OK, statusMessage: 'un-published locally' };
          }),
          unpublishDetails,
        );
        const res = await object.publishService(adt, onprem, {
          ref: SRVB,
          target: 'UNPUBLISH',
          confirm: true,
          settleTimeoutMs: 180_000,
          settleIntervalMs: 60_000,
          pollIntervalMs: 1000,
          sleep: clock.sleep,
        });
        expect(calls).toBe(3);
        const sent = vi.mocked(adt.services.publishServiceBinding).mock.calls.map((c) => c[1]);
        expect(sent[1]).toEqual(sent[0]);
        expect(sent[2]).toEqual(sent[0]);
        expect(res).toMatchObject({ isPublished: false, action: 'UNPUBLISH' });
      } finally {
        clock.restore();
      }
    });

    it('stops re-sending if someone else flips the state while it waits', async () => {
      const clock = fakeClock();
      try {
        // The toggle carries no direction, so a blind re-send after someone
        // else's un-publish would publish the binding again.
        let published = true;
        const toggle = vi.fn(async () => {
          published = false; // whoever we raced with won during the first wait
          return REFUSED;
        });
        const adt = publishAdt(async () => services(published), toggle, unpublishDetails);
        const res = await object.publishService(adt, onprem, {
          ref: SRVB,
          target: 'UNPUBLISH',
          confirm: true,
          settleTimeoutMs: 180_000,
          settleIntervalMs: 60_000,
          pollIntervalMs: 1000,
          sleep: clock.sleep,
        });
        expect(toggle).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ isPublished: false, action: 'UNPUBLISH' });
        expect(res.statusMessage).toMatch(/another session ran the UNPUBLISH/);
      } finally {
        clock.restore();
      }
    });

    it('stops re-sending when the budget cannot fit another wait, and says how often it tried', async () => {
      const clock = fakeClock();
      try {
        const adt = publishAdt(async () => services(true), vi.fn(async () => REFUSED), unpublishDetails);
        await expect(
          object.publishService(adt, onprem, {
            ref: SRVB,
            target: 'UNPUBLISH',
            confirm: true,
            settleTimeoutMs: 120_000,
            settleIntervalMs: 60_000,
            sleep: clock.sleep,
          }),
        ).rejects.toThrow(/Un-publish of ZADTPLUS_ADTP_M6_SRVB failed after 3 attempts over 120 s/);
      } finally {
        clock.restore();
      }
    });

    it('sends once and explains the cloud refusal when no budget is given', async () => {
      const adt = publishAdt(async () => services(true), vi.fn(async () => REFUSED), unpublishDetails);
      await expect(
        object.publishService(adt, { ...cloud, allowPublish: true }, { ref: SRVB, target: 'UNPUBLISH', confirm: true }),
      ).rejects.toThrow(/refused it instantly.*Nothing was executed.*--settle-timeout/s);
      expect(adt.services.publishServiceBinding).toHaveBeenCalledTimes(1);
    });

    it('does not add the cloud explanation on an on-prem system', async () => {
      const adt = publishAdt(async () => services(true), vi.fn(async () => REFUSED), unpublishDetails);
      await expect(object.publishService(adt, onprem, { ref: SRVB, target: 'UNPUBLISH', confirm: true })).rejects.toThrow(
        /failed: Local un-publish of ZADTPLUS_ADTP_M6_SRVB failed\.$/,
      );
    });

    it('never re-sends a slow failure, because that call may have run the job', async () => {
      const clock = fakeClock();
      try {
        const adt = publishAdt(
          async () => services(true),
          vi.fn(async () => {
            clock.advance(130_000); // the real job runs for ~132 s
            return REFUSED;
          }),
          unpublishDetails,
        );
        await expect(
          object.publishService(adt, onprem, {
            ref: SRVB,
            target: 'UNPUBLISH',
            confirm: true,
            settleTimeoutMs: 600_000,
            settleIntervalMs: 60_000,
            sleep: clock.sleep,
          }),
        ).rejects.toThrow(/Un-publish of ZADTPLUS_ADTP_M6_SRVB failed:/);
        expect(adt.services.publishServiceBinding).toHaveBeenCalledTimes(1);
        expect(clock.sleep).not.toHaveBeenCalled();
      } finally {
        clock.restore();
      }
    });
  });
});

// --- search -----------------------------------------------------------

// Shape as `onprem` sent it.
const ref = (n: number) => ({
  name: `ZCL_HIT_${n}`,
  type: 'Class',
  description: `hit ${n}`,
  uri: `/sap/bc/adt/oo/classes/zcl_hit_${n}`,
});

function searchAdt(refs: unknown[], getLsUri?: (u: string) => Promise<string>) {
  return {
    repository: {
      search: vi.fn(async () => ({ references: refs })),
      getLsUri: vi.fn(getLsUri ?? (async (u: string) => `abap:/repotree-v1${u}.clas.abap`)),
    },
  } as unknown as AdtLsClient;
}

describe('search', () => {
  it('pairs each hit with its own openable URI', async () => {
    const adt = searchAdt([ref(1), ref(2), ref(3)]);
    const res = await object.search(adt, { query: 'ZCL_HIT*' });
    expect(res.hits.map((h) => [h.name, h.uri])).toEqual([
      ['ZCL_HIT_1', 'abap:/repotree-v1/sap/bc/adt/oo/classes/zcl_hit_1.clas.abap'],
      ['ZCL_HIT_2', 'abap:/repotree-v1/sap/bc/adt/oo/classes/zcl_hit_2.clas.abap'],
      ['ZCL_HIT_3', 'abap:/repotree-v1/sap/bc/adt/oo/classes/zcl_hit_3.clas.abap'],
    ]);
    expect(res.hits[1]).toMatchObject({ type: 'Class', description: 'hit 2' });
  });

  it('a getLsUri failure leaves that hit without a uri and does not fail the search', async () => {
    const adt = searchAdt([ref(1), ref(2), ref(3)], async (u) => {
      if (u.endsWith('_2')) throw new Error('getLsUri boom');
      return `abap:${u}`;
    });
    const res = await object.search(adt, { query: 'ZCL_HIT*' });
    expect(res.hits.map((h) => h.uri)).toEqual([
      'abap:/sap/bc/adt/oo/classes/zcl_hit_1',
      undefined,
      'abap:/sap/bc/adt/oo/classes/zcl_hit_3',
    ]);
  });

  it('defaults to 25 and reports truncated only when more than the limit matched', async () => {
    const many = Array.from({ length: 26 }, (_, i) => ref(i));
    const adt = searchAdt(many);
    const res = await object.search(adt, { query: 'ZCL*' });
    expect(res.limit).toBe(25);
    expect(res.hits).toHaveLength(25);
    expect(res.truncated).toBe(true);
    expect(adt.repository.search).toHaveBeenCalledWith('ZCL*', expect.objectContaining({ maxResults: 26, cold: true }));

    const exact = await object.search(searchAdt(many.slice(0, 25)), { query: 'ZCL*' });
    expect(exact.hits).toHaveLength(25);
    expect(exact.truncated).toBe(false);
  });

  it('clamps maxResults to 100 and at least 1', async () => {
    const adt = searchAdt([ref(1)]);
    expect((await object.search(adt, { query: 'Z*', maxResults: 5000 })).limit).toBe(100);
    expect(adt.repository.search).toHaveBeenLastCalledWith('Z*', expect.objectContaining({ maxResults: 101 }));
    expect((await object.search(adt, { query: 'Z*', maxResults: 0 })).limit).toBe(1);
  });

  it('passes objectType as the types filter, and omits it when absent', async () => {
    const adt = searchAdt([]);
    await object.search(adt, { query: 'Z*', objectType: 'CLAS/OC' });
    expect(adt.repository.search).toHaveBeenLastCalledWith('Z*', expect.objectContaining({ types: ['CLAS/OC'] }));
    await object.search(adt, { query: 'Z*' });
    expect(vi.mocked(adt.repository.search).mock.calls[1]?.[1]).not.toHaveProperty('types');
  });

  it('searches a subtype adt-ls\'s filter misses by its main type, in one call', async () => {
    const adt = searchAdt([]);
    await object.search(adt, { query: 'Z*', objectType: 'DTEB/DF' });
    expect(adt.repository.search).toHaveBeenCalledTimes(1);
    expect(adt.repository.search).toHaveBeenLastCalledWith('Z*', expect.objectContaining({ types: ['DTEB'] }));
  });
});

// --- list -------------------------------------------------------------

// Shapes recorded in m6-01-pkg-search / pkg-getlsuri / readdir-dir-slash.
const PKG_FILE_URI = 'abap:/repotree-v1/M6_DEV/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/zadtplus_test.devck.jsonc';
const PKG_DIR = 'abap:/repotree-v1/M6_DEV/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/';

function listAdt(children: unknown[] = [], references: unknown[] | undefined = undefined) {
  return {
    repository: {
      search: vi.fn(async () => ({
        references: references ?? [{ name: 'ZADTPLUS_TEST', type: 'ABAP Package', uri: '/sap/bc/adt/packages/zadtplus_test' }],
      })),
      getLsUri: vi.fn(async () => PKG_FILE_URI),
      readDirectory: vi.fn(async () => children),
    },
  } as unknown as AdtLsClient;
}

describe('list', () => {
  it('reads the package directory: the file URI minus its last segment', async () => {
    const adt = listAdt();
    const res = await object.list(adt, { packageName: 'zadtplus_test' });
    expect(res.uri).toBe(PKG_DIR);
    expect(adt.repository.readDirectory).toHaveBeenCalledWith(PKG_DIR);
    expect(adt.repository.search).toHaveBeenCalledWith(
      'zadtplus_test',
      expect.objectContaining({ types: ['DEVC/K'] }),
    );
  });

  it('encodes each path segment and appends a trailing slash', async () => {
    const adt = listAdt();
    const res = await object.list(adt, { packageName: 'ZADTPLUS_TEST', path: ['Source Code Library', 'Classes'] });
    expect(res.uri).toBe(`${PKG_DIR}Source%20Code%20Library/Classes/`);
  });

  it('errors when the package is not found, including a near-miss search hit', async () => {
    const none = listAdt([], []);
    await expect(object.list(none, { packageName: 'ZNOPE' })).rejects.toThrow('Package "ZNOPE" was not found');
    expect(none.repository.readDirectory).not.toHaveBeenCalled();

    const nearMiss = listAdt([], [{ name: 'ZADTPLUS_TEST_B1', uri: '/sap/bc/adt/packages/zadtplus_test_b1' }]);
    await expect(object.list(nearMiss, { packageName: 'ZADTPLUS_TEST' })).rejects.toThrow(/was not found/);
  });

});

// --- list --depth -----------------------------------------------------
//
// The shape M6.4c measured: objects sit under localized category folders, so
// depth 1 answers "what's in this package" with folder names only. Keys below
// are the URI suffix under PKG_DIR, encoded as `list` builds it.

const FILE = 'file' as const;
const DIR = 'directory' as const;

const PACKAGE_TREE: Record<string, DirectoryEntry[]> = {
  '': [
    { name: 'zadtplus_test.devck.jsonc', kind: FILE },
    { name: 'Source Code Library', kind: DIR },
  ],
  'Source%20Code%20Library/': [
    { name: 'Classes', kind: DIR },
    { name: 'Interfaces', kind: DIR },
  ],
  'Source%20Code%20Library/Classes/': [{ name: 'zcl_adtplus_ai_demo2.clas.abap', kind: FILE }],
  'Source%20Code%20Library/Interfaces/': [{ name: 'zif_adtplus_x.intf.abap', kind: FILE }],
};

function treeAdt(tree: Record<string, DirectoryEntry[] | Error> = PACKAGE_TREE) {
  return {
    repository: {
      search: vi.fn(async () => ({
        references: [{ name: 'ZADTPLUS_TEST', type: 'ABAP Package', uri: '/sap/bc/adt/packages/zadtplus_test' }],
      })),
      getLsUri: vi.fn(async () => PKG_FILE_URI),
      readDirectory: vi.fn(async (uri: string) => {
        const node = tree[uri.slice(PKG_DIR.length)];
        if (node instanceof Error) throw node;
        return node ?? [];
      }),
    },
  } as unknown as AdtLsClient;
}

describe('list --depth', () => {
  it('defaults to one level, and says directories were left unread', async () => {
    const adt = treeAdt();
    const res = await object.list(adt, { packageName: 'ZADTPLUS_TEST' });
    expect(res.entries).toEqual([
      { name: 'zadtplus_test.devck.jsonc', kind: 'file' },
      { name: 'Source Code Library', kind: 'directory' },
    ]);
    expect(res.requests).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it('walks the whole package in one call, tagging each entry with its folder path', async () => {
    const adt = treeAdt();
    const res = await object.list(adt, { packageName: 'ZADTPLUS_TEST', depth: 3 });
    expect(res.entries).toEqual([
      { name: 'zadtplus_test.devck.jsonc', kind: 'file' },
      { name: 'Source Code Library', kind: 'directory' },
      { name: 'Classes', kind: 'directory', path: ['Source Code Library'] },
      { name: 'Interfaces', kind: 'directory', path: ['Source Code Library'] },
      { name: 'zcl_adtplus_ai_demo2.clas.abap', kind: 'file', path: ['Source Code Library', 'Classes'] },
      { name: 'zif_adtplus_x.intf.abap', kind: 'file', path: ['Source Code Library', 'Interfaces'] },
    ]);
    // Four reads — the twelve Copilot needed in M6.4c, in one call.
    expect(res.requests).toBe(4);
    expect(res.truncated).toBe(false);
    expect(res.unreadable).toBeUndefined();
  });

  it('stops cleanly when the tree runs out before the depth budget', async () => {
    const res = await object.list(treeAdt(), { packageName: 'ZADTPLUS_TEST', depth: 10 });
    expect(res.requests).toBe(4);
    expect(res.truncated).toBe(false);
  });

  it('descends from a path, and encodes each level it walks', async () => {
    const adt = treeAdt();
    const res = await object.list(adt, {
      packageName: 'ZADTPLUS_TEST',
      path: ['Source Code Library'],
      depth: 2,
    });
    expect(res.uri).toBe(`${PKG_DIR}Source%20Code%20Library/`);
    expect(res.entries).toEqual([
      { name: 'Classes', kind: 'directory' },
      { name: 'Interfaces', kind: 'directory' },
      { name: 'zcl_adtplus_ai_demo2.clas.abap', kind: 'file', path: ['Classes'] },
      { name: 'zif_adtplus_x.intf.abap', kind: 'file', path: ['Interfaces'] },
    ]);
    expect(vi.mocked(adt.repository.readDirectory).mock.calls.map((c) => c[0])).toEqual([
      `${PKG_DIR}Source%20Code%20Library/`,
      `${PKG_DIR}Source%20Code%20Library/Classes/`,
      `${PKG_DIR}Source%20Code%20Library/Interfaces/`,
    ]);
  });

  it('caps the walk at maxRequests and reports it as truncated', async () => {
    const adt = treeAdt();
    const res = await object.list(adt, { packageName: 'ZADTPLUS_TEST', depth: 10, maxRequests: 3 });
    expect(res.requests).toBe(3);
    expect(res.truncated).toBe(true);
    // The level it could not finish is simply absent, not half-reported.
    expect(res.entries.filter((e) => e.path?.includes('Interfaces'))).toEqual([]);
  });

  it('clamps depth and maxRequests into range', async () => {
    const deep = treeAdt();
    await object.list(deep, { packageName: 'ZADTPLUS_TEST', depth: 999 });
    expect(vi.mocked(deep.repository.readDirectory).mock.calls).toHaveLength(4);

    const shallow = treeAdt();
    const res = await object.list(shallow, { packageName: 'ZADTPLUS_TEST', depth: 0, maxRequests: 0 });
    expect(res.requests).toBe(1);
  });

  it('reports an unreadable sub-directory instead of losing the rest of the tree', async () => {
    const adt = treeAdt({
      ...PACKAGE_TREE,
      'Source%20Code%20Library/Classes/': new Error('Resource does not exist'),
    });
    const res = await object.list(adt, { packageName: 'ZADTPLUS_TEST', depth: 3 });
    expect(res.unreadable).toEqual([
      { path: ['Source Code Library', 'Classes'], message: 'Resource does not exist' },
    ]);
    expect(res.entries).toContainEqual({
      name: 'zif_adtplus_x.intf.abap',
      kind: 'file',
      path: ['Source Code Library', 'Interfaces'],
    });
  });

  it('still throws when the requested directory itself cannot be read', async () => {
    const adt = treeAdt({ '': new Error('boom') });
    await expect(object.list(adt, { packageName: 'ZADTPLUS_TEST', depth: 3 })).rejects.toThrow('boom');
  });
});

describe('toVfsUri', () => {
  const uri = 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZALL/zcl_x.clas.abap';

  it('re-roots an adt-ls URI onto the mount VS Code uses', () => {
    expect(object.toVfsUri(uri, 'adtplus_onprem', 'DEV_100_DEVELOPER_EN')).toBe(
      'abap:/repotree-v1/DEV_100_DEVELOPER_EN/System%20Library/ZALL/zcl_x.clas.abap',
    );
  });

  it('leaves the URI alone without a configured mount, or with no URI', () => {
    expect(object.toVfsUri(uri, 'adtplus_onprem', undefined)).toBe(uri);
    expect(object.toVfsUri(undefined, 'adtplus_onprem', 'X')).toBeUndefined();
  });
});
