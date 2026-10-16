import { execFile } from 'node:child_process';

/**
 * The git plumbing the helper runs. Inside the repository git started it in:
 * `GIT_DIR` comes through the environment, relative to the working folder.
 */
export interface Git {
  /** The commit a revision names, or undefined when there is none. */
  revParse(rev: string): Promise<string | undefined>;
  /** The blobs (and anything else) under `dir` in `commit`, by path. */
  lsTree(commit: string, dir: string): Promise<Map<string, string>>;
  /** A git config value, or undefined when unset. */
  config(key: string): Promise<string | undefined>;
  /** `ancestor` is `commit` or one of its ancestors. */
  isAncestor(ancestor: string, commit: string): Promise<boolean>;
  /** What changed under `dir` from `from` to `to`, renames as delete plus add. */
  diffTree(from: string, to: string, dir: string): Promise<TreeChange[]>;
  /** A blob's content. */
  blob(sha: string): Promise<Buffer>;
  /** A commit's first parent (none for a root commit) and subject. */
  commitInfo(sha: string): Promise<{ parent?: string; subject: string }>;
  /** Every `Transport:` trailer value in `commit` and its ancestors: the requests git already holds. */
  transports(commit: string): Promise<Set<string>>;
}

/** One line of `diff-tree --raw`: modes, the new blob, status letter (A, M, D, T, …). */
export interface TreeChange {
  status: string;
  path: string;
  oldMode: string;
  newMode: string;
  newSha: string;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: typeof err?.code === 'number' ? err.code : 0, stdout, stderr });
    });
  });
}

function runBytes(args: string[], cwd?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 1 << 30 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args.join(' ')} failed: ${stderr.toString('utf8').trim() || err.message}`)) : resolve(stdout),
    );
  });
}

function check(args: string[], r: Run): string {
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export function realGit(cwd?: string): Git {
  return {
    async revParse(rev) {
      const args = ['rev-parse', '--verify', '--quiet', rev];
      const r = await run(args, cwd);
      if (r.code === 1) return undefined;
      return check(args, r).trim();
    },
    async lsTree(commit, dir) {
      const args = ['ls-tree', '-r', '-z', '--full-tree', commit, '--', dir];
      const out = check(args, await run(args, cwd));
      const entries = new Map<string, string>();
      for (const line of out.split('\0')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const [, , sha] = line.slice(0, tab).split(' ');
        entries.set(line.slice(tab + 1), sha!);
      }
      return entries;
    },
    async config(key) {
      const args = ['config', '--get', key];
      const r = await run(args, cwd);
      if (r.code === 1) return undefined;
      return check(args, r).trim();
    },
    async isAncestor(ancestor, commit) {
      const args = ['merge-base', '--is-ancestor', ancestor, commit];
      const r = await run(args, cwd);
      if (r.code === 1) return false;
      check(args, r);
      return true;
    },
    async diffTree(from, to, dir) {
      const args = ['diff-tree', '-r', '-z', '--raw', '--no-renames', from, to, '--', dir];
      // `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0`, repeated.
      const fields = check(args, await run(args, cwd)).split('\0');
      const changes: TreeChange[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const [oldMode = '', newMode = '', , newSha = '', status = ''] = fields[i]!.slice(1).split(' ');
        changes.push({ status, path: fields[i + 1]!, oldMode, newMode, newSha });
      }
      return changes;
    },
    blob(sha) {
      return runBytes(['cat-file', 'blob', sha], cwd);
    },
    async commitInfo(sha) {
      const args = ['show', '-s', '--format=%P%n%s', sha];
      const [parents = '', subject = ''] = check(args, await run(args, cwd)).split('\n');
      const parent = parents.split(' ')[0];
      return { ...(parent ? { parent } : {}), subject };
    },
    async transports(commit) {
      const args = ['log', '--format=%(trailers:key=Transport,valueonly,separator=%x20)', commit];
      return new Set(check(args, await run(args, cwd)).split(/\s+/).filter((t) => t !== ''));
    },
  };
}
