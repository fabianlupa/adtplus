import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigLayer } from '../../src/core/destinations.js';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    const { err, stdout = '', stderr = '' } = execFileMock(file, args) as { err?: Error; stdout?: string; stderr?: string };
    cb(err ?? null, stdout, stderr);
  },
}));

const { askTrustDialog, describeLayer, formatSummaries } = await import('../../src/core/trust-dialog.js');

function layer(systems: ConfigLayer['systems']): ConfigLayer {
  return { path: '/h/cust/.adtplus/systems.json', kind: 'project', sha256: 'x', trusted: false, systems };
}

describe('describeLayer', () => {
  it('lists an override with the inherited values, warning on a changed connection field and an opened gate', () => {
    const summary = describeLayer(
      layer({ onprem: { keychainService: 'OTHER', writeAllowlist: ['ZCUST'], vfsMount: 'M' } }),
      { onprem: { keychainService: 'DEV', writeAllowlist: ['ZDEV'] } },
      '~/cust/.adtplus/systems.json',
    );

    expect(summary).toEqual({
      path: '~/cust/.adtplus/systems.json',
      systems: [
        {
          id: 'onprem',
          action: 'overrides',
          fields: [
            { field: 'keychainService', value: '"OTHER"', was: '"DEV"', warn: true },
            { field: 'writeAllowlist', value: '["ZCUST"]', was: '["ZDEV"]', warn: true },
          ],
          warnings: [],
          also: ['vfsMount'],
        },
      ],
    });
  });

  it("flags a new system that borrows another system's Keychain password", () => {
    const summary = describeLayer(
      layer({ evil: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://evil.example', keychainService: 'DEV' } }),
      { onprem: { keychainService: 'DEV' } },
    );

    expect(summary.systems[0]?.action).toBe('adds');
    expect(summary.systems[0]?.fields.every((f) => !f.warn)).toBe(true);
    expect(summary.systems[0]?.warnings).toEqual(['uses the Keychain password of "onprem", sent to "https://evil.example"']);
  });

  it('does not warn on a closed gate or a rate limit', () => {
    const summary = describeLayer(layer({ onprem: { allowPublishService: false, rateLimit: { perMinute: 10 } } }), { onprem: {} });

    expect(summary.systems[0]?.fields).toEqual([
      { field: 'allowPublishService', value: 'false', warn: false },
      { field: 'rateLimit', value: '{"perMinute":10}', warn: false },
    ]);
  });
});

describe('describeLayer, an object field (ADR-006)', () => {
  it('shows what the object becomes merged onto the inherited one, and what it was', () => {
    const summary = describeLayer(layer({ onprem: { rateLimit: { perMinute: 10 } } }), { onprem: { rateLimit: { concurrency: 2, perMinute: 600 } } });
    expect(summary.systems[0]?.fields).toEqual([
      { field: 'rateLimit', value: '{"perMinute":10,"concurrency":2}', was: '{"concurrency":2,"perMinute":600}', warn: false },
    ]);
  });

  it('shows mirror among the gates and warns when the merge turns the git helper on', () => {
    const on = describeLayer(layer({ onprem: { mirror: { git: { enabled: true } } } }), { onprem: { mirror: { namespaces: ['/X/'] } } });
    expect(on.systems[0]?.fields).toEqual([
      { field: 'mirror', value: '{"git":{"enabled":true},"namespaces":["/X/"]}', was: '{"namespaces":["/X/"]}', warn: true },
    ]);
    expect(on.systems[0]?.also).toEqual([]);
    // Already on in the user config: the project's maxObjects keeps it on, which is no change.
    const kept = describeLayer(layer({ onprem: { mirror: { maxObjects: 9 } } }), { onprem: { mirror: { git: { enabled: true } } } });
    expect(kept.systems[0]?.fields[0]).toMatchObject({ field: 'mirror', value: '{"maxObjects":9,"git":{"enabled":true}}', warn: false });
  });
});

describe('describeLayer, format (ADR-017)', () => {
  it('warns when a project config changes the abap-cleaner binary or profile, not for the engine alone', () => {
    const program = describeLayer(layer({ onprem: { format: { abapCleaner: { path: '/tmp/x' } } } }), { onprem: {} });
    expect(program.systems[0]?.fields).toEqual([{ field: 'format', value: '{"abapCleaner":{"path":"/tmp/x"}}', warn: true }]);
    const profile = describeLayer(layer({ onprem: { format: { abapCleaner: { profile: '/tmp/p.cfj' } } } }), { onprem: {} });
    expect(profile.systems[0]?.fields[0]?.warn).toBe(true);
    const engine = describeLayer(layer({ onprem: { format: { engine: 'abap-cleaner', abapCleaner: { release: '758' } } } }), { onprem: {} });
    expect(engine.systems[0]?.fields[0]).toMatchObject({ field: 'format', warn: false });
    // The user config's path restated: no change, no warning.
    const same = describeLayer(layer({ onprem: { format: { abapCleaner: { path: '/tmp/x' } } } }), { onprem: { format: { abapCleaner: { path: '/tmp/x' } } } });
    expect(same.systems[0]?.fields[0]).toMatchObject({ field: 'format', warn: false });
  });
});

describe('formatSummaries', () => {
  it('renders the terminal fallback as plain text', () => {
    const summary = describeLayer(
      layer({ onprem: { writeAllowlist: ['ZCUST'], vfsMount: 'M' }, evil: { systemUrl: 'https://e', keychainService: 'DEV' } }),
      { onprem: { keychainService: 'DEV', writeAllowlist: ['ZDEV'] } },
      '~/cust/.adtplus/systems.json',
    );

    expect(formatSummaries([summary])).toBe(
      [
        '~/cust/.adtplus/systems.json',
        'overrides system "onprem":',
        '  ⚠ writeAllowlist: ["ZCUST"] (was ["ZDEV"])',
        '  also sets: vfsMount',
        'adds system "evil":',
        '  systemUrl: "https://e"',
        '  keychainService: "DEV"',
        '  ⚠ uses the Keychain password of "onprem", sent to "https://e"',
      ].join('\n'),
    );
  });
});

describe.runIf(process.platform === 'darwin')('askTrustDialog', () => {
  const summaries = [{ path: '~/p', systems: [] }];
  beforeEach(() => execFileMock.mockReset());

  it('runs a fixed JXA script and passes the data as a JSON argument', async () => {
    execFileMock.mockReturnValue({ stdout: 'allow\n' });

    expect(await askTrustDialog(summaries)).toBe('allow');
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('osascript');
    expect(args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(args[3]).not.toContain('~/p');
    // JXA hands runModal back as the string "1001": a strict compare with the number read every Allow as Deny.
    expect(args[3]).toContain('Number(alert.runModal) === 1001');
    expect(JSON.parse(args[4]!)).toMatchObject({ summaries });
  });

  it('denies on Deny and when the dialog is closed at its timeout', async () => {
    execFileMock.mockReturnValue({ stdout: 'deny\n' });
    expect(await askTrustDialog(summaries)).toBe('deny');

    execFileMock.mockReturnValue({ err: Object.assign(new Error('killed'), { killed: true }) });
    expect(await askTrustDialog(summaries)).toBe('deny');
  });

  it('is unavailable when no dialog can be shown', async () => {
    execFileMock.mockReturnValue({ err: new Error('exit 1'), stderr: 'execution error (-2700)' });
    expect(await askTrustDialog(summaries)).toBe('unavailable');
  });
});
