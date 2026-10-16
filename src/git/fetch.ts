import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonProgress, DaemonRequest, DaemonResponse } from '../daemon/protocol.js';
import { filesBelow } from '../mirror/files.js';
import { REMOTE_SUFFIX, SRC_DIR, objectOfPath, parseId } from '../mirror/layout.js';
import type { ChangesResult } from '../mirror/changes.js';
import type { ComponentResult } from '../mirror/component.js';
import { loadManifest, saveManifest, type Manifest } from '../mirror/manifest.js';
import { MAX_LISTED as PULL_LISTED, type InitResult, type PullResult } from '../mirror/pull.js';
import { addressLabel, formatAddress, type GitAddress } from './address.js';
import { HISTORY_DIR } from '../mirror/history.js';
import { blobSha, ident, importStream, type FileChange } from './fastimport.js';
import { historySettings, transportCommits, type TransportCommits } from './history.js';
import type { Git } from './git.js';
import { readStamps, writeStamps, writeState, type Stamps, type StampsFile } from './state.js';
import { idsOfKeys, planFetch, type FetchPlan } from './incremental.js';
import { meter } from './output.js';
import { privateRef } from './protocol.js';

/**
 * `import` (docs/decisions/011-git-remote-helper.md, "Fetch"): a full pull of
 * the shadow mirror in `$GIT_DIR/adtplus/<remote>/`, then one sync commit on
 * the private ref when the shadow's `src/` differs from its tip.
 */

/** Objects listed per line of a sync commit's body; the rest only counted. */
const MAX_LISTED = 50;

export interface FetchDeps {
  /** One daemon request, stamped with client kind `git`; asks for progress when `onProgress` is given. */
  send: (req: DaemonRequest, onProgress?: (p: DaemonProgress) => void) => Promise<DaemonResponse>;
  git: Git;
  /** Absolute `$GIT_DIR`. */
  gitDir: string;
  remote: string;
  address: GitAddress;
  /** One line of progress or report on stderr. */
  say: (line: string) => void;
  /** One warning on stderr, shown even when quiet; `say` when absent. */
  warn?: (line: string) => void;
  /** A progress line that the next one replaces (git's `progress` option); absent: no progress. */
  progress?: (line: string) => void;
  /** How often progress is polled. */
  progressMs?: number;
  now?: () => Date;
}

/** The shadow mirror's root and the one workspace folder it lies in. */
export function shadowOf(gitDir: string, remote: string): { root: string; workspace: string } {
  const workspace = path.join(gitDir, 'adtplus');
  return { root: path.join(workspace, ...remote.split('/')), workspace };
}

/** One daemon request; `again` names the retry a throttled answer suggests (`fetch again`, `push again`). */
export async function call<T>(
  deps: Pick<FetchDeps, 'send'>,
  req: DaemonRequest,
  again = 'fetch again',
  onProgress?: (p: DaemonProgress) => void,
): Promise<T> {
  const res = await deps.send(req, onProgress);
  if (!res.ok) {
    const resumes = again === 'fetch again' ? '; it resumes' : '';
    const retry = res.throttled && res.retryAfterMs !== undefined ? ` (${again} in ${Math.ceil(res.retryAfterMs / 1000)} s${resumes})` : '';
    throw new Error(`${res.error}${retry}`);
  }
  return (res as { result: T }).result;
}

/** `adtplus.maxObjects` from git config, if set. */
export async function maxObjects(git: Git): Promise<number | undefined> {
  const value = await git.config('adtplus.maxObjects');
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) === 0) throw new Error(`adtplus.maxObjects must be a positive whole number, not "${value}"`);
  return Number(value);
}

/** `<shadow>/address.json`: the address the shadow mirrors, written before its first `mirror.init`. */
const ADDRESS_FILE = 'address.json';

