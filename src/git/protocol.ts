import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * Git's remote-helper protocol (`gitremote-helpers(7)`) as adt+ speaks it
 * (docs/decisions/011-git-remote-helper.md): `import` for fetch, one
 * branch `main` on the system side, private refs under `refs/adtplus/<remote>/`.
 */

export interface Session {
  remote: string;
  /** The private ref's commit, if a fetch made one. */
  tip(): Promise<string | undefined>;
  /** One `import` batch (refs deduped): the fast-import stream to answer with. */
  importRefs(refs: string[]): Promise<Buffer[]>;
  /** One `push` batch (`[+]<src>:<dst>` each): one `ok <dst>` or `error <dst> <why>` per spec. */
  pushRefs(specs: string[]): Promise<string[]>;
  /** `option <name> <value>`: whether the helper takes it. */
  option(name: string, value: string): boolean;
}

/** The one branch on the system side. */
export const MAIN = 'refs/heads/main';

/** The private ref an `import` writes for `MAIN`, per the refspec in `capabilities`. */
export const privateRef = (remote: string): string => `refs/adtplus/${remote}/heads/main`;

function write(out: Writable, chunk: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => out.write(chunk, (err) => (err ? reject(err) : resolve())));
}

/** Answer git's commands until it closes stdin or sends a blank line. */
export async function serve(input: Readable, out: Writable, session: Session): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  // Closing pauses the input: a failed command must not leave stdin holding the process (and git waiting on it).
  try {
    await loop(rl[Symbol.asyncIterator](), out, session);
  } finally {
    rl.close();
  }
}

async function loop(lines: AsyncIterator<string>, out: Writable, session: Session): Promise<void> {
  const next = async (): Promise<string | undefined> => {
    const r = await lines.next();
    return r.done ? undefined : r.value;
  };
  /** The rest of a batch: lines with the same command up to the blank line. */
  const batch = async (first: string, prefix: string): Promise<string[]> => {
    const items = [first.slice(prefix.length)];
    for (let line = await next(); line; line = await next()) {
      if (!line.startsWith(prefix)) throw new Error(`unexpected "${line}" in a batch of ${prefix.trim()}`);
      items.push(line.slice(prefix.length));
    }
    return items;
  };

  for (let line = await next(); line; line = await next()) {
    if (line === 'capabilities') {
      await write(out, `import\npush\nrefspec refs/heads/*:refs/adtplus/${session.remote}/heads/*\noption\n\n`);
    } else if (line === 'list' || line === 'list for-push') {
      // For a push the tip lets git refuse a non-fast-forward itself; a fetch needs `?`, or git skips the import (P1).
      const tip = line === 'list for-push' ? await session.tip() : undefined;
      await write(out, `${tip ?? '?'} ${MAIN}\n@${MAIN} HEAD\n\n`);
    } else if (line.startsWith('option ')) {
      const [name = '', ...value] = line.slice('option '.length).split(' ');
      await write(out, session.option(name, value.join(' ')) ? 'ok\n' : 'unsupported\n');
    } else if (line.startsWith('import ')) {
      // A clone names main twice (branch and HEAD).
      const refs = [...new Set(await batch(line, 'import '))];
      for (const chunk of await session.importRefs(refs)) await write(out, chunk);
    } else if (line.startsWith('push ')) {
      const answers = await session.pushRefs(await batch(line, 'push '));
      await write(out, `${answers.join('\n')}\n\n`);
    } else {
      throw new Error(`git sent an unknown command "${line}"`);
    }
  }
}
