import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAYOUT_PROFILE, cleanSource, findBundledBinary, resolveBinary } from '../../src/core/abap-cleaner.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-cleaner-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for abap-cleaner: logs its arguments, upper-cases the source, or refuses like 1.29 (stderr, exit 0, no file). */
function fakeBinary(behaviour: 'upper' | 'refuse' | 'crash'): string {
  const file = path.join(dir, 'abap-cleaner');
  const body = {
    upper: "fs.writeFileSync(arg('--targetfile'), fs.readFileSync(arg('--sourcefile'), 'utf8').toUpperCase().replace(/\\n/g, '\\r\\n'));",
    refuse:
      "process.stderr.write('line 3: Parse error in line 3: expected ENDLOOP, but found ENDMETHOD. \\n\\n1 entry was added to the error log \\'/x/error.log\\': the cleanup was cancelled\\n');",
    crash: "process.stderr.write('boom'); process.exit(2);",
  }[behaviour];
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(args));
${body}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const argsSeen = (): string[] => JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8')) as string[];

describe('LAYOUT_PROFILE', () => {
  it("lists abap-cleaner 1.29's 100 rules once each, the 47 layout rules on", () => {
    const profile = JSON.parse(LAYOUT_PROFILE) as { ruleCount: number; autoActivateNewFeatures: boolean; rules: Array<{ ruleID: string; isActive: boolean }> };
    expect(profile.ruleCount).toBe(100);
    expect(new Set(profile.rules.map((r) => r.ruleID)).size).toBe(100);
    expect(profile.rules.filter((r) => r.isActive)).toHaveLength(47);
    expect(profile.autoActivateNewFeatures).toBe(true);
    const active = new Set(profile.rules.filter((r) => r.isActive).map((r) => r.ruleID));
    for (const rewrite of ['CALCULATION_ASSIGNMENT', 'CAMEL_CASE_NAME', 'DDL_CAMEL_CASE_NAME', 'UNUSED_VARIABLES', 'PRAGMA_POSITION']) {
      expect(active.has(rewrite)).toBe(false);
    }
  });
});

describe('findBundledBinary', () => {
  function install(root: string, extension: string, platform: 'darwin' | 'linux'): string {
    const bin =
      platform === 'darwin'
        ? path.join(dir, root, 'extensions', extension, 'binary', 'abapcleaner.app', 'Contents', 'MacOS')
        : path.join(dir, root, 'extensions', extension, 'binary', 'abapcleaner');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'abap-cleaner'), '');
    return path.join(bin, 'abap-cleaner');
  }

  it('takes the newest extension version, comparing numbers', () => {
    install('.vscode', 'saposs.abap-cleaner-1.9.0-darwin-arm64', 'darwin');
    const newest = install('.vscode', 'saposs.abap-cleaner-1.29.0-darwin-arm64', 'darwin');
    expect(findBundledBinary(dir, 'darwin')).toBe(newest);
  });

  it('looks in VS Code Insiders and on remotes too, and per platform', () => {
    const linux = install('.vscode-server', 'saposs.abap-cleaner-1.29.0-linux-x64', 'linux');
    expect(findBundledBinary(dir, 'linux')).toBe(linux);
    expect(findBundledBinary(dir, 'darwin')).toBeUndefined();
  });

  it('takes the newest across installs, not the first install that has one', () => {
    install('.vscode', 'saposs.abap-cleaner-1.20.0-darwin-arm64', 'darwin');
    const insiders = install('.vscode-insiders', 'saposs.abap-cleaner-1.29.0-darwin-arm64', 'darwin');
    expect(findBundledBinary(dir, 'darwin')).toBe(insiders);
  });
});

describe('resolveBinary', () => {
  it('uses the configured path, and refuses one without a file', async () => {
    const file = fakeBinary('upper');
    expect(await resolveBinary({ path: file })).toBe(file);
    await expect(resolveBinary({ path: path.join(dir, 'missing') })).rejects.toThrow(/format.abapCleaner.path: no file at/);
  });
});

describe('cleanSource', () => {
  it('passes the source as a file and the layout profile inline, and returns \\n line ends', async () => {
    const binary = fakeBinary('upper');
    expect(await cleanSource('method x.\nendmethod.\n', { path: binary, release: '758' })).toBe('METHOD X.\nENDMETHOD.\n');
    const args = argsSeen();
    expect(args).toEqual(expect.arrayContaining(['--sourcefile', '--targetfile', '--overwrite', '--profiledata', LAYOUT_PROFILE, '--release', '758']));
    expect(args).not.toContain('--profile');
  });

  it('passes a configured profile file instead', async () => {
    const binary = fakeBinary('upper');
    const profile = path.join(dir, 'team.cfj');
    writeFileSync(profile, '{}');
    await cleanSource('x', { path: binary, profile });
    expect(argsSeen()).toEqual(expect.arrayContaining(['--profile', profile]));
    expect(argsSeen()).not.toContain('--profiledata');
  });

  it("throws abap-cleaner's parse error, without its pointer to its own log", async () => {
    const binary = fakeBinary('refuse');
    await expect(cleanSource('x', { path: binary })).rejects.toThrow(
      'abap-cleaner refused: line 3: Parse error in line 3: expected ENDLOOP, but found ENDMETHOD.',
    );
  });

  it('throws when it fails, and refuses a missing profile before running', async () => {
    const binary = fakeBinary('crash');
    await expect(cleanSource('x', { path: binary })).rejects.toThrow('abap-cleaner failed: boom');
    await expect(cleanSource('x', { path: binary, profile: path.join(dir, 'none.cfj') })).rejects.toThrow(/format.abapCleaner.profile: no file at/);
  });
});
