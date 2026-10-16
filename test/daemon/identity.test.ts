import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentIdentity, sameIdentity } from '../../src/daemon/identity.js';

let root: string;
let config: string;

function write(file: string, content: string, mtime = new Date('2026-09-23T10:00:00Z')): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, mtime, mtime);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'adtplus-identity-'));
  config = path.join(root, 'systems.json');
  write(path.join(root, 'package-lock.json'), '{}');
  write(path.join(root, 'src', 'daemon', 'server.ts'), 'export {};');
  write(config, '{}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const identity = () => currentIdentity({ root, configPaths: [config] });

describe('daemon identity', () => {
  it('is stable while nothing changes', () => {
    expect(sameIdentity(identity(), identity())).toBe(true);
  });

  it('changes its config half when the config is saved', () => {
    const before = identity();
    write(config, '{}', new Date('2026-09-23T11:00:00Z'));
    const after = identity();
    expect(after.config).not.toBe(before.config);
    expect(after.build).toBe(before.build);
  });

  it('changes its build half when a source file changes, in dev mode', () => {
    const before = identity();
    write(path.join(root, 'src', 'core', 'new.ts'), 'export {};');
    expect(identity().build).not.toBe(before.build);
  });

  it('stamps dist instead of src once built', () => {
    write(path.join(root, 'dist', 'daemon', 'server.js'), '');
    const built = identity();
    write(path.join(root, 'src', 'daemon', 'server.ts'), 'export const x = 1;', new Date('2026-09-23T11:00:00Z'));
    expect(identity().build).toBe(built.build);
    write(path.join(root, 'dist', 'chunk-A.js'), '');
    expect(identity().build).not.toBe(built.build);
  });

  it('changes when the dependency lockfile changes', () => {
    const before = identity();
    write(path.join(root, 'package-lock.json'), '{"x":1}');
    expect(identity().build).not.toBe(before.build);
  });

  it('never matches a daemon that reports none', () => {
    expect(sameIdentity(undefined, identity())).toBe(false);
  });
});
