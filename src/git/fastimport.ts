import { blobSha } from '../mirror/normalize.js';

/**
 * The fast-import stream an `import` answers with (`git-fast-import(1)`): the
 * transport commits and the sync commit on the private ref, only `M`/`D` lines,
 * so whatever the tip holds outside them stays.
 */

export { blobSha };

/** A path as fast-import reads it: C-style quoted when it would be ambiguous unquoted. */
export function quotePath(p: string): string {
  if (!/^"|[\n\\"]|[\x00-\x1f\x7f]/.test(p)) return p;
  const escaped = p.replace(/[\\"\n\x00-\x1f\x7f]/g, (c) =>
    c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`,
  );
  return `"${escaped}"`;
}

/** `name <email> <seconds> <+hhmm>` for `author`/`committer`, in the local time zone. */
export function ident(name: string, email: string, at: Date): string {
  const offset = -at.getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${name} <${email}> ${Math.floor(at.getTime() / 1000)} ${zone}`;
}

export type FileChange = { op: 'M'; path: string; data: Buffer } | { op: 'D'; path: string };

export interface CommitSpec {
  ref: string;
  /** The parent; absent for the first commit. Ignored after the first commit of a stream. */
  from?: string;
  /** `ident()` of author and committer. */
  author: string;
  message: string;
  changes: FileChange[];
}

/**
 * A whole stream: the commits, if any, then `done`. Each commit after the first has the one
 * before it as parent (a mark), so `from` of the first is the whole chain's base.
 */
export function importStream(commits: CommitSpec | CommitSpec[] | undefined): Buffer[] {
  const list = commits === undefined ? [] : Array.isArray(commits) ? commits : [commits];
  const out: Buffer[] = [Buffer.from('feature done\n')];
  for (const [i, commit] of list.entries()) {
    const message = Buffer.from(commit.message);
    const mark = list.length > 1 ? `mark :${i + 1}\n` : '';
    let head = `commit ${commit.ref}\n${mark}author ${commit.author}\ncommitter ${commit.author}\ndata ${message.length}\n`;
    out.push(Buffer.from(head), message, Buffer.from('\n'));
    const from = i > 0 ? `:${i}` : commit.from;
    head = from ? `from ${from}\n` : '';
    for (const change of commit.changes) {
      if (change.op === 'D') {
        head += `D ${quotePath(change.path)}\n`;
        continue;
      }
      out.push(Buffer.from(`${head}M 100644 inline ${quotePath(change.path)}\ndata ${change.data.length}\n`), change.data, Buffer.from('\n'));
      head = '';
    }
    out.push(Buffer.from(`${head}\n`));
  }
  out.push(Buffer.from('done\n'));
  return out;
}