async function recordedAddress(root: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(path.join(root, ADDRESS_FILE), 'utf8')) as { address?: string }).address;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** The shadow's manifest, if a fetch made one; refused when it mirrors another address. */
export async function shadowManifest(root: string, address: GitAddress): Promise<Manifest | undefined> {
  const manifest = existsSync(root) ? await loadManifest(root) : undefined;
  // No manifest: no package was ever added (a first fetch whose package wasn't found leaves none).
  if (!manifest) return undefined;
  const recorded = await recordedAddress(root);
  if (recorded !== undefined && recorded !== formatAddress(address)) {
    throw new Error(`${root} mirrors ${recorded}, not the remote's address; remove that folder to fetch the new address`);
  }
  // A shadow from before G4 has no address file: its one package says what it mirrors.
  const p = manifest.packages;
  if (
    recorded === undefined &&
    (manifest.system !== address.system || address.kind !== 'package' || p.length !== 1 || p[0]!.name !== address.name || p[0]!.subpackages !== address.subpackages)
  ) {
    const was = `${manifest.system}/package/${p.map((x) => x.name).join(',')}`;
    throw new Error(`${root} mirrors ${was}, not the remote's address; remove that folder to fetch the new address`);
  }
  return manifest;
}

/** A software component's root packages now (`swc.packages`); refused above the ceiling or with none. */
async function componentRoots(deps: FetchDeps, max: number | undefined): Promise<ComponentResult> {
  const { address } = deps;
  const warn = deps.warn ?? deps.say;
  const r = await call<ComponentResult>(deps, {
    cmd: 'swc.packages',
    system: address.system,
    component: address.name,
    ...(max !== undefined ? { maxObjects: max } : {}),
  });
  if (r.exceeded) {
    throw new Error(
      `software component ${address.name} has ${r.objects} or more objects on ${address.system}, more than the ceiling allows; ` +
        'raise it (git -c adtplus.maxObjects=<n> clone …) or clone one of its packages',
    );
  }
  if (r.dropped.length > 0) {
    warn(`adtplus: left out, not a mirror's root package (Z, Y, $ or mirror.namespaces): ${r.dropped.join(', ')}`);
  }
  if (r.roots.length === 0) throw new Error(`software component ${address.name} has no package to clone on ${address.system}`);
  return r;
}

/**
 * Make the shadow on the first fetch; refuse one that mirrors another address. A software
 * component's roots are resolved again on every fetch: a new package becomes a root of the shadow,
 * one now inside another root stops being one. When that fails, a clone keeps the roots it has.
 */
async function ensureShadow(deps: FetchDeps, root: string, workspace: string, max: number | undefined): Promise<void> {
  const { address } = deps;
  const warn = deps.warn ?? deps.say;
  const manifest = await shadowManifest(root, address);
  if (manifest && address.kind === 'package') return;
  let resolved: Pick<ComponentResult, 'roots' | 'packages'>;
  if (address.kind === 'package') resolved = { roots: [address.name], packages: [address.name] };
  else {
    try {
      resolved = await componentRoots(deps, max);
    } catch (err) {
      if (!manifest) throw err;
      warn(`adtplus: ${addressLabel(address)}'s packages not resolved (${err instanceof Error ? err.message : String(err)}); fetching the ones the clone has`);
      return;
    }
  }
  const { roots, packages } = resolved;
  if (!manifest) {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, ADDRESS_FILE), `${JSON.stringify({ address: formatAddress(address) })}\n`);
  }
  const listed = new Set(manifest?.packages.map((p) => p.name) ?? []);
  for (const name of roots.filter((r) => !listed.has(r))) {
    if (manifest) deps.say(`adtplus: new in ${addressLabel(address)}: package ${name}`);
    const init = await call<InitResult>(deps, {
      cmd: 'mirror.init',
      system: address.system,
      package: name,
      subpackages: address.subpackages,
      root,
      workspaceFolders: [workspace],
    });
    if (!init.found) {
      // init saved a manifest anyway: a first fetch leaves no shadow behind, so the corrected address fetches.
      if (!manifest) await rm(root, { recursive: true, force: true });
      throw new Error(`package ${name} not found on ${address.system}`);
    }
  }
  const notRoots = [...listed].filter((p) => !roots.includes(p));
  // Still the component's, under a root now: that root's walk takes it, a second root would read it twice.
  const inside = notRoots.filter((p) => packages.includes(p));
  if (inside.length > 0) {
    const now = (await loadManifest(root))!;
    now.packages = now.packages.filter((p) => !inside.includes(p.name));
    await saveManifest(root, now);
    deps.say(`adtplus: no longer roots of ${addressLabel(address)}, now inside one: ${inside.join(', ')}`);
  }
  // A pull keeps the objects of a package that left the component (they are still on the system).
  const left = notRoots.filter((p) => !packages.includes(p));
  if (left.length > 0) warn(`adtplus: no longer in ${addressLabel(address)}, still fetched: ${left.join(', ')}; clone again to drop them`);
}

