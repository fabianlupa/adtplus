import { describe, expect, it } from 'vitest';
import { ObjectLocks, objectKey } from '../../src/daemon/objectlock.js';

/** A promise plus its resolver, to hold a lock open for as long as a test needs. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('objectKey', () => {
  it('ignores the subtype and the name case', () => {
    expect(objectKey('onprem', { name: 'zcl_x', objectType: 'CLAS/OC' })).toBe(objectKey('onprem', { name: 'ZCL_X', objectType: 'CLAS' }));
    expect(objectKey('onprem', { name: 'zcl_x', objectType: 'clas/oc' })).toBe(objectKey('onprem', { name: 'ZCL_X', objectType: 'CLAS/OC' }));
    expect(objectKey('onprem', { name: 'ZCL_X', objectType: 'CLAS/OC' })).not.toBe(objectKey('cloud-erp', { name: 'ZCL_X', objectType: 'CLAS/OC' }));
  });

  it('gives a function module the key of every function group, since its ref names no group', () => {
    expect(objectKey('cloud-erp', { name: 'Z_ADTPLUS_AP_GET', objectType: 'FUGR/FF' })).toBe(objectKey('cloud-erp', { name: 'ZADTPLUS_AP', objectType: 'FUGR/F' }));
    expect(objectKey('cloud-erp', { name: 'ZADTPLUS_AP', objectType: 'FUGR/F' })).not.toBe(objectKey('onprem', { name: 'ZADTPLUS_AP', objectType: 'FUGR/F' }));
  });
});

describe('ObjectLocks', () => {
  it('lets shared holders of one key run together', async () => {
    const locks = new ObjectLocks();
    const g = gate();
    const log: string[] = [];
    const a = locks.shared(['k'], async () => {
      log.push('a in');
      await g.opened;
    });
    const b = locks.shared(['k'], async () => {
      log.push('b in');
    });
    await b;
    expect(log).toEqual(['a in', 'b in']);
    g.open();
    await a;
  });

  it('holds a shared request back while the object is held exclusively, and runs it after', async () => {
    const locks = new ObjectLocks();
    const g = gate();
    const log: string[] = [];
    const window = locks.exclusive('k', async () => {
      log.push('window open');
      await g.opened;
      log.push('window closed');
    });
    const other = locks.shared(['other', 'k'], async () => {
      log.push('shared ran');
    });
    await tick();
    expect(log).toEqual(['window open']);
    g.open();
    await Promise.all([window, other]);
    expect(log).toEqual(['window open', 'window closed', 'shared ran']);
  });

  it('waits for running shared holders, and blocks newcomers meanwhile', async () => {
    const locks = new ObjectLocks();
    const g = gate();
    const log: string[] = [];
    const reader = locks.shared(['k'], async () => {
      await g.opened;
      log.push('reader done');
    });
    const window = locks.exclusive('k', async () => {
      log.push('window');
    });
    const late = locks.shared(['k'], async () => {
      log.push('late reader');
    });
    await tick();
    expect(log).toEqual([]);
    g.open();
    await Promise.all([reader, window, late]);
    expect(log).toEqual(['reader done', 'window', 'late reader']);
  });

  it('releases the lock when the holder throws', async () => {
    const locks = new ObjectLocks();
    await expect(locks.exclusive('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(locks.shared(['k'], async () => 'ran')).resolves.toBe('ran');
  });
});
