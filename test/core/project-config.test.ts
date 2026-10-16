import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approve,
  findProjectConfigs,
  isTrusted,
  projectFolderOf,
  readTrustStore,
  sha256,
} from '../../src/core/project-config.js';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-home-')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function projectConfig(folder: string): string {
  const dir = path.join(home, folder, '.adtplus');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'systems.json');
  writeFileSync(file, '{}');
  return file;
}

describe('findProjectConfigs', () => {
  it('finds each .adtplus/systems.json from the start folder up, nearest first', () => {
    const customer = projectConfig('projects/cust');
    const repo = projectConfig('projects/cust/repo');
    const start = path.join(home, 'projects/cust/repo/src/deep');
    mkdirSync(start, { recursive: true });

    expect(findProjectConfigs(start, home)).toEqual([repo, customer]);
  });

  it('never reads the one in $HOME itself', () => {
    projectConfig('.');
    const start = path.join(home, 'projects');
    mkdirSync(start, { recursive: true });

    expect(findProjectConfigs(start, home)).toEqual([]);
    expect(findProjectConfigs(home, home)).toEqual([]);
  });

  it('reads nothing when the start folder is outside $HOME', () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-outside-')));
    try {
      mkdirSync(path.join(outside, '.adtplus'));
      writeFileSync(path.join(outside, '.adtplus', 'systems.json'), '{}');
      expect(findProjectConfigs(outside, home)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not treat a sibling folder with $HOME as a prefix as inside', () => {
    const sibling = `${home}-other`;
    mkdirSync(path.join(sibling, '.adtplus'), { recursive: true });
    try {
      writeFileSync(path.join(sibling, '.adtplus', 'systems.json'), '{}');
      expect(findProjectConfigs(sibling, home)).toEqual([]);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe('projectFolderOf', () => {
  it('is the folder holding .adtplus/', () => {
    expect(projectFolderOf('/h/projects/cust/.adtplus/systems.json')).toBe('/h/projects/cust');
  });
});

describe('trust store', () => {
  it('is empty when the file does not exist', async () => {
    expect(await readTrustStore(path.join(home, 'missing.json'))).toEqual({});
  });

  it('records an approval by path and hash, mode 0600, and an edit revokes it', async () => {
    const store = path.join(home, '.config', 'adtplus', 'trusted.json');
    const file = '/h/projects/cust/.adtplus/systems.json';
    const hash = sha256('{"a":1}');

    await approve(file, hash, store, new Date('2026-09-28T12:00:00Z'));

    const read = await readTrustStore(store);
    expect(read[file]).toEqual({ sha256: hash, approvedAt: '2026-09-28T12:00:00.000Z' });
    expect(isTrusted(read, file, hash)).toBe(true);
    expect(isTrusted(read, file, sha256('{"a":2}'))).toBe(false);
    expect(isTrusted(read, '/elsewhere/.adtplus/systems.json', hash)).toBe(false);
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });

  it('keeps earlier approvals when adding one', async () => {
    const store = path.join(home, 'trusted.json');
    await approve('/a', 'h1', store);
    await approve('/b', 'h2', store);

    expect(Object.keys(JSON.parse(readFileSync(store, 'utf8')))).toEqual(['/a', '/b']);
  });
});