function reportPull(deps: FetchDeps, r: PullResult, some = false): void {
  const warn = deps.warn ?? deps.say;
  const more = (shown: number, count: number) => (count > shown ? [`  … and ${count - shown} more`] : []);
  for (const e of r.errors) warn(`adtplus: not read: ${e.path}: ${e.message}`);
  for (const u of r.unreadable) warn(`adtplus: folder not listed: ${u.path}: ${u.message}`);
  // The shadow holds no local changes; these mean someone edited it.
  for (const p of [...r.conflicts.paths, ...r.keptLocal.paths]) warn(`adtplus: shadow file changed outside the helper, kept: ${p}`);
  for (const p of r.collisions.paths) warn(`adtplus: not read, two objects share a file name: ${p}`);
  for (const line of more(r.collisions.paths.length, r.collisions.count)) warn(line);
  const secs = Math.round(r.ms / 1000);
  const scope = some ? `${r.objects} object(s) re-read` : `${r.packages.length} package(s), ${r.objects} objects`;
  deps.say(`adtplus: ${r.system} ${scope}, ${r.files} files: ${r.written.count} read new, ${r.deleted.count} gone; ${r.units} units in ${secs} s`);
}

/**
 * Pull what changed into the shadow (G5): the change stamps first, then only the objects whose
 * stamp moved, or a full pull when the stamps can't vouch for the rest (`incremental.ts`) or
 * `adtplus.fullFetch` asks for one. The stamps are taken before the pull and kept only once it
 * finished, so a change during the pull is seen again next time.
 */
