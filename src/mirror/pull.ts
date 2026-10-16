import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { endsLoop, type RawAdtClient } from '../backends/rawadt.js';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { ThrottledError, unitsOf } from '../daemon/ratelimit.js';
import { AFF_EDITORCONFIG } from './editorconfig.js';
import { REMOTE_SUFFIX, isMirrorablePackage, isReadOnlyFile, isSafeSegment, parseId, resolveRoot, safeTarget } from './layout.js';
import {
  emptyManifest,
  loadManifest,
  newPullId,
  saveManifest,
  type ManifestFileEntry,
} from './manifest.js';
import { objectPlacement } from '../core/placement.js';
import { adtLsChange } from './files.js';
import { MSAG_TYPE, asMessageClass, msagFileName, readMsag, replacedStub } from './msag.js';
import { contentHash, toLocal } from './normalize.js';
import { readLocal } from './scan.js';
import { locatePackage, walk, type WalkedObject } from './walk.js';

/**
 * `mirror init` and `mirror pull` (docs/decisions/007-mirror-mode.md, "Pull"
 * and "Local layout" for line endings). The daemon passes in the system's adt-ls client
 * and rate limiter; everything else here is local files.
 */

export const DEFAULT_MAX_OBJECTS = 500;
/** A pull saves its manifest every this many objects, or after SAVE_MS (G5b). */
export const SAVE_EVERY = 25;
export const SAVE_MS = 3000;
/** Paths listed per result list; the rest only counted. */
export const MAX_LISTED = 50;

export interface MirrorDeps {
  /** The system's adt-ls client, its calls in the rate limit's bulk lane (ADR-008). */
  adt: AdtLsClient;
  /** The bulk lane's adt-ls calls in flight: objects a pull reads at once. */
  concurrency: number;
  /** Runs `fn` holding the object shared (`daemon/objectlock.ts`). */
  hold: <T>(ref: Pick<ObjectRef, 'name' | 'objectType'>, fn: () => Promise<T>) => Promise<T>;
  /** The adt-ls version the session runs, recorded in the manifest. */
  adtLsVersion?: string;
  /**
   * The system's REST session, for message classes (ADR-014). Without it a message class stays
   * adt-ls's `.msagn.jsonc` stub.
   */
  withRest?: <T>(fn: (rest: RawAdtClient) => Promise<T>) => Promise<T>;
}

/** The mirror policy of the system (`systems.json` `mirror`). */
export interface MirrorPolicy {
  maxObjects?: number;
  namespaces?: string[];
}

export interface MirrorLocation {
  /** Absolute path of the mirror root. */
  root: string;
  /** The client's workspace folders: the root must lie inside one. */
  workspaceFolders: string[];
}

/** A list capped at `MAX_LISTED` paths, with the full count. */
export interface Listed {
  count: number;
  paths: string[];
}

/** `paths` sorted and capped at `MAX_LISTED`, with the full count. */
export function listed(paths: string[]): Listed {
  return { count: paths.length, paths: [...paths].sort().slice(0, MAX_LISTED) };
}

/**
 * The SDK client with every namespaced call counted, in calls and in units (ADR-008); `charge`
 * counts a call made outside it (a REST read of a message class) with its requests.
 */
export function counting(adt: AdtLsClient): { adt: AdtLsClient; calls: () => number; units: () => number; charge: (units: number) => void } {
  let calls = 0;
  let units = 0;
  const proxied = new Proxy(adt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!value || typeof value !== 'object') return value;
      return new Proxy(value, {
        get(ns, key) {
          const member = Reflect.get(ns, key, ns);
          return typeof member === 'function'
            ? (...args: unknown[]) => {
                calls += 1;
                units += unitsOf(prop, key, args);
                return member.apply(ns, args);
              }
            : member;
        },
      });
    },
  });
  const charge = (n: number) => {
    calls += 1;
    units += n;
  };
  return { adt: proxied, calls: () => calls, units: () => units, charge };
}

function assertMirrorable(name: string, policy: MirrorPolicy): void {
  if (!isMirrorablePackage(name, policy.namespaces)) {
    throw new Error(
      `package ${name} can't be mirrored: a mirror's root package starts with Z, Y or $, ` +
        `or with a namespace listed in the system's mirror.namespaces`,
    );
  }
}

