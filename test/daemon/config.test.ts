import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTrustStore } from '../../src/core/project-config.js';
import type { DialogAnswer, LayerSummary } from '../../src/core/trust-dialog.js';
import { createConfigResolver } from '../../src/daemon/config.js';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-resolver-')));
  mkdirSync(path.join(home, '.config', 'adtplus'), { recursive: true });
  writeFileSync(
    path.join(home, '.config', 'adtplus', 'systems.json'),
    JSON.stringify({ onprem: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example', writeAllowlist: ['ZDEV'] } }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function project(folder: string, content: unknown): string {
  const dir = path.join(home, folder, '.adtplus');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'systems.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

function resolver(ask: (s: LayerSummary[]) => Promise<DialogAnswer>, onLoaded = vi.fn(async () => undefined)) {
  return createConfigResolver({
    home,
    systemsConfigPath: path.join(home, '.config', 'adtplus', 'systems.json'),
    adtlsDestinationsPath: path.join(home, 'missing.json'),
    trustStorePath: path.join(home, '.config', 'adtplus', 'trusted.json'),
    ask,
    onLoaded,
  });
}

const CUST = { onprem: { writeAllowlist: ['ZCUST'] } };

describe('config resolver (daemon, ADR-006)', () => {
  it('reads only project config paths below home', async () => {
    const r = resolver(vi.fn());
    await expect(r.resolve([path.join(home, 'x.json')])).rejects.toThrow(/Not an adt\+ project config path/);
    await expect(r.resolve(['relative/.adtplus/systems.json'])).rejects.toThrow(/Not an adt\+ project config path/);
    await expect(r.resolve([path.join(tmpdir(), 'elsewhere', '.adtplus', 'systems.json')])).rejects.toThrow(/outside the home folder/);
  });

  it('never asks without a system, and refuses what an unapproved file sets', async () => {
    const ask = vi.fn();
    const file = project('cust', CUST);

    const config = await resolver(ask).resolve([file]);

    expect(ask).not.toHaveBeenCalled();
    expect(config.destinations.onprem).toBeUndefined();
    expect(config.refused.onprem).toMatch(/is not approved/);
  });

  it('asks once for concurrent requests, records the approval, and resolves the merged system', async () => {
    let answer!: (a: DialogAnswer) => void;
    const ask = vi.fn(() => new Promise<DialogAnswer>((resolve) => (answer = resolve)));
    const file = project('cust', CUST);
    const r = resolver(ask);

    const a = r.resolve([file], 'onprem');
    const b = r.resolve([file], 'onprem');
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer('allow');
    const [ca, cb] = await Promise.all([a, b]);

    expect(ask).toHaveBeenCalledTimes(1);
    const summaries = (ask.mock.calls[0] as unknown as [LayerSummary[]])[0];
    expect(summaries[0]?.path).toBe('~/cust/.adtplus/systems.json');
    expect(ca.destinations.onprem?.writeAllowlist).toEqual(['ZCUST']);
    expect(cb.destinations.onprem?.writeAllowlist).toEqual(['ZCUST']);
    const store = await readTrustStore(path.join(home, '.config', 'adtplus', 'trusted.json'));
    expect(Object.keys(store)).toEqual([file]);
  });

  it('remembers a denial until the file changes', async () => {
    const ask = vi.fn(async (): Promise<DialogAnswer> => 'deny');
    const file = project('cust', CUST);
    const r = resolver(ask);

    const first = await r.resolve([file], 'onprem');
    const second = await r.resolve([file], 'onprem');

    expect(ask).toHaveBeenCalledTimes(1);
    expect(first.refused.onprem).toMatch(/was denied in the approval dialog/);
    expect(second.refused.onprem).toMatch(/was denied/);

    writeFileSync(file, JSON.stringify({ onprem: { writeAllowlist: ['ZOTHER'] } }));
    await r.resolve([file], 'onprem');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('points at the terminal when no dialog can be shown', async () => {
    const file = project('cust', CUST);
    const config = await resolver(async () => 'unavailable').resolve([file], 'onprem');
    expect(config.refused.onprem).toMatch(/can't show the approval dialog here; run `adtplus config trust`/);
  });

  it('does not ask for a system the unapproved file does not touch', async () => {
    const ask = vi.fn();
    const file = project('cust', { cust: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://c' } });

    const config = await resolver(ask).resolve([file], 'onprem');

    expect(ask).not.toHaveBeenCalled();
    expect(config.destinations.onprem?.writeAllowlist).toEqual(['ZDEV']);
  });

  it('reads the files again only when one changes', async () => {
    const onLoaded = vi.fn(async () => undefined);
    const r = resolver(vi.fn(), onLoaded);
    const file = project('cust', CUST);

    await r.resolve([file]);
    await r.resolve([file]);
    expect(onLoaded).toHaveBeenCalledTimes(1);

    writeFileSync(file, JSON.stringify({ onprem: { writeAllowlist: ['ZCUST', 'ZMORE'] } }));
    await r.resolve([file]);
    expect(onLoaded).toHaveBeenCalledTimes(2);
  });
});