async function bringShadowUpToDate(deps: FetchDeps, root: string, workspace: string, max: number | undefined): Promise<void> {
  const { address, git } = deps;
  const warn = deps.warn ?? deps.say;
  const location = { system: address.system, root, workspaceFolders: [workspace], ...(max !== undefined ? { maxObjects: max } : {}) };
  deps.say(`adtplus: checking ${address.name} on ${address.system} for changes…`);
  let stamps: ChangesResult | undefined;
  try {
    const shown = deps.progress && meter(deps.progress, 'checking stamps');
    stamps = await call<ChangesResult>(deps, { cmd: 'mirror.changes', ...location }, 'fetch again', shown && ((p) => shown(p.done, p.total, p.units)));
  } catch (err) {
    // The stamps are a shortcut: without them a full pull still fetches, as before G5.
    warn(`adtplus: no change stamps (${err instanceof Error ? err.message : String(err)}); reading everything`);
  }
  for (const f of stamps?.failed ?? []) warn(`adtplus: no change stamp for ${f.key}: ${f.message}`);
  // A move to another package changes no date: the package is part of the stamp.
  const now: Stamps | undefined =
    stamps &&
    Object.fromEntries(Object.entries(stamps.stamps).map(([key, at]) => [key, at === null ? null : `${stamps.packages[key] ?? ''} ${at}`]));
  // What a complete pull keeps: a stamp check over the ceiling vouches for nothing.
  const kept = now && !stamps!.exceeded ? now : undefined;
  const manifest = await loadManifest(root);
  const mirrored = Object.keys(manifest?.objects ?? {}).filter((id) => parseId(id));
  const forced = (await git.config('adtplus.fullFetch')) === 'true';
  const previous = await readStamps(root);
  let plan: FetchPlan =
    !stamps || !now
      ? { full: 'no change stamps' }
      : forced
        ? { full: 'adtplus.fullFetch is set' }
        : manifest?.pull
          ? { full: 'a pull stopped before it finished' }
          : planFetch(previous?.stamps, now, mirrored, stamps.exceeded, stamps.uris);
  // Objects a pull couldn't reach without a stamp: not tried again until a full pull.
  const unreachable = new Set('objects' in plan ? (previous?.unreachable ?? []) : []);
  if ('objects' in plan) plan = { ...plan, bestEffort: plan.bestEffort.filter((id) => !unreachable.has(id)) };

  const pulls: PullResult[] = [];
  if ('objects' in plan) {
    const unstamped =
      (plan.bestEffort.length > 0 ? `; ${plan.bestEffort.length} without a stamp re-read too` : '') +
      (unreachable.size > 0 ? `; ${unreachable.size} left until a full fetch` : '');
    deps.say(
      `adtplus: ${plan.objects.length} object(s) changed since the last fetch (${Object.keys(now!).length} objects checked, ${stamps!.units} units)${unstamped}`,
    );
    // Called with nothing to re-read too: the daemon still answers `fallback` after an adt-ls upgrade.
    const pulled = await call<PullResult>(deps, { cmd: 'mirror.pull', ...location, objects: plan.objects, bestEffort: plan.bestEffort });
    if (plan.objects.length + plan.bestEffort.length > 0) reportPull(deps, pulled, true);
    pulls.push(pulled);
    if (pulled.skipped?.length) {
      for (const s of pulled.skipped) unreachable.add(s.object);
      const first = pulled.skipped[0]!;
      warn(
        `adtplus: ${pulled.skipped.length} object(s) without a stamp couldn't be re-read here (${first.object}: ${first.message}); ` +
          'a full fetch refreshes them: git -c adtplus.fullFetch=true fetch',
      );
    }
    if (pulled.fallback) plan = { full: pulled.fallback };
  }
  if ('full' in plan) {
    deps.say(`adtplus: reading all of ${address.name} (${plan.full})…`);
    const reread = await startOrResume(root, manifest?.pull !== undefined, previous, kept, mirrored, stamps?.uris);
    const pulled = await watchProgress(deps, root, () =>
      call<PullResult>(deps, { cmd: 'mirror.pull', ...location, ...(reread ? { reread } : {}) }),
    );
    if (pulled.missing.length > 0) throw new Error(`package ${pulled.missing.join(', ')} not found on ${address.system}`);
    reportPull(deps, pulled);
    pulls.push(pulled);
  }
  if (kept) await keepStamps(root, kept, pulls, 'full' in plan ? [] : [...unreachable].sort());
}

/**
 * Before a full pull: a new one keeps the stamps taken now as `pending`; a resumed one reads again
 * what changed since stamps taken before it began (every object when there are none, or a change
 * can't be pinned to objects), since the stamps kept after it vouch for all it skipped. No stamps kept after the pull
 * (`kept` absent): the resume may trust what the stopped pull read, the next fetch checks it.
 */
async function startOrResume(
  root: string,
  resuming: boolean,
  previous: StampsFile | undefined,
  kept: Stamps | undefined,
  mirrored: string[],
  uris: Record<string, string> | undefined,
): Promise<string[] | undefined> {
  if (!resuming) {
    const { pending: _, ...rest } = previous ?? {};
    if (kept || previous?.pending) await writeStamps(root, { ...rest, ...(kept ? { pending: kept } : {}) });
    return undefined;
  }
  if (!kept) return undefined;
  // Any stamps taken before the stopped pull began will do: `pending`, else the last complete
  // pull's (a pull a push started for its re-read writes no `pending`).
  const since = previous?.pending ?? previous?.stamps;
  const plan = since && planFetch(since, kept, mirrored, false, uris);
  return plan && 'objects' in plan ? [...plan.objects, ...plan.bestEffort] : mirrored;
}

