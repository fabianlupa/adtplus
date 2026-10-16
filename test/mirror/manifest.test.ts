import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyManifest,
  loadManifest,
  parseManifest,
  saveManifest,
  serializeManifest,
  type Manifest,
} from '../../src/mirror/manifest.js';

const HASH = 'a'.repeat(64);

function sample(): Manifest {
  return {
    version: 1,
    system: 'onprem',
    packages: [{ name: 'ZADTPLUS_X', subpackages: true }],
    adtLs: '1.1.2',
    objects: {
      'CLAS ZCL_X': {
        package: 'ZADTPLUS_X',
        dir: 'src/zadtplus_x',
        files: {
          'zcl_x.clas.abap': { hash: HASH, draft: true },
          'zcl_x.clas.texts.en.properties': { hash: HASH, readOnly: true },
        },
      },
    },
  };
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-manifest-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('manifest', () => {
  it('round-trips through disk with sorted keys and a final newline', async () => {
    expect(await loadManifest(root)).toBeUndefined();
    await saveManifest(root, sample());
    const text = readFileSync(path.join(root, '.adtplus', 'mirror.json'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(['adtLs', 'objects', 'packages', 'system', 'version']);
    expect(text.indexOf('"draft"')).toBeLessThan(text.indexOf('"hash"'));
    expect(await loadManifest(root)).toEqual(sample());
    expect(readdirSync(path.join(root, '.adtplus'))).toEqual(['mirror.json']);
  });

  it('serializes equal manifests identically whatever the insertion order', () => {
    const a = sample();
    const b: Manifest = { objects: a.objects, version: 1, packages: a.packages, system: 'onprem', adtLs: '1.1.2' };
    expect(serializeManifest(b)).toBe(serializeManifest(a));
  });

  it('starts empty', () => {
    expect(emptyManifest('cloud-erp')).toEqual({ version: 1, system: 'cloud-erp', packages: [], objects: {} });
  });

  it('refuses .. and absolute paths, and folders outside src/', () => {
    const bad = (dir: string, file = 'f.abap') => {
      const m = sample() as unknown as { objects: Record<string, { dir: string; files: Record<string, unknown> }> };
      m.objects['CLAS ZCL_X']!.dir = dir;
      m.objects['CLAS ZCL_X']!.files = { [file]: { hash: HASH } };
      return JSON.stringify(m);
    };
    expect(() => parseManifest(bad('src/../..'), 'm')).toThrow(/invalid mirror manifest/);
    expect(() => parseManifest(bad('/etc'), 'm')).toThrow(/invalid/);
    expect(() => parseManifest(bad('other/x'), 'm')).toThrow(/invalid/);
    expect(() => parseManifest(bad('src/x', '../evil'), 'm')).toThrow(/invalid/);
    expect(() => parseManifest(bad('src/x', '..'), 'm')).toThrow(/invalid/);
    expect(() => parseManifest(bad('src/x', 'ok.abap'), 'm')).not.toThrow();
  });

  it('refuses unknown fields and other versions', () => {
    expect(() => parseManifest(JSON.stringify({ ...sample(), version: 2 }), 'm')).toThrow(/version/);
    expect(() => parseManifest(JSON.stringify({ ...sample(), uri: 'abap:/x' }), 'm')).toThrow(/invalid/);
    expect(() => parseManifest('{', 'm')).toThrow(/not valid JSON/);
  });
});
