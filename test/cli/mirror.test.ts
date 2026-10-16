import { describe, expect, it } from 'vitest';
import { buildMirrorRequest } from '../../src/cli/mirror.js';

const CWD = '/work/repo';

describe('adtplus mirror', () => {
  it('init: system, package, root defaulting to the working folder, which is the workspace folder', () => {
    expect(buildMirrorRequest('init', { system: 'onprem', package: 'ZADTPLUS_A' }, CWD)).toEqual({
      cmd: 'mirror.init',
      system: 'onprem',
      package: 'ZADTPLUS_A',
      root: CWD,
      workspaceFolders: [CWD],
    });
    expect(buildMirrorRequest('init', { system: 'onprem', package: 'ZADTPLUS_A', 'no-subpackages': 'true', root: 'm' }, CWD)).toMatchObject({
      subpackages: false,
      root: '/work/repo/m',
    });
  });

  it('pull: --max-objects as a number, --root resolved against the working folder', () => {
    expect(buildMirrorRequest('pull', { system: 'cloud-erp', 'max-objects': '800', root: '../x' }, CWD)).toEqual({
      cmd: 'mirror.pull',
      system: 'cloud-erp',
      maxObjects: 800,
      root: '/work/x',
      workspaceFolders: [CWD],
    });
    expect(() => buildMirrorRequest('pull', { system: 'cloud-erp', 'max-objects': 'lots' }, CWD)).toThrow(/whole number/);
  });

  it('status needs no system', () => {
    expect(buildMirrorRequest('status', {}, CWD)).toEqual({ cmd: 'mirror.status', root: CWD, workspaceFolders: [CWD] });
  });

  it('check and new name the system; new takes type, name and optionally package and description', () => {
    expect(buildMirrorRequest('check', { system: 'onprem' }, CWD)).toEqual({ cmd: 'mirror.check', system: 'onprem', root: CWD, workspaceFolders: [CWD] });
    expect(buildMirrorRequest('new', { system: 'cloud-erp', type: 'BDEF', name: 'ZR_TRAVEL', package: 'ZADTPLUS_A', description: 'Travel', root: 'm' }, CWD)).toEqual({
      cmd: 'mirror.new',
      system: 'cloud-erp',
      type: 'BDEF',
      name: 'ZR_TRAVEL',
      package: 'ZADTPLUS_A',
      description: 'Travel',
      root: '/work/repo/m',
      workspaceFolders: [CWD],
    });
    expect(buildMirrorRequest('new', { system: 'cloud-erp', type: 'CLAS', name: 'ZCL_X' }, CWD)).not.toHaveProperty('package');
    expect(() => buildMirrorRequest('check', {}, CWD)).toThrow(/--system/);
    expect(() => buildMirrorRequest('new', { system: 'cloud-erp', name: 'ZCL_X' }, CWD)).toThrow(/--type/);
    expect(() => buildMirrorRequest('new', { system: 'cloud-erp', type: 'CLAS' }, CWD)).toThrow(/--name/);
  });

  it('push takes its flags; activate names the system', () => {
    expect(buildMirrorRequest('push', { system: 'onprem', 'dry-run': 'true', 'no-activate': 'true', transport: 'DEVK900001', 'max-objects': '9' }, CWD)).toEqual({
      cmd: 'mirror.push',
      system: 'onprem',
      dryRun: true,
      activate: false,
      transport: 'DEVK900001',
      maxObjects: 9,
      root: CWD,
      workspaceFolders: [CWD],
    });
    expect(buildMirrorRequest('push', { system: 'onprem' }, CWD)).toEqual({ cmd: 'mirror.push', system: 'onprem', root: CWD, workspaceFolders: [CWD] });
    expect(buildMirrorRequest('activate', { system: 'cloud-erp' }, CWD)).toEqual({ cmd: 'mirror.activate', system: 'cloud-erp', root: CWD, workspaceFolders: [CWD] });
    expect(() => buildMirrorRequest('push', {}, CWD)).toThrow(/--system/);
  });

  it('refuses missing flags and unknown actions', () => {
    expect(() => buildMirrorRequest('init', { system: 'onprem' }, CWD)).toThrow(/--package/);
    expect(() => buildMirrorRequest('pull', {}, CWD)).toThrow(/--system/);
    expect(() => buildMirrorRequest('delete', {}, CWD)).toThrow(/unknown mirror action "delete"/);
    expect(() => buildMirrorRequest(undefined, {}, CWD)).toThrow(/unknown mirror action/);
  });
});