/** `12 s`, `4 min`, `2.5 h`. */
/**
 * Run a full pull and show its progress from the shadow manifest's `pull` record, which the pull
 * saves as it goes (G5b): objects read of all, units, and the time left at the rate seen so far
 * (a resumed pull's earlier objects don't count toward the rate).
 */
async function watchProgress<T>(deps: FetchDeps, root: string, run: () => Promise<T>): Promise<T> {
  const show = deps.progress;
  if (!show) return run();
  const file = path.join(root, '.adtplus', 'mirror.json');
  const step = meter(show, 'reading objects');
  const poll = async () => {
    let p: { total?: number; done?: number; units?: number } | undefined;
    try {
      p = (JSON.parse(await readFile(file, 'utf8')) as { pull?: typeof p }).pull;
    } catch {
      return; // Mid-rename or not written yet: the next poll sees it.
    }
    if (!p?.total || p.done === undefined) return;
    step(p.done, p.total, p.units ?? 0);
  };
  const timer = setInterval(() => void poll(), deps.progressMs ?? 2000);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Keep the stamps for what the pulls read. A file that didn't read clears its object's stamp, so
 * the next fetch reads it again; anything the stamps can't pin to an object (an unlisted folder,
 * a collision, files kept or in conflict, more errors than listed) drops them all: the next fetch
 * is a full one.
 */
async function keepStamps(root: string, now: Stamps, pulls: PullResult[], unreachable: string[]): Promise<void> {
  const unsure = pulls.some(
    (p) =>
      p.unreadable.length > 0 ||
      p.collisions.count > 0 ||
      p.goneKept.count > 0 ||
      p.conflicts.count > 0 ||
      p.keptLocal.count > 0 ||
      p.errors.length >= PULL_LISTED,
  );
  if (unsure) {
    await rm(path.join(root, 'stamps.json'), { force: true });
    return;
  }
  const keyOf = idsOfKeys(Object.keys(now));
  const kept = { ...now };
  for (const e of pulls.flatMap((p) => p.errors)) {
    const key = keyOf.get(objectOfPath(e.path));
    if (key !== undefined) kept[key] = null;
  }
  await writeStamps(root, { stamps: kept, ...(unreachable.length > 0 ? { unreachable } : {}) });
}

