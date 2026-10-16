import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Git } from './git.js';

/**
 * `<shadow>/state.json`: which commit of the private ref the shadow's bases belong to. A push's
 * conflict check compares the system with those bases, so they must be the state the pushed
 * commit was based on; a shadow ahead of the ref would let a push overwrite a change git never
 * showed. Unknown or stale means "git fetch first".
 */
export type ShadowState =
  /** The bases are this commit's state (an unchanged fetch, an `ok` push). */
  | { matches: string }
  /**
   * A fetch made commits on `parent` with these subjects, oldest first (transport commits, then
   * the sync commit); git sets the ref after the helper ends. `subject` alone: one commit (before G6).
   */
  | { fetched: { parent?: string; subjects?: string[]; subject?: string } }
  /** The bases moved past any commit git has (a stopped pull, a push left undone, a re-read). */
  | { stale: true };

const FILE = 'state.json';

export async function readState(root: string): Promise<ShadowState | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, FILE), 'utf8')) as ShadowState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export async function writeState(root: string, state: ShadowState): Promise<void> {
  await writeFile(path.join(root, FILE), `${JSON.stringify(state)}\n`);
}

/** Whether the shadow's bases are the private tip's state. */
export async function shadowMatches(git: Git, root: string, tip: string): Promise<boolean> {
  const state = await readState(root);
  if (!state || 'stale' in state) return false;
  if ('matches' in state) return state.matches === tip;
  // The commits git made from the last fetch's stream: their subjects and the base say so.
  const subjects = state.fetched.subjects ?? (state.fetched.subject !== undefined ? [state.fetched.subject] : []);
  if (subjects.length === 0) return false;
  let at: string | undefined = tip;
  for (const subject of [...subjects].reverse()) {
    if (at === undefined) return false;
    const commit = await git.commitInfo(at);
    if (commit.subject !== subject) return false;
    at = commit.parent;
  }
  return at === state.fetched.parent;
}

/** `<shadow>/stamps.json`: the change stamps (`mirror.changes`) taken before the last complete pull. */
export type Stamps = Record<string, string | null>;

export interface StampsFile {
  /** Absent until a full pull finished. */
  stamps?: Stamps;
  /**
   * The stamps taken before the full pull the manifest's `pull` record stands for, while it is
   * unfinished: a resume re-reads what changed since, not only what the stopped pull hadn't read.
   */
  pending?: Stamps;
  /** Objects without a stamp that adt-ls couldn't find by name: left out until the next full pull. */
  unreachable?: string[];
}

export async function readStamps(root: string): Promise<StampsFile | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, 'stamps.json'), 'utf8')) as StampsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export async function writeStamps(root: string, file: StampsFile): Promise<void> {
  await writeFile(path.join(root, 'stamps.json'), `${JSON.stringify(file)}\n`);
}
