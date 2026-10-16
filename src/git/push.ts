import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonProgress, DaemonRequest, DaemonResponse } from '../daemon/protocol.js';
import type { ObjectIssue, PushResult } from '../mirror/push.js';
import { MAX_LISTED, type PullResult } from '../mirror/pull.js';
import type { MirrorActivateResult } from '../mirror/activate.js';
import { SRC_DIR, isReadOnlyFile, safeTarget } from '../mirror/layout.js';
import { saveManifest, type Manifest, type ManifestFileEntry } from '../mirror/manifest.js';
import { contentHash } from '../mirror/normalize.js';
import type { GitAddress } from './address.js';
import { call, maxObjects, shadowManifest, shadowOf } from './fetch.js';
import type { Git } from './git.js';
import { meter } from './output.js';
import { MAIN, privateRef } from './protocol.js';
import { shadowMatches, writeState } from './state.js';

/**
 * `push` (docs/decisions/011-git-remote-helper.md, "Push"): the pushed commit's
 * changes under `src/` since the private tip go into the shadow mirror, and the
 * unchanged `mirror.push` sends them through every gate. `ok` only when the push
 * is complete; the shadow is put back to its base either way.
 */

export interface PushDeps {
  send: (req: DaemonRequest, onProgress?: (p: DaemonProgress) => void) => Promise<DaemonResponse>;
  git: Git;
  gitDir: string;
  remote: string;
  address: GitAddress;
  /** Progress and the summary; quiet under `-q`. */
  say: (line: string) => void;
  /** What is left undone; always shown. */
  warn: (line: string) => void;
  /** A progress line that the next one replaces (git's `progress` option); absent: no progress. */
  progress?: (line: string) => void;
}

/** The push's progress: objects written of all, then the activation. */
function pushProgress(show: (line: string) => void): (p: DaemonProgress) => void {
  const writing = meter(show, 'writing objects');
  return (p) => (p.stage === 'activating' ? show(`adtplus: activating ${p.total} object(s)…`) : writing(p.done, p.total, p.units));
}

export interface PushSettings {
  dryRun: boolean;
  /** Each `git push -o <value>`. */
  pushOptions: string[];
}

/** A push refused before anything reached the system. */
class Refusal extends Error {}

/** Modes a push sends: regular files. */
const FILE_MODES = new Set(['100644', '100755']);

/** `-o transport=<request>`, `-o no-activate`; anything else refuses the push. */
function parsePushOptions(values: string[]): { transport?: string; activate: boolean } {
  let transport: string | undefined;
  let activate = true;
  for (const v of values) {
    if (v === 'no-activate') activate = false;
    else if (v.startsWith('transport=') && v.length > 'transport='.length) transport = v.slice('transport='.length).toUpperCase();
    else throw new Refusal(`unknown push option "${v}"; adt+ takes -o transport=<request> and -o no-activate`);
  }
  return { ...(transport ? { transport } : {}), activate };
}

function names(paths: string[]): string {
  return paths.length > 5 ? `${paths.slice(0, 5).join(', ')} and ${paths.length - 5} more` : paths.join(', ');
}

/** The manifest's entry for a repository path, if an object holds it. */
function entryOf(manifest: Manifest, rel: string): ManifestFileEntry | undefined {
  const dir = path.posix.dirname(rel);
  const name = path.posix.basename(rel);
  for (const o of Object.values(manifest.objects)) if (o.dir === dir && o.files[name]) return o.files[name];
  return undefined;
}