// --- init -----------------------------------------------------------

export interface InitInput extends MirrorLocation {
  system: string;
  package: string;
  /** Pull subpackages too. Default true. */
  subpackages?: boolean;
}

export interface InitResult {
  root: string;
  system: string;
  packages: Array<{ name: string; subpackages: boolean }>;
  /** The package was already a root package of this mirror. */
  alreadyListed: boolean;
  /** The system knows the package. */
  found: boolean;
  editorconfig: 'written' | 'kept';
  note?: string;
}

export async function init(deps: MirrorDeps, policy: MirrorPolicy, input: InitInput): Promise<InitResult> {
  const name = input.package.toUpperCase();
  assertMirrorable(name, policy);
  const root = await resolveRoot(input.root, input.workspaceFolders, { create: true });
  const manifest = (await loadManifest(root)) ?? emptyManifest(input.system);
  if (manifest.system !== input.system) {
    throw new Error(`${root} already mirrors system "${manifest.system}"; one mirror root serves one system`);
  }
  const found = (await locatePackage(deps.adt, name)) !== undefined;
  const subpackages = input.subpackages ?? true;
  const existing = manifest.packages.find((p) => p.name === name);
  if (existing) existing.subpackages = subpackages;
  else manifest.packages.push({ name, subpackages });
  manifest.packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  await saveManifest(root, manifest);

  const editorconfigPath = await safeTarget(root, '.editorconfig');
  let editorconfig: InitResult['editorconfig'] = 'kept';
  try {
    await writeFile(editorconfigPath, AFF_EDITORCONFIG, { flag: 'wx' });
    editorconfig = 'written';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return {
    root,
    system: manifest.system,
    packages: manifest.packages,
    alreadyListed: existing !== undefined,
    found,
    editorconfig,
    ...(found ? {} : { note: `package ${name} not found on ${input.system}; a pull finds nothing until it exists` }),
  };
}

// --- pull -----------------------------------------------------------

export interface PullInput extends MirrorLocation {
  system: string;
  /** Overrides `mirror.maxObjects` for this call. */
  maxObjects?: number;
  /**
   * Re-read only these objects of the manifest (`CLAS ZCL_X`), each found by name, without the
   * walk: what changed since the last pull (`mirror/changes.ts`). New and gone objects need a
   * full pull; so does an object moved to another package, which ends the call with `fallback`.
   */
  objects?: string[];
  /**
   * With `objects`: more objects to re-read, best effort. One that can't be found by name or
   * listed is skipped (`skipped`), not a reason for `fallback` (objects without a change stamp,
   * G5b).
   */
  bestEffort?: string[];
  /**
   * Without `objects`: objects a resumed pull reads again although the interrupted pull read them
   * (changed since it started).
   */
  reread?: string[];
}

export interface PullResult {
  root: string;
  system: string;
  packages: string[];
  objects: number;
  files: number;
  /** Files written from the system (new, or changed there and not locally). */
  written: Listed;
  /** Changed locally, not on the system: left as they are. */
  keptLocal: Listed;
  /** Changed on both sides: the system's version is in `<file>.remote`. */
  conflicts: Listed;
  /** Gone on the system and unchanged locally: deleted. */
  deleted: Listed;
  /** Gone on the system but changed locally: kept. */
  goneKept: Listed;
  /** Missing from the package listing but found by name on the system: kept as they are. */
  notListed: Listed;
  /** Objects whose files map to the same local file: none of them written. */
  collisions: Listed;
  errors: Array<{ path: string; message: string }>;
  /** Folders adt-ls failed to list; nothing below them counts as gone. */
  unreadable: Array<{ path: string; message: string }>;
  /** Root packages the system doesn't know. */
  missing: string[];
  /** Objects already read by the interrupted pull this one finished. */
  resumed: number;
  /** With `objects`: why a full pull is due instead (an object gone, moved or not in the manifest). Nothing after it was read. */
  fallback?: string;
  /** With `bestEffort`: objects that weren't re-read, and why. */
  skipped?: Array<{ object: string; message: string }>;
  /** adt+ calls made. */
  calls: number;
  /** Their estimated backend requests: what the rate limit counts (ADR-008). */
  units: number;
  ms: number;
}

/** The outcome of one file on a pull. */
export type FileOutcome = 'written' | 'unchanged' | 'keptLocal' | 'conflict' | 'error';

/** Write a mirror file; read-only kinds are made writable only for the moment of the write. */
async function writeMirrorFile(path: string, text: string, readOnly: boolean): Promise<void> {
  if (readOnly) await chmod(path, 0o644).catch(() => undefined);
  await writeFile(path, toLocal(text));
  if (readOnly) await chmod(path, 0o444);
}

/**
 * The re-pull rule for one file (B = base, R = remote, L = local, all
 * normalized hashes): R = B leaves the file; L = B takes R; L = R only moves
 * the base; L ≠ B ≠ R writes `<file>.remote` and keeps the base. A file new to
 * the manifest counts as unchanged locally when there is no local file.
 */
async function applyRemote(
  root: string,
  rel: string,
  entry: ManifestFileEntry,
  remote: string,
): Promise<FileOutcome> {
  const R = contentHash(remote);
  const B = entry.hash;
  if (R === B) return 'unchanged';
  const target = await safeTarget(root, rel, { mkdir: true });
  const local = await readLocal(target);
  const L = local === undefined ? undefined : contentHash(local);
  const localUnchanged = B === undefined ? local === undefined : L === B;
  if (localUnchanged) {
    await writeMirrorFile(target, remote, entry.readOnly === true);
    entry.hash = R;
    return 'written';
  }
  if (L === R) {
    entry.hash = R;
    return 'unchanged';
  }
  const remoteTarget = await safeTarget(root, rel + REMOTE_SUFFIX, { mkdir: true });
  await writeMirrorFile(remoteTarget, remote, false);
  return 'conflict';
}

/**
 * Types whose drafts `listInactive()` names under the object itself: a class include's as
 * `CLAS/OCN/<include>` with the class's name, a method's as `CLAS/OM` (P11, `onprem`). Others, such as a
 * function group, whose function modules are listed under their own names, are stat'ed file by file.
 */
const LISTED_DRAFT_TYPES = new Set(['CLAS', 'PROG', 'INTF', 'DDLS', 'BDEF', 'TABL', 'SRVD']);

/** `CLAS ZCL_X` for an entry of `listInactive()`: names come padded, `ZCL_X<spaces>METHOD`. */
function inactiveKey(type: string, name: string): string {
  return `${type.split('/')[0]} ${name.trim().split(/\s+/)[0]!.toUpperCase()}`;
}

/**
 * Whether an object's files need an `abapStat` for their draft flags: one `listInactive()` for the
 * whole pull instead of one `abapStat` per file (P11: 39% of a clone's adt-ls calls). An object of
 * `LISTED_DRAFT_TYPES` the list doesn't name has no draft. If the list fails, every file is stat'ed.
 * The list is read on the first call, so a pull that reads nothing doesn't send it.
 */
function draftCheck(adt: AdtLsClient): (type: string, name: string) => Promise<boolean> {
  let listed: Promise<Set<string> | undefined> | undefined;
  return async (type, name) => {
    const group = type.split('/')[0]!;
    if (!LISTED_DRAFT_TYPES.has(group)) return true;
    listed ??= adt.repository.listInactive().then(
      (entries) => new Set((entries as Array<{ type: string; name: string }>).map((e) => inactiveKey(e.type, e.name))),
      (err: unknown) => {
        if (err instanceof ThrottledError) throw err;
        return undefined;
      },
    );
    const keys = await listed;
    return !keys || keys.has(`${group} ${name.toUpperCase()}`);
  };
}

/**
 * Read one file of an object from the system and take it under the re-pull
 * rule (`applyRemote`), with its draft flag from `abapStat`, or none when
 * `stat` is false (the object has no draft). `entries` is the object's
 * manifest entry, updated in place; a failed read leaves the message in the
 * file's `error`. Pull's step per file, and push's re-read of a created
 * object after its activation.
 */
export async function takeFile(
  adt: AdtLsClient,
  root: string,
  dir: string,
  folderUri: string,
  name: string,
  entries: Record<string, ManifestFileEntry>,
  stat = true,
): Promise<FileOutcome> {
  const rel = `${dir}/${name}`;
  const entry: ManifestFileEntry = { ...(entries[name] ?? {}) };
  entries[name] = entry;
  if (isReadOnlyFile(name)) entry.readOnly = true;
  delete entry.error;
  const uri = folderUri + encodeURIComponent(name);
  let result: FileOutcome;
  try {
    const text = await adt.repository.readFile(uri);
    result = await applyRemote(root, rel, entry, text);
    delete entry.draft;
    // Stubs have no version: adt-ls answers "abapStat returned no version" for them.
    if (stat && !name.endsWith('.jsonc')) {
      const version = await adt.repository.abapStat(uri).catch((err: unknown) => {
        if (err instanceof ThrottledError) throw err;
        return undefined;
      });
      if (version === 'inactive') entry.draft = true;
    }
  } catch (err) {
    if (err instanceof ThrottledError) throw err;
    entry.error = err instanceof Error ? err.message : String(err);
    return 'error';
  }
  if (result === 'unchanged' && entry.hash !== undefined) {
    const local = await readLocal(await safeTarget(root, rel));
    if (local !== undefined && contentHash(local) !== entry.hash) return 'keptLocal';
  }
  return result;
}

/**
 * A message class's `.msag.json` under the re-pull rule (ADR-014), from `read`, which gives the
 * system's rendering or throws. No draft flag: a message class has no inactive version.
 */
export async function takeMessageClass(
  root: string,
  dir: string,
  name: string,
  entries: Record<string, ManifestFileEntry>,
  read: () => Promise<string>,
): Promise<FileOutcome> {
  const file = msagFileName(name);
  const rel = `${dir}/${file}`;
  const entry: ManifestFileEntry = { ...(entries[file] ?? {}) };
  entries[file] = entry;
  delete entry.error;
  delete entry.draft;
  let result: FileOutcome;
  try {
    result = await applyRemote(root, rel, entry, await read());
  } catch (err) {
    if (err instanceof ThrottledError || endsLoop(err)) throw err;
    entry.error = err instanceof Error ? err.message : String(err);
    return 'error';
  }
  if (result === 'unchanged' && entry.hash !== undefined) {
    const local = await readLocal(await safeTarget(root, rel));
    if (local !== undefined && contentHash(local) !== entry.hash) return 'keptLocal';
  }
  return result;
}

/** A message class's rendering over REST, its requests charged; throws when the class is gone. */
function msagReader(deps: MirrorDeps, charge: (units: number) => void, name: string): () => Promise<string> {
  return async () => {
    const read = await deps.withRest!((rest) => readMsag(rest, name));
    charge(read?.requests ?? 1);
    if (!read) throw new Error(`message class ${name} not found`);
    return read.text;
  };
}

/** Delete a file gone on the system if it is unchanged locally; true when it was deleted (or already gone). */
async function removeIfUnchanged(root: string, rel: string, entry: ManifestFileEntry): Promise<boolean> {
  const target = await safeTarget(root, rel);
  const local = await readLocal(target);
  if (local === undefined) return true;
  if (entry.hash === undefined || contentHash(local) !== entry.hash) return false;
  await rm(target, { force: true });
  return true;
}

/** What a pull did to files, by kind. */
interface FileOutcomes {
  written: string[];
  keptLocal: string[];
  conflicts: string[];
  deleted: string[];
  goneKept: string[];
  errors: PullResult['errors'];
}

/** Files of an object that the system no longer has: deleted when unchanged locally, else kept and reported. */
async function dropGone(
  root: string,
  dir: string,
  entries: Record<string, ManifestFileEntry>,
  names: string[],
  outcome: Pick<FileOutcomes, 'deleted' | 'goneKept'>,
): Promise<void> {
  for (const name of names) {
    const rel = `${dir}/${name}`;
    if (await removeIfUnchanged(root, rel, entries[name]!)) {
      delete entries[name];
      outcome.deleted.push(rel);
    } else {
      outcome.goneKept.push(rel);
    }
  }
}

/**
 * Read one object's files from its repotree folder under the re-pull rule, holding it shared, and
 * drop the files it had and no longer has (deleted when unchanged, else kept). `entries` is its
 * manifest entry, updated in place; `hasDraft` says whether its files need an `abapStat`; with
 * `pullId` each file read is marked for a resume. The full pull's step per object and the step of
 * a pull of named objects.
 */
async function readObject(
  adt: AdtLsClient,
  deps: MirrorDeps,
  root: string,
  o: { name: string; type: string; dir: string; uri: string; files: string[] },
  entries: Record<string, ManifestFileEntry>,
  outcome: FileOutcomes,
  hasDraft: (type: string, name: string) => Promise<boolean>,
  pullId?: string,
  /** A message class's rendering (ADR-014): its one file is taken from this, not from adt-ls. */
  msag?: () => Promise<string>,
): Promise<number> {
  const stat = msag ? false : await hasDraft(o.type, o.name);
  // The lock key is the main type: `DTELDE` and `DTEL` must hold the same object.
  await deps.hold({ name: o.name, objectType: o.type.slice(0, 4) }, async () => {
    for (const f of o.files) {
      const rel = `${o.dir}/${f}`;
      const result = msag
        ? await takeMessageClass(root, o.dir, o.name, entries, msag)
        : await takeFile(adt, root, o.dir, o.uri, f, entries, stat);
      if (result === 'written') outcome.written.push(rel);
      else if (result === 'conflict') outcome.conflicts.push(rel);
      else if (result === 'keptLocal') outcome.keptLocal.push(rel);
      else if (result === 'error') outcome.errors.push({ path: rel, message: entries[f]!.error! });
      if (pullId) entries[f]!.pull = pullId;
    }
  });
  await dropGone(root, o.dir, entries, Object.keys(entries).filter((f) => !o.files.includes(f)), outcome);
  return o.files.length;
}

export async function pull(deps: MirrorDeps, policy: MirrorPolicy, input: PullInput): Promise<PullResult> {
  if (input.objects || input.bestEffort) return pullObjects(deps, policy, { ...input, objects: input.objects ?? [] });
  const started = Date.now();
  const { adt, calls, units, charge } = counting(deps.adt);
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) {
    throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  }
  if (manifest.packages.length === 0) throw new Error(`the mirror at ${root} names no package; run \`mirror init\``);
  for (const p of manifest.packages) assertMirrorable(p.name, policy);

  const maxObjects = input.maxObjects ?? policy.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const workers = Math.max(1, deps.concurrency);

  const walked = await walk(adt, manifest.packages, { maxObjects, concurrency: workers });
  if (walked.exceeded) {
    throw new Error(
      `the mirror would hold more than ${maxObjects} objects; pass a higher --max-objects ` +
        `(or raise mirror.maxObjects) to pull it`,
    );
  }
  // Message classes are read over REST as `.msag.json` instead of adt-ls's stub (ADR-014).
  if (deps.withRest) walked.objects = walked.objects.map(asMessageClass);

  // Two objects writing the same local file (case-insensitively, as on macOS): neither is written.
  const owners = new Map<string, Set<string>>();
  for (const o of walked.objects) {
    for (const f of o.files) {
      const key = `${o.dir}/${f}`.toLowerCase();
      (owners.get(key) ?? owners.set(key, new Set()).get(key)!).add(o.id);
    }
  }
  const colliding = new Set<string>();
  const collisionPaths: string[] = [];
  for (const [key, ids] of owners) {
    if (ids.size < 2) continue;
    for (const id of ids) colliding.add(id);
    collisionPaths.push(`${key} (${[...ids].join(', ')})`);
  }
  // Two objects with one manifest key would overwrite each other's entry: treated the same way.
  const seen = new Set<string>();
  for (const o of walked.objects) {
    if (seen.has(o.id)) {
      colliding.add(o.id);
      collisionPaths.push(`${o.dir} (${o.id} twice)`);
    }
    seen.add(o.id);
  }

  const reread = new Set(input.reread ?? []);
  const pullId = manifest.pull?.id ?? newPullId();
  manifest.pull ??= { id: pullId, startedAt: new Date(started).toISOString() };
  const queue = walked.objects.filter((o) => !colliding.has(o.id));
  // The workers shift from `queue`: its length now is the total.
  const total = queue.length;
  let done = 0;
  let saving = Promise.resolve();
  /** Save with the progress so far: objects done of the queue, units spent. */
  const save = () => {
    if (manifest.pull) Object.assign(manifest.pull, { total, done, units: units(), updatedAt: new Date().toISOString() });
    return (saving = saving.then(() => saveManifest(root, manifest)));
  };
  // A whole rewrite of the manifest per object grows quadratic with the mirror's size (G5b):
  // save every SAVE_EVERY objects or SAVE_MS. A stop saves what was read; a crash loses at most that much.
  let unsaved = 0;
  let savedAt = Date.now();
  const saveSoon = () => {
    unsaved += 1;
    if (unsaved < SAVE_EVERY && Date.now() - savedAt < SAVE_MS) return saving;
    unsaved = 0;
    savedAt = Date.now();
    return save();
  };
  await save();

  const outcome = {
    written: [] as string[],
    keptLocal: [] as string[],
    conflicts: [] as string[],
    deleted: [] as string[],
    goneKept: [] as string[],
    notListed: [] as string[],
    errors: [] as PullResult['errors'],
  };
  let resumed = 0;
  let files = 0;
  const hasDraft = draftCheck(adt);

  async function pullObject(o: WalkedObject): Promise<void> {
    const previous = manifest!.objects[o.id];
    const moved = previous !== undefined && previous.dir !== o.dir;
    if (previous && !moved && !reread.has(o.id) && o.files.every((f) => previous.files[f]?.pull === pullId)) {
      resumed += 1;
      done += 1;
      files += o.files.length;
      return;
    }
    const entries: Record<string, ManifestFileEntry> = moved ? {} : { ...(previous?.files ?? {}) };
    // Not `files += await …`: that reads `files` before the await, and concurrent workers would lose counts.
    const msag = o.type === MSAG_TYPE && deps.withRest ? msagReader(deps, charge, o.name) : undefined;
    const read = await readObject(adt, deps, root, o, entries, outcome, hasDraft, pullId, msag);
    files += read;
    // Moved to another package: the old place is kept under its own key, and the
    // gone check below deletes what is unchanged there.
    if (moved) manifest!.objects[`${o.id} (was ${previous!.package})`] = previous!;
    // A push's object still waiting for activation stays waiting: the next push or `mirror activate` takes
    // it, and reads a created one back after activating it.
    const waiting =
      !moved && previous?.unactivated ? { unactivated: true as const, ...(previous.created ? { created: true as const } : {}) } : {};
    manifest!.objects[o.id] = { package: o.package, dir: o.dir, files: entries, ...waiting };
    done += 1;
    await saveSoon();
  }

  /**
   * Whether an object the listing doesn't show still exists: `onprem` leaves a view that was never
   * activated out of its package's listing (M5 live), and a pull took it for deleted and removed
   * its files. Only a name search that finds nothing makes an object gone; any other answer keeps it.
   */
  async function stillOnSystem(id: string): Promise<boolean> {
    const at = id.indexOf(' ');
    if (at <= 0 || id.includes(' (was ')) return false;
    if (id.slice(0, at) === MSAG_TYPE && deps.withRest) {
      const name = id.slice(at + 1);
      return deps.withRest((rest) => readMsag(rest, name)).then(
        (read) => {
          charge(read?.requests ?? 1);
          return read !== undefined;
        },
        (err: unknown) => {
          if (err instanceof ThrottledError || endsLoop(err)) throw err;
          return true;
        },
      );
    }
    try {
      await adt.lifecycle.resolveAffUri({ name: id.slice(at + 1), objectType: id.slice(0, at) });
      return true;
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      return !/not found/i.test(err instanceof Error ? err.message : String(err));
    }
  }

  let stop: unknown;
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      while (stop === undefined) {
        const o = queue.shift();
        if (!o) return;
        try {
          await pullObject(o);
        } catch (err) {
          stop ??= err;
        }
      }
    }),
  );
  if (stop !== undefined) {
    // What was read stays read: the next pull resumes after it.
    await save();
    await saving;
    throw stop;
  }

  // Objects gone on the system. Only after a complete walk: an unreadable folder hides objects, it doesn't delete them.
  if (walked.unreadable.length === 0 && walked.missing.length === 0) {
    const live = new Set(walked.objects.map((o) => o.id));
    for (const [id, obj] of Object.entries(manifest.objects)) {
      if (live.has(id)) continue;
      // A stub a `.msag.json` replaced (ADR-014): gone from the mirror, not from the system.
      const replaced = replacedStub(id);
      if ((replaced === undefined || !live.has(replaced)) && (await stillOnSystem(id))) {
        outcome.notListed.push(id);
        continue;
      }
      const entries = { ...obj.files };
      await dropGone(root, obj.dir, entries, Object.keys(entries), outcome);
      if (Object.keys(entries).length === 0) delete manifest.objects[id];
      else manifest.objects[id] = { ...obj, files: entries };
    }
  }

  for (const obj of Object.values(manifest.objects)) {
    for (const entry of Object.values(obj.files)) delete entry.pull;
  }
  delete manifest.pull;
  if (deps.adtLsVersion) manifest.adtLs = deps.adtLsVersion;
  await save();
  await saving;

  return {
    root,
    system: manifest.system,
    packages: walked.packages,
    objects: walked.objects.length - colliding.size,
    files,
    written: listed(outcome.written),
    keptLocal: listed(outcome.keptLocal),
    conflicts: listed(outcome.conflicts),
    deleted: listed(outcome.deleted),
    goneKept: listed(outcome.goneKept),
    notListed: listed(outcome.notListed),
    collisions: listed(collisionPaths),
    errors: outcome.errors.slice(0, MAX_LISTED),
    unreadable: walked.unreadable.slice(0, MAX_LISTED),
    missing: walked.missing,
    resumed,
    calls: calls(),
    units: units(),
    ms: Date.now() - started,
  };
}

