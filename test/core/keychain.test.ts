import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    cb: (err: unknown, stdout: string, stderr: string) => void,
  ) => {
    const out = execFileMock(file, args);
    if (out instanceof Error) cb(out, '', '');
    else cb(null, out, '');
  },
}));

const { keychainEntryExists, readKeychainSecret } = await import('../../src/core/keychain.js');

describe('readKeychainSecret', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('calls security find-generic-password with argv, not a shell string', async () => {
    execFileMock.mockReturnValue('super"secret\n');

    const secret = await readKeychainSecret('DEV_100_SECRET');

    expect(execFileMock).toHaveBeenCalledWith('security', [
      'find-generic-password',
      '-s',
      'DEV_100_SECRET',
      '-w',
    ]);
    expect(secret).toBe('super"secret');
  });

  it('strips only the trailing newline', async () => {
    execFileMock.mockReturnValue('pw\nwith\nnewlines\n');
    const secret = await readKeychainSecret('svc');
    expect(secret).toBe('pw\nwith\nnewlines');
  });
});

describe('keychainEntryExists', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('asks without -w, so the secret is never printed', async () => {
    execFileMock.mockReturnValue('keychain: "login.keychain-db"\n');

    expect(await keychainEntryExists('DEV_100_SECRET')).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith('security', ['find-generic-password', '-s', 'DEV_100_SECRET']);
  });

  it('is false on exit code 44 (not found)', async () => {
    execFileMock.mockReturnValue(Object.assign(new Error('not found'), { code: 44 }));
    expect(await keychainEntryExists('missing')).toBe(false);
  });

  it('rethrows any other failure', async () => {
    execFileMock.mockReturnValue(Object.assign(new Error('spawn security ENOENT'), { code: 'ENOENT' }));
    await expect(keychainEntryExists('svc')).rejects.toThrow(/ENOENT/);
  });
});
