import path from 'node:path';
import type { DaemonRequest } from '../daemon/protocol.js';

/**
 * `adtplus mirror init|pull|status|check|new|push|activate` (docs/decisions/007-mirror-mode.md). The
 * working folder is the one workspace folder: `--root` (default: here) must
 * lie inside it.
 */
/** `--rules '{"abapdoc":true}'`: abaplint rule switches. */
export function ruleSwitches(value: string | undefined): Record<string, boolean> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--rules must be a JSON object of rule names to true/false');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'boolean')) {
    throw new Error('--rules must be a JSON object of rule names to true/false');
  }
  return parsed as Record<string, boolean>;
}

export function buildMirrorRequest(
  action: string | undefined,
  flags: Record<string, string | undefined>,
  cwd: string,
): DaemonRequest {
  const location = { root: path.resolve(cwd, flags.root ?? '.'), workspaceFolders: [cwd] };
  const system = (): string => {
    if (flags.system === undefined) throw new Error('missing required --system');
    return flags.system;
  };
  switch (action) {
    case 'init': {
      const pkg = flags.package;
      if (pkg === undefined) throw new Error('missing required --package');
      return {
        cmd: 'mirror.init',
        system: system(),
        package: pkg,
        ...(flags['no-subpackages'] !== undefined ? { subpackages: false } : {}),
        ...location,
      };
    }
    case 'pull': {
      const max = flags['max-objects'];
      if (max !== undefined && !/^\d+$/.test(max)) throw new Error('--max-objects must be a whole number');
      return { cmd: 'mirror.pull', system: system(), ...(max !== undefined ? { maxObjects: Number(max) } : {}), ...location };
    }
    case 'status':
      return { cmd: 'mirror.status', ...location };
    case 'check':
      return { cmd: 'mirror.check', system: system(), ...location, rules: ruleSwitches(flags.rules) };
    case 'push': {
      const max = flags['max-objects'];
      if (max !== undefined && !/^\d+$/.test(max)) throw new Error('--max-objects must be a whole number');
      return {
        cmd: 'mirror.push',
        system: system(),
        ...(flags['dry-run'] !== undefined ? { dryRun: true } : {}),
        ...(flags['no-activate'] !== undefined ? { activate: false } : {}),
        ...(flags.transport !== undefined ? { transport: flags.transport } : {}),
        ...(max !== undefined ? { maxObjects: Number(max) } : {}),
        ...location,
      };
    }
    case 'activate':
      return { cmd: 'mirror.activate', system: system(), ...location };
    case 'new': {
      const { type, name } = flags;
      if (type === undefined) throw new Error('missing required --type');
      if (name === undefined) throw new Error('missing required --name');
      return {
        cmd: 'mirror.new',
        system: system(),
        type,
        name,
        ...(flags.package !== undefined ? { package: flags.package } : {}),
        ...(flags.description !== undefined ? { description: flags.description } : {}),
        ...location,
      };
    }
    default:
      throw new Error(`unknown mirror action "${action ?? ''}"`);
  }
}