/** `pull` of named objects only: each resolved by name, its folder listed and read under the re-pull rule. */
async function pullObjects(deps: MirrorDeps, policy: MirrorPolicy, input: PullInput & { objects: string[] }): Promise<PullResult> {
  const started = Date.now();
  const { adt, calls, units, charge } = counting(deps.adt);
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) {
    throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  }
  for (const p of manifest.packages) assertMirrorable(p.name, policy);
  const outcome: FileOutcomes = { written: [], keptLocal: [], conflicts: [], deleted: [], goneKept: [], errors: [] };
  let files = 0;
  let objects = 0;
  let fallback: string | undefined = manifest.pull ? 'a pull stopped before it finished' : undefined;
  // Unchanged objects keep the files an older adt-ls served: after an upgrade only a full pull re-reads them all.
  const adtLs = adtLsChange(manifest.adtLs, deps.adtLsVersion);
  if (adtLs) fallback ??= `adt-ls changed since the last pull (${adtLs.pulled} → ${adtLs.running})`;
  // Only a full pull replaces a message class's stub with its `.msag.json` (ADR-014).
  // A stub kept because it changed locally sits next to its `.msag.json`: no reason for a full pull.
  const unreplaced = (id: string) => {
    const by = replacedStub(id);
    return by !== undefined && !manifest.objects[by];
  };
  if (deps.withRest && Object.keys(manifest.objects).some(unreplaced)) {
    fallback ??= 'message classes are pulled as .msag.json now, not as stubs';
  }

  const hasDraft = draftCheck(adt);
  const required = new Set(input.objects);
  const skipped: Array<{ object: string; message: string }> = [];
  try {
    for (const id of [...new Set([...input.objects, ...(input.bestEffort ?? [])])].sort()) {
      if (fallback) break;
      /** Why this object can't be re-read: the end of the call for a changed object, a skip for a best-effort one. */
      const cannot = (message: string): boolean => {
        if (required.has(id)) fallback = message;
        else skipped.push({ object: id, message });
        return required.has(id);
      };
      const object = manifest.objects[id];
      const parsed = parseId(id);
      if (!object || !parsed) {
        if (cannot(`${id} is not in the mirror`)) break;
        continue;
      }
      if (parsed.type === MSAG_TYPE && deps.withRest) {
        // Over REST (ADR-014): adt-ls has only the stub.
        const read = await deps.withRest((rest) => readMsag(rest, parsed.name)).catch((err: unknown) => {
          if (err instanceof ThrottledError || endsLoop(err)) throw err;
          return err instanceof Error ? err : new Error(String(err));
        });
        charge(read instanceof Error ? 1 : (read?.requests ?? 1));
        if (read instanceof Error) {
          if (cannot(`reading ${id} failed: ${read.message}`)) break;
          continue;
        }
        if (!read) {
          if (cannot(`${id} not found on the system`)) break;
          continue;
        }
        if (read.package !== object.package.toUpperCase()) {
          fallback = `${id} is in package ${read.package} on the system, ${object.package} in the mirror`;
          break;
        }
        const entries: Record<string, ManifestFileEntry> = { ...object.files };
        manifest.objects[id] = { ...object, files: entries };
        const o = { name: parsed.name, type: parsed.type, dir: object.dir, uri: '', files: [msagFileName(parsed.name)] };
        files += await readObject(adt, deps, root, o, entries, outcome, hasDraft, undefined, async () => read.text);
        objects += 1;
        if (objects % SAVE_EVERY === 0) await saveManifest(root, manifest);
        continue;
      }
      const ref = { name: parsed.name, objectType: parsed.type };
      let uri: string;
      try {
        uri = await adt.lifecycle.resolveAffUri(ref);
      } catch (err) {
        if (err instanceof ThrottledError) throw err;
        if (cannot(`${id} not found by name: ${err instanceof Error ? err.message : String(err)}`)) break;
        continue;
      }
      // A local object's path names `$TMP`, not its `$` package; the caller compares packages from the search.
      const onSystem = objectPlacement(uri, ref)?.package;
      if (onSystem === undefined) {
        // Not a move: a best-effort object would otherwise make every fetch a full one.
        if (cannot(`${id}: no package in its path ${uri}`)) break;
        continue;
      }
      const local = onSystem === '$TMP' && object.package.startsWith('$');
      if (!local && onSystem.toUpperCase() !== object.package.toUpperCase()) {
        fallback = `${id} is in package ${onSystem} on the system, ${object.package} in the mirror`;
        break;
      }
      const folder = uri.slice(0, uri.lastIndexOf('/') + 1);
      let names: string[];
      try {
        names = (await adt.repository.readDirectory(folder)).filter((c) => c.kind === 'file' && isSafeSegment(c.name)).map((c) => c.name);
      } catch (err) {
        if (err instanceof ThrottledError) throw err;
        if (cannot(`listing ${id} failed: ${err instanceof Error ? err.message : String(err)}`)) break;
        continue;
      }
      // The search index can be stale (`core/resolve.ts`): a folder without the file the search
      // named is no listing to delete files by.
      const main = decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
      if (!names.includes(main)) {
        if (cannot(`${id}: its folder doesn't list ${main} (stale search index?)`)) break;
        continue;
      }
      const entries: Record<string, ManifestFileEntry> = { ...object.files };
      // In the manifest before the read, so a stop saves the files taken so far.
      manifest.objects[id] = { ...object, files: entries };
      const read = await readObject(adt, deps, root, { name: parsed.name, type: parsed.type, dir: object.dir, uri: folder, files: names }, entries, outcome, hasDraft);
      files += read;
      objects += 1;
      if (objects % SAVE_EVERY === 0) await saveManifest(root, manifest);
    }
  } catch (err) {
    // What was taken keeps its new bases, as a stopped full pull's does; a failed save doesn't hide why it stopped.
    await saveManifest(root, manifest).catch(() => undefined);
    throw err;
  }

  const adtLsBefore = manifest.adtLs;
  if (deps.adtLsVersion && !fallback) manifest.adtLs = deps.adtLsVersion;
  // Nothing read (a fetch that only asks for `fallback`): no rewrite of a manifest that may be megabytes.
  if (objects > 0 || manifest.adtLs !== adtLsBefore) await saveManifest(root, manifest);
  const none = listed([]);
  return {
    root,
    system: manifest.system,
    packages: manifest.packages.map((p) => p.name),
    objects,
    files,
    written: listed(outcome.written),
    keptLocal: listed(outcome.keptLocal),
    conflicts: listed(outcome.conflicts),
    deleted: listed(outcome.deleted),
    goneKept: listed(outcome.goneKept),
    notListed: none,
    collisions: none,
    errors: outcome.errors.slice(0, MAX_LISTED),
    unreadable: [],
    missing: [],
    resumed: 0,
    ...(fallback ? { fallback } : {}),
    // Object ids only, so not capped: a caller remembers them (the git helper's `stamps.json`).
    ...(skipped.length > 0 ? { skipped } : {}),
    calls: calls(),
    units: units(),
    ms: Date.now() - started,
  };
}