/** Every file under the shadow's `src/`, by repository path (`src/…`), sorted; no `.remote` conflict copies. */
async function shadowPaths(root: string): Promise<string[]> {
  return (await filesBelow(root, SRC_DIR)).filter((p) => !p.endsWith(REMOTE_SUFFIX)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export { objectOfPath };

function listLine(label: string, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const shown = ids.slice(0, MAX_LISTED).join(', ');
  return [`${label}: ${shown}${ids.length > MAX_LISTED ? `, … and ${ids.length - MAX_LISTED} more` : ''}`];
}

/** The sync commit's message: subject, then the objects new, changed and gone since the tip. */
export function syncMessage(
  address: GitAddress,
  at: Date,
  tipPaths: string[] | undefined,
  shadowPaths: string[],
  changed: string[],
): string {
  const subject = `${address.system.toUpperCase()}: ${address.name} at ${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  if (tipPaths === undefined) {
    const objects = new Set(shadowPaths.map(objectOfPath)).size;
    return `${subject}\n\n${objects} objects, ${shadowPaths.length} files.\n`;
  }
  const inTip = new Set(tipPaths.map(objectOfPath));
  const inShadow = new Set(shadowPaths.map(objectOfPath));
  const touched = [...new Set(changed.map(objectOfPath))].sort();
  const body = [
    ...listLine('New', touched.filter((id) => !inTip.has(id))),
    ...listLine('Changed', touched.filter((id) => inTip.has(id) && inShadow.has(id))),
    ...listLine('Gone', touched.filter((id) => !inShadow.has(id))),
  ];
  return `${subject}\n\n${body.join('\n')}\n`;
}

/** Show a history read's progress from its index, which the daemon saves as it goes. */
function watchHistory<T>(deps: FetchDeps, root: string, total: number, run: () => Promise<T>): Promise<T> {
  const show = deps.progress;
  if (!show || total === 0) return run();
  const file = path.join(root, HISTORY_DIR, 'index.json');
  let seen = -1;
  const poll = async () => {
    let done: number;
    try {
      done = ((JSON.parse(await readFile(file, 'utf8')) as { done?: unknown[] }).done ?? []).length;
    } catch {
      return; // Not written yet, or mid-rename.
    }
    if (done === seen) return;
    seen = done;
    show(`adtplus: reading versions: ${Math.floor((100 * Math.min(done, total)) / total)}% (${Math.min(done, total)}/${total})`);
  };
  const timer = setInterval(() => void poll(), deps.progressMs ?? 2000);
  return run().finally(() => clearInterval(timer));
}

/** Run one `import`: pull the shadow, and answer with the stream git feeds to fast-import. */
export async function fetchStream(deps: FetchDeps): Promise<Buffer[]> {
  const { address, git } = deps;
  const { root, workspace } = shadowOf(deps.gitDir, deps.remote);
  const at = (deps.now ?? (() => new Date()))();
  const max = await maxObjects(git);
  const history = await historySettings(git, at);
  await ensureShadow(deps, root, workspace, max);
  // From here until the stream is answered the shadow may be ahead of the private ref.
  await writeState(root, { stale: true });
  await bringShadowUpToDate(deps, root, workspace, max);

  const ref = privateRef(deps.remote);
  const tip = await git.revParse(`${ref}^0`);
  const tipFiles = tip ? await git.lsTree(tip, SRC_DIR) : undefined;
  let transports: TransportCommits = { commits: [], tree: new Map(tipFiles ?? []) };
  if (history.mode === 'transports') {
    transports = await transportCommits(
      {
        call: (req) => call(deps, req as DaemonRequest),
        git,
        system: address.system,
        root,
        workspace,
        say: deps.say,
        warn: deps.warn ?? deps.say,
        watch: (total, run) => watchHistory(deps, root, total, run),
        now: at,
      },
      history,
      (await loadManifest(root))!,
      ref,
      tip,
      tipFiles,
    );
  }
  const { commits, tree } = transports;
  // What the sync commit compares with: the tip, or what the transport commits left.
  const base = tip || commits.length > 0 ? tree : undefined;
  const paths = await shadowPaths(root);
  const files = new Set(paths);

  // Only changed files are kept in memory.
  const changes: FileChange[] = [];
  for (const p of paths) {
    const data = await readFile(path.join(root, p));
    if (base?.get(p) !== blobSha(data)) changes.push({ op: 'M', path: p, data });
  }
  for (const p of base?.keys() ?? []) if (!files.has(p)) changes.push({ op: 'D', path: p });
  if (tip && commits.length === 0 && changes.length === 0) {
    await writeState(root, { matches: tip });
    deps.say(`adtplus: ${address.system} unchanged since the last fetch`);
    return importStream(undefined);
  }

  if (commits.length > 0) deps.say(`adtplus: ${commits.length} transport commit(s)`);
  if (changes.length > 0 || !base) {
    commits.push({
      ref,
      ...(tip ? { from: tip } : {}),
      author: ident(address.system.toUpperCase(), `adtplus@${address.system.toLowerCase()}.invalid`, at),
      message: syncMessage(address, at, base && [...base.keys()], paths, changes.map((c) => c.path)),
      changes,
    });
  }
  await writeState(root, { fetched: { ...(tip ? { parent: tip } : {}), subjects: commits.map((c) => c.message.split('\n')[0]!) } });
  return importStream(commits);
}