async function readIfThere(abs: string): Promise<Buffer | undefined> {
  try {
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** A noBase issue: a changed file whose last read failed, never sent. */
const isNoBase = (i: ObjectIssue) => /: no base to compare with, /.test(i.message);

/** A count from a list push capped at `MAX_LISTED`. */
const countOf = (list: unknown[]) => (list.length >= MAX_LISTED ? `${MAX_LISTED}+` : String(list.length));

/** One line per thing the push left undone, and the counts for git's `error` line. */
function undone(r: PushResult | undefined, activated?: MirrorActivateResult): { lines: string[]; counts: string[] } {
  const lines: string[] = [];
  const counts: string[] = [];
  const issues = (label: string, list: ObjectIssue[] = []) => {
    for (const i of list) lines.push(`adtplus: ${label}: ${i.object}: ${i.message}`);
    if (list.length > 0) counts.push(`${countOf(list)} ${label}`);
  };
  issues('conflict', r?.conflicts);
  issues('blocked', r?.blocked);
  issues('refused', [...(r?.refused ?? []), ...(activated?.refused ?? [])]);
  issues('failed', r?.failed.filter((i) => !isNoBase(i)));
  issues('no base (fetch first)', r?.failed.filter(isNoBase));
  issues('cannot create', r?.cannotCreate);
  issues('misnamed', r?.misnamed);
  issues('left out', r?.leftOut);
  const files = (label: string, listed?: { count: number; paths: string[] }) => {
    for (const p of listed?.paths ?? []) lines.push(`adtplus: ${label}: ${p}`);
    if (listed && listed.count > 0) counts.push(`${listed.count} ${label}`);
  };
  files('not sent (new file of an existing object; a fetch brings the system\'s)', r?.newLocally);
  files('not sent (read-only)', r?.notSent);
  files('moved between packages', r?.moved);
  const a = activated?.activation ?? r?.activation;
  if (a) {
    for (const d of a.diagnostics.filter((x) => x.severity === 'error')) lines.push(`adtplus: ${d.path}:${d.line}: ${d.message}`);
    if (a.failure) lines.push(`adtplus: activation failed: ${a.failure}`);
    if (a.notActivated.count > 0) counts.push(`${a.notActivated.count} not activated`);
    for (const f of a.readBack?.failed ?? []) lines.push(`adtplus: read-back failed: ${f.object}: ${f.message}`);
    if (a.readBack && (a.readBack.failed.length > 0 || a.readBack.conflicts.count > 0)) counts.push('read-back incomplete');
  }
  return { lines, counts };
}

/** Answer one `push <src>:<dst>`: `ok <dst>` or `error <dst> <why>`. */
export async function pushRef(deps: PushDeps, spec: string, settings: PushSettings): Promise<string> {
  const force = spec.startsWith('+');
  const [src = '', dst = ''] = (force ? spec.slice(1) : spec).split(':');
  try {
    return `ok ${await pushCommit(deps, src, dst, force, settings)}`;
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
    if (!(err instanceof Refusal)) deps.warn(`adtplus: ${why}`);
    return `error ${dst} ${why}`;
  }
}

/** git's own reason for a push that needs a fetch first: it then prints its usual hint (P1). */
const FETCH_FIRST = 'fetch first';

async function pushCommit(deps: PushDeps, src: string, dst: string, force: boolean, settings: PushSettings): Promise<string> {
  const { git, address } = deps;
  if (dst !== MAIN) throw new Refusal(`the system has one branch, main; push to ${MAIN}`);
  if (src === '') throw new Refusal("main can't be deleted on the system");
  if (force) throw new Refusal('force push refused: the system keeps no history to overwrite; fetch, rebase and push again');
  const options = parsePushOptions(settings.pushOptions);
  const { activate } = options;
  const transport = options.transport ?? (await git.config('adtplus.transport'))?.toUpperCase();

  const commit = await git.revParse(`${src}^{commit}`);
  if (!commit) throw new Refusal(`${src} is no commit`);
  const tip = await git.revParse(`${privateRef(deps.remote)}^0`);
  if (!tip) throw new Refusal('nothing fetched from the system yet; git fetch first');
  if (!(await git.isAncestor(tip, commit))) throw new Refusal(FETCH_FIRST);

  // Deletes refuse the whole push (ADR-007), before any SAP call; so do files push never sends.
  const changes = await git.diffTree(tip, commit, SRC_DIR);
  const deleted = changes.filter((c) => c.status === 'D').map((c) => c.path);
  if (deleted.length > 0) throw new Refusal(`deletes aren't pushed (ADR-007; a move is a delete): ${names(deleted)}`);
  const odd = changes.filter((c) => !FILE_MODES.has(c.newMode)).map((c) => c.path);
  if (odd.length > 0) throw new Refusal(`only regular files are pushed: ${names(odd)}`);
  const readOnly = changes.filter((c) => isReadOnlyFile(path.posix.basename(c.path))).map((c) => c.path);
  if (readOnly.length > 0) throw new Refusal(`.jsonc and .properties files are never sent (ADR-007): ${names(readOnly)}`);
  const { root, workspace } = shadowOf(deps.gitDir, deps.remote);
  const manifest = await shadowManifest(root, address);
  const location = { system: address.system, root, workspaceFolders: [workspace] };
  if (changes.length === 0) {
    // Nothing to write; objects an earlier push left inactive are activated (a retry after an activation error).
    const waiting = Object.values(manifest?.objects ?? {}).some((o) => o.unactivated);
    if (!waiting || !activate || settings.dryRun) {
      deps.say(`adtplus: nothing under ${SRC_DIR}/ changed since ${tip.slice(0, 7)}`);
      return dst;
    }
    const activated = await call<MirrorActivateResult>(deps, { cmd: 'mirror.activate', ...location }, 'push again');
    const { lines, counts } = undone(undefined, activated);
    for (const line of lines) deps.warn(line);
    deps.say(`adtplus: ${address.system}: ${activated.activation.activated.count} object(s) activated a push left inactive`);
    if (!activated.complete) throw new Refusal(counts.join(', ') || 'incomplete');
    return dst;
  }
  if (!manifest) throw new Refusal('no shadow mirror; git fetch first');
  if (manifest.pull) throw new Refusal('a fetch stopped before it finished; git fetch first');
  // The conflict check compares the system with the shadow's bases: they must be the tip's state.
  if (!(await shadowMatches(git, root, tip))) {
    deps.warn(`adtplus: the system's state adt+ last read is newer than ${privateRef(deps.remote)}; fetch, rebase and push again`);
    throw new Refusal(FETCH_FIRST);
  }
  const max = await maxObjects(git);

  /** Each file written into the shadow, with what it held before (undefined: no file). */
  const originals = new Map<string, Buffer | undefined>();
  let result: PushResult;
  let activated: MirrorActivateResult | undefined;
  /** The shadow took system state from outside this push (a re-read), or couldn't be put back. */
  let foreign = false;
  try {
    for (const c of changes) {
      const target = await safeTarget(root, c.path, { mkdir: true });
      originals.set(c.path, await readIfThere(target));
      await writeFile(target, await git.blob(c.newSha));
    }
    // Until the outcome is known the shadow may be ahead of any commit git has.
    if (!settings.dryRun) await writeState(root, { stale: true });
    deps.say(`adtplus: ${settings.dryRun ? 'planning' : 'pushing'} ${changes.length} file(s) to ${address.system}…`);
    result = await call<PushResult>(
      deps,
      {
        cmd: 'mirror.push',
        ...location,
        ...(settings.dryRun ? { dryRun: true } : {}),
        ...(activate ? {} : { activate: false }),
        ...(transport ? { transport } : {}),
        ...(max !== undefined ? { maxObjects: max } : {}),
        takeSystemVersion: true,
      },
      'push again',
      deps.progress && pushProgress(deps.progress),
    );
    // Objects an earlier push left inactive, when this one wrote nothing to activate them with.
    if (!settings.dryRun && activate && !result.activation && result.unactivated.count > 0) {
      activated = await call<MirrorActivateResult>(deps, { cmd: 'mirror.activate', ...location }, 'push again');
    }
  } finally {
    try {
      foreign = await settleShadow(deps, root, workspace, originals, max);
    } catch (err) {
      foreign = true;
      // Never in place of the push's own outcome; the shadow is then no commit's state.
      deps.warn(`adtplus: putting the shadow back failed, fetch before pushing again: ${err instanceof Error ? err.message : String(err)}`);
      await writeState(root, { stale: true }).catch(() => undefined);
    }
  }

  const { lines, counts } = undone(result, activated);
  for (const line of lines) deps.warn(line);
  const s = result;
  const activation = activated?.activation ?? s.activation;
  deps.say(
    settings.dryRun
      ? `adtplus: dry run: would write ${s.planned.count} object(s)${s.planned.count ? ` (${s.planned.paths.join(', ')})` : ''}, ` +
          `create ${s.toCreate.count}${s.toCreate.count ? ` (${s.toCreate.paths.join(', ')})` : ''}`
      : `adtplus: ${address.system}: ${s.pushed.count} object(s) written, ${s.created.count} created, ${s.written.count} file(s)` +
          `${activation ? `, ${activation.activated.count} activated` : activate ? '' : ', not activated (-o no-activate)'}; ${s.units} units`,
  );
  const complete =
    s.complete &&
    (activated?.complete ?? true) &&
    s.newLocally.count === 0 &&
    s.notSent.count === 0 &&
    s.deletedLocally.count === 0;
  // A failed object may have been written partly (or read back badly); a no-base file never was.
  const wrote = !settings.dryRun && (s.written.count > 0 || s.created.count > 0 || s.failed.some((i) => !isNoBase(i)));
  // Incomplete, the bases differ from the tip's state only by this push's own writes, which a later
  // push from the tip may overwrite; anything read from the system besides needs a fetch first.
  if (!settings.dryRun && !foreign) await writeState(root, { matches: complete ? commit : tip });
  if (!complete) throw new Refusal(`${counts.join(', ') || 'incomplete'}${wrote ? '; anything written comes back with the next fetch' : ''}`);
  return dst;
}

/**
 * Put the shadow back to its base after a push: a file the system took is kept (push wrote the
 * system's version into it); one that wasn't sent gets its old content back, or goes when it had
 * none. A file whose base push couldn't take (a written file whose read-back failed) is re-read by
 * a pull, so the shadow never holds a local change.
 */
async function settleShadow(
  deps: PushDeps,
  root: string,
  workspace: string,
  originals: Map<string, Buffer | undefined>,
  max: number | undefined,
): Promise<boolean> {
  if (originals.size === 0) return false;
  const manifest = await shadowManifest(root, deps.address);
  if (!manifest) return false;
  let reread = 0;
  for (const [rel, original] of originals) {
    const target = await safeTarget(root, rel);
    const entry = entryOf(manifest, rel);
    const local = await readIfThere(target);
    if (entry?.hash !== undefined && local !== undefined && contentHash(local.toString('utf8')) === entry.hash) continue;
    if (entry?.hash !== undefined && original !== undefined && contentHash(original.toString('utf8')) === entry.hash) {
      await writeFile(target, original);
      continue;
    }
    await rm(target, { force: true });
    if (entry) {
      // No base to put back: without a hash and a file, the next pull takes the system's version.
      delete entry.hash;
      reread += 1;
    }
  }
  if (reread === 0) return false;
  await saveManifest(root, manifest);
  deps.warn(`adtplus: re-reading ${reread} file(s) the push left without a base`);
  try {
    const pulled = await call<PullResult>(deps, {
      cmd: 'mirror.pull',
      system: deps.address.system,
      root,
      workspaceFolders: [workspace],
      ...(max !== undefined ? { maxObjects: max } : {}),
    });
    for (const e of pulled.errors) deps.warn(`adtplus: not read: ${e.path}: ${e.message}`);
  } catch (err) {
    // Never in place of the push's own outcome: the next fetch's pull reads them.
    deps.warn(`adtplus: re-read failed, the next fetch reads them: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}
