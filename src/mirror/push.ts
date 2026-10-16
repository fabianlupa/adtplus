import type { ObjectRef } from '@arc-mcp/adt-ls';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMessageClass, descriptionRefusal, updateMessageClass } from '../capabilities/messageclass.js';
import { CLASS_INCLUDES } from '../capabilities/object.js';
import { assignForNextWrite, isNotInTransport, writeAssigning } from '../capabilities/transport.js';
import { assertObjectWritable, assertPackageWritable } from '../capabilities/policy.js';
import { classRegionProblem } from '../core/class-regions.js';
import type { Destination } from '../core/destinations.js';
import { lookupPackageChain, objectPlacement } from '../core/placement.js';
import { resolveForWrite, type ResolvedObject } from '../core/resolve.js';
import { logonLanguage } from '../core/session.js';
import type { DaemonProgress } from '../daemon/protocol.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { activateTargets, activationComplete, type ActivationResult, type ActivationTarget } from './activate.js';
import { creationInput, folderPackage, groupNew, knownPackage, type CreationInput, type NewObject } from './create.js';
import { adtLsChange } from './files.js';
import { REMOTE_SUFFIX, abapName, affClassFileFor, affName, isReadOnlyFile, parseId, resolveRoot, safeTarget } from './layout.js';
import { loadManifest, saveManifest, type Manifest, type ManifestFileEntry, type ManifestObject } from './manifest.js';
import { MSAG_TYPE, msagChanges, msagFileName, parseMsag, readMsag } from './msag.js';
import { contentHash, lineStyle, toLocal, toSystem } from './normalize.js';
import { readLocal, scanLocal } from './scan.js';
import {
  DEFAULT_MAX_OBJECTS,
  MAX_LISTED,
  counting,
  listed,
  type Listed,
  type MirrorDeps,
  type MirrorLocation,
  type MirrorPolicy,
} from './pull.js';

/**
 * `mirror push` (docs/decisions/007-mirror-mode.md, "Push", also for line
 * endings and the base after a write). Every object goes through the write gate
 * (ADR-003) with the package read off the URI the system resolves, never off
 * the manifest; every changed file is compared with the system before anything
 * of its object is written. A new object is gated on the package its folder
 * names, created, entered in the manifest with the template the system serves
 * as its base, and then written like any other object.
 */

/** What a push writes with, beyond the mirror engine's deps. */
export interface PushDeps extends MirrorDeps {
  destination: Destination;
  /** Waits between retries of a write adt-ls refused as busy; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** One call-log line per write (ADR-007, "Git and the call log"). */
  logWrite?: (
    cmd: 'object.create' | 'object.update' | 'object.activate' | 'transport.assign',
    params: Record<string, unknown>,
    error: string | undefined,
    ms: number,
  ) => void;
  /** Why a command the push would run is refused (`ADTPLUS_DENY`), asked before any write. */
  refusal?: (cmd: 'object.create' | 'object.update') => string | undefined;
  /**
   * Whether a package records changes in transport requests; undefined when it can't be read.
   * Without it, push creates without asking (tests, a system without the REST read).
   */
  recordsChanges?: (pkg: string) => Promise<boolean | undefined>;
  /** Objects written so far, after each one; then the activation. */
  progress?: (p: DaemonProgress) => void;
}

export interface PushInput extends MirrorLocation {
  system: string;
  /** The plan only: no SAP call. */
  dryRun?: boolean;
  /** Activate what was written, in one call (default true). */
  activate?: boolean;
  /**
   * The request new objects are created in, and the one to record an existing object in when the
   * system answers that it is in none (code 1001): assigned for that object's next write, which is
   * then sent once more.
   */
  transport?: string;
  /** Overrides `mirror.maxObjects` for this call. */
  maxObjects?: number;
  /**
   * After each write the local file takes what the system kept (the read-back), not only the base:
   * local, base and system then agree. The git remote helper's shadow mirror (ADR-011).
   */
  takeSystemVersion?: boolean;
}

export interface ObjectIssue {
  object: string;
  message: string;
}

export interface PushResult {
  root: string;
  system: string;
  dryRun: boolean;
  /** Objects with changed files: what the push writes (or, in a dry run, would write). */
  planned: Listed;
  /** Objects the manifest doesn't know: what the push creates (or would create). */
  toCreate: Listed;
  /** Objects written completely. */
  pushed: Listed;
  /** Objects created on the system. */
  created: Listed;
  /** Files written. */
  written: Listed;
  /** Conflicts settled: a `<file>.remote` the system still matched, the merged file written (or already equal), the `.remote` deleted. */
  resolved: Listed;
  /** Changed on the system since the last pull or push: nothing of them written. */
  conflicts: ObjectIssue[];
  /** Locked, in another user's draft, or not in a transport request: SAP's message. Also a class main source with a comment SAP can't store between its includes. */
  blocked: ObjectIssue[];
  /** Outside the write allowlist, or in another package on the system. */
  refused: ObjectIssue[];
  /** Any other failure: not found on the system, a write error, a changed file with no base to compare with. */
  failed: ObjectIssue[];
  /** `.jsonc` stubs and `.properties` changed locally: never sent. */
  notSent: Listed;
  /** In the manifest, missing locally: deletes aren't pushed (ADR-007). */
  deletedLocally: Listed;
  /**
   * What a `.msag.json` asks for and a push doesn't send (ADR-014): removed messages (`object
   * delete-messages` deletes them), a changed description (SAP records it wrong, docs/tools/objects.md).
   */
  leftOut: ObjectIssue[];
  /** New objects push can't create: a type adt-ls can't create, a missing or incomplete `.json`. */
  cannotCreate: ObjectIssue[];
  /** Files named as abapGit names a class include (`.clas.locals_imp.abap`): not sent, AFF's name in the message. */
  misnamed: ObjectIssue[];
  /** Files whose system version differs from what was sent, replaced by it locally: a created object's, or with `takeSystemVersion` any written file. */
  rewritten: Listed;
  /** New files of an object the manifest knows: not sent (a pull brings the system's). */
  newLocally: Listed;
  /** Files of a known object found in another package folder: refused. */
  moved: Listed;
  /** The activation of the written objects; absent on a dry run, with `activate: false`, or when nothing was written. */
  activation?: ActivationResult;
  /** Written objects whose activation is still due (`mirror activate`). */
  unactivated: Listed;
  /** Anything left undone: the CLI exits 1. */
  complete: boolean;
  note?: string;
  adtLsChanged?: { pulled: string; running: string };
  calls: number;
  units: number;
  ms: number;
}


/** `entry` with a new base: a good base replaces the error of a failed read, which a pull leaves beside the old hash. */
function withBase(entry: ManifestFileEntry | undefined, hash: string): ManifestFileEntry {
  const { error: _replaced, ...rest } = entry ?? {};
  return { ...rest, hash };
}

/** The stem every file of an object starts with: `zcl_x.clas.`. */
const stemOf = (type: string, name: string) => `${affName(name).toLowerCase()}.${type.toLowerCase()}.`;

interface PlannedObject {
  id: string;
  type: string;
  name: string;
  object: ManifestObject;
  /** Changed writable files: name → local text. */
  changed: Map<string, string>;
  /**
   * Files with a `<file>.remote` a re-pull left: name → its hash. That is what the system held
   * when the conflict was seen, so the push expects it instead of the base (ADR-007).
   */
  expected: Map<string, string>;
  /** Created by this push: a file the system keeps differently from what was sent is replaced locally. */
  created?: boolean;
}

/** A new object push can create. */
interface PlannedCreate extends NewObject {
  input: CreationInput;
}

interface Plan {
  objects: PlannedObject[];
  creates: PlannedCreate[];
  cannotCreate: ObjectIssue[];
  misnamed: ObjectIssue[];
  notSent: string[];
  deletedLocally: string[];
  newLocally: string[];
  moved: string[];
  /** Changed files with no base to compare with: never sent. */
  noBase: ObjectIssue[];
}

/**
 * A class main file (`zcl_x.clas.abap`) in `files` with a comment SAP can't store between its
 * includes; `current` is the system's text of it, whose own such comments pass.
 */
function classMainProblem(type: string, name: string, files: Map<string, string>, current?: Map<string, string>): string | undefined {
  if (type !== 'CLAS') return undefined;
  const main = `${stemOf(type, name)}abap`;
  // A new object's files are keyed as named on disk; one not in lower case is refused, but still checked.
  const text = files.get(main) ?? [...files].find(([file]) => file.toLowerCase() === main)?.[1];
  const problem = text === undefined ? undefined : classRegionProblem(text, current?.get(main));
  return problem && `${main}: ${problem}`;
}

/**
 * A new object's files named other than lower case. adt-ls serves AFF names in lower case, and the
 * files are matched against those only after the object exists: an `ZCL_X.clas.abap` would leave an
 * empty class on the system.
 */
function fileNameProblem(object: NewObject): string | undefined {
  const upper = [...object.files.keys()].filter((name) => name !== name.toLowerCase());
  return upper.length === 0
    ? undefined
    : `file names are lower case on the system: rename ${upper.map((name) => `${name} to ${name.toLowerCase()}`).join(', ')}`;
}

/** A new message class is created in the logon language (`createMessageClass`): a file naming another one is refused. */
function msagLanguageProblem(object: NewObject, language: string): string | undefined {
  if (object.type !== MSAG_TYPE) return undefined;
  const parsed = parseMsag(object.files.get(msagFileName(object.name)) ?? '');
  if (typeof parsed === 'string' || parsed.originalLanguage === language.toUpperCase()) return undefined;
  return `header.originalLanguage is ${parsed.originalLanguage.toLowerCase()}; a new message class is created in the logon language, ${language.toLowerCase()}`;
}

/**
 * Local changes against the manifest, sorted into what is pushed and what is only reported. No SAP
 * call. `language`, the logon language, is the one a new message class is created in.
 */
async function plan(root: string, manifest: Manifest, language: string): Promise<Plan> {
  const out: Plan = {
    objects: [],
    creates: [],
    cannotCreate: [],
    misnamed: [],
    notSent: [],
    deletedLocally: [],
    newLocally: [],
    moved: [],
    noBase: [],
  };
  const fresh: Array<{ rel: string; text: string }> = [];
  const stems = new Map<string, { id: string; dir: string }>();
  const movedIds = new Set<string>();
  for (const [id, object] of Object.entries(manifest.objects)) {
    const parsed = parseId(id);
    if (parsed) stems.set(stemOf(parsed.type, parsed.name), { id, dir: object.dir });
  }
  const scan = await scanLocal(root, manifest);
  for (const rel of scan.unknown) {
    const name = rel.split('/').pop()!.toLowerCase();
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    const aff = affClassFileFor(name);
    if (aff) {
      out.misnamed.push({ object: rel, message: `abapGit's name; AFF names this class include ${aff}: rename it` });
      continue;
    }
    let owner: { id: string; dir: string } | undefined;
    for (const [stem, o] of stems) {
      if (name.startsWith(stem)) {
        owner = o;
        break;
      }
    }
    if (owner && owner.dir !== dir) {
      out.moved.push(rel);
      movedIds.add(owner.id);
    } else if (owner) {
      out.newLocally.push(rel);
    } else if (isReadOnlyFile(name)) {
      out.notSent.push(rel);
    } else {
      const text = await readLocal(path.join(root, ...rel.split('/')));
      if (text !== undefined) fresh.push({ rel, text });
    }
  }
  for (const object of groupNew(fresh)) {
    const input = creationInput(object);
    const problems = [
      typeof input === 'string' ? input : undefined,
      fileNameProblem(object),
      classMainProblem(object.type, object.name, object.files),
      typeof input === 'string' ? undefined : msagLanguageProblem(object, language),
    ].filter(
      (p): p is string => p !== undefined,
    );
    if (problems.length > 0) out.cannotCreate.push({ object: `${object.id} (${object.dir})`, message: problems.join('; ') });
    else out.creates.push({ ...object, input: input as CreationInput });
  }
  const byObject = new Map<string, { changed: Map<string, string>; expected: Map<string, string> }>();
  for (const file of scan.files) {
    if (file.state === 'noBase' && !file.entry.readOnly) {
      // Its last read failed (a pull's, or the read-back after a write): nothing to compare with.
      const why = file.entry.error ? `its last read failed (${file.entry.error})` : 'its last read failed';
      out.noBase.push({ object: file.id, message: `${file.rel}: no base to compare with, ${why}: pull, then push` });
    } else if (file.state === 'deleted') {
      out.deletedLocally.push(file.rel);
    } else if (file.state === 'modified' && file.entry.readOnly) {
      out.notSent.push(file.rel);
    } else if (file.state === 'modified') {
      let own = byObject.get(file.id);
      if (!own) byObject.set(file.id, (own = { changed: new Map(), expected: new Map() }));
      own.changed.set(file.name, file.text!);
      // A file without a base is pushable only against the `.remote` a re-pull left (ADR-007).
      if (file.remote !== undefined) own.expected.set(file.name, contentHash(file.remote));
    }
  }
  for (const [id, { changed, expected }] of byObject) {
    const parsed = parseId(id);
    if (parsed && !movedIds.has(id)) out.objects.push({ id, ...parsed, object: manifest.objects[id]!, changed, expected });
  }
  out.objects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * adt-ls takes one lock attempt per session at a time: a write while another is locking fails
 * with this (`onprem`, M3 live). Push writes one object at a time; another client's write on the
 * same session can still collide, so such a write is tried again.
 */
const LOCK_BUSY = /another lock attempt is still in progress/i;
const LOCK_RETRIES = 3;

async function retryLockBusy<T>(fn: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= LOCK_RETRIES || !LOCK_BUSY.test(message(err))) throw err;
      await wait(500 * (attempt + 1));
    }
  }
}

/** A create refused because the name is taken. */
const EXISTS = /already exist|existiert bereits/i;

/** SAP's refusals that mean "someone or something else holds it", not a broken write. */
const BLOCKED = /lock|enqueue|being edited|currently edit|another user|by user|transport|request|corrnr|not modifiable/i;

/** Delete a settled conflict file. */
async function dropRemote(root: string, rel: string): Promise<void> {
  await rm(await safeTarget(root, `${rel}${REMOTE_SUFFIX}`), { force: true });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The class include a file holds (`zcl_x.clas.testclasses.abap` → `testclasses`), if it is one adt-ls writes. */
function classInclude(name: string): string | undefined {
  const include = name.toLowerCase().match(/\.clas\.([a-z]+)\.abap$/)?.[1];
  return include && (CLASS_INCLUDES as readonly string[]).includes(include) ? include : undefined;
}

/** Source files go first: writing a table's source changes its `.json` on the system. */
const writeOrder = (a: string, b: string) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')) || (a < b ? -1 : 1);

export async function push(deps: PushDeps, policy: MirrorPolicy, input: PushInput): Promise<PushResult> {
  const started = Date.now();
  const { adt, calls, units, charge } = counting(deps.adt);
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) {
    throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  }
  if (manifest.pull) throw new Error('a pull stopped before it finished; run `mirror pull` again before pushing');
  const planned = await plan(root, manifest, logonLanguage(deps.destination));
  const maxObjects = input.maxObjects ?? policy.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const total = planned.objects.length + planned.creates.length;
  if (total > maxObjects) {
    throw new Error(
      `the push would write ${total} objects, more than ${maxObjects}; pass a higher --max-objects ` +
        `(or raise mirror.maxObjects)`,
    );
  }
  if (!input.dryRun && planned.creates.length > 0) {
    const refused = deps.refusal?.('object.create');
    if (refused) throw new Error(`mirror.push refused before any write: ${refused}`);
  }
  // A message class is written through the object tools' REST path (ADR-014), and denied as that command.
  if (!input.dryRun && [...planned.objects, ...planned.creates].some((o) => o.type === MSAG_TYPE)) {
    const refused = deps.refusal?.('object.update');
    if (refused) throw new Error(`mirror.push refused before any write: ${refused}`);
  }

  const outcome = {
    pushed: [] as string[],
    created: [] as string[],
    written: [] as string[],
    rewritten: [] as string[],
    resolved: [] as string[],
    conflicts: [] as ObjectIssue[],
    blocked: [] as ObjectIssue[],
    refused: [] as ObjectIssue[],
    failed: [] as ObjectIssue[],
    leftOut: [] as ObjectIssue[],
  };
  const targets: ActivationTarget[] = [];
  /** Objects this push wrote only some files of: never activated as a mix of old and new files. */
  const partial = new Set<string>();
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => saveManifest(root, manifest)));

  /** A write through the SDK, logged as its own call (ADR-007). */
  async function logged<T>(cmd: Parameters<NonNullable<PushDeps['logWrite']>>[0], params: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const at = Date.now();
    try {
      const result = await fn();
      deps.logWrite?.(cmd, params, undefined, Date.now() - at);
      return result;
    } catch (err) {
      deps.logWrite?.(cmd, params, message(err), Date.now() - at);
      throw err;
    }
  }

  /** Resolve an object by name and gate it on the package the system has it in; undefined when refused or not found. */
  async function resolveGated(p: Pick<PlannedObject, 'id' | 'name' | 'type' | 'object'>): Promise<ResolvedObject | undefined> {
    const ref: ObjectRef = { name: p.name, objectType: p.type };
    let resolved: ResolvedObject;
    try {
      resolved = await resolveForWrite(adt, ref);
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      outcome.failed.push({ object: p.id, message: `not found on the system: ${message(err)}` });
      return undefined;
    }
    try {
      await assertObjectWritable(deps.destination, resolved);
    } catch (err) {
      outcome.refused.push({ object: p.id, message: message(err) });
      return undefined;
    }
    const onSystem = objectPlacement(resolved.uri, resolved)?.package;
    if (onSystem?.toUpperCase() !== p.object.package.toUpperCase()) {
      outcome.refused.push({
        object: p.id,
        message: `in package ${onSystem} on the system, ${p.object.package} in the mirror: moved on the system, pull first`,
      });
      return undefined;
    }
    return resolved;
  }

  async function pushObject(p: PlannedObject): Promise<void> {
    if (p.type === MSAG_TYPE) return pushMessageClass(p);
    const resolved = await resolveGated(p);
    if (!resolved) return;
    const folder = resolved.uri.slice(0, resolved.uri.lastIndexOf('/') + 1);

    // Conflict check: every changed file as the system has it now, against its base or, after a
    // conflict, against the `.remote` the re-pull left.
    const remote = new Map<string, string>();
    for (const name of p.changed.keys()) {
      let text: string;
      try {
        text = await adt.repository.readFile(folder + encodeURIComponent(name));
      } catch (err) {
        if (err instanceof ThrottledError) throw err;
        outcome.failed.push({ object: p.id, message: `${p.object.dir}/${name}: reading the system's version failed, nothing written: ${message(err)}` });
        return;
      }
      if (contentHash(text) !== (p.expected.get(name) ?? p.object.files[name]!.hash)) {
        const since = p.expected.has(name) ? `since its ${name}${REMOTE_SUFFIX} was written` : 'since the last pull or push';
        outcome.conflicts.push({ object: p.id, message: `${p.object.dir}/${name} changed on the system ${since}` });
        return;
      }
      remote.set(name, text);
    }
    // A comment the class main source can't store is SAP's refusal, known before the write.
    const problem = classMainProblem(p.type, p.name, p.changed, remote);
    if (problem) {
      outcome.blocked.push({ object: p.id, message: problem });
      return;
    }
    await writeObject(p, resolved, remote);
  }

  /** Write an object's changed files, each in the system's style from `remote`, its current text. */
  async function writeObject(p: PlannedObject, resolved: ResolvedObject, remote: Map<string, string>): Promise<void> {
    const ref: ObjectRef = { name: p.name, objectType: p.type };
    const folder = resolved.uri.slice(0, resolved.uri.lastIndexOf('/') + 1);
    const mainFile = decodeURIComponent(resolved.uri.slice(folder.length));

    const entries = p.object.files;
    let wrote = false;
    /**
     * One write of the file at `uri`; an object in no open request is assigned to `transport` and
     * written again. adt-ls keeps an assignment on the one file it names and the write reads it
     * from the file it writes, so it names `uri`, not the object's main source. A write SAP records
     * nothing for (an unchanged `.clas.abap`) leaves the object in no request: each write may assign.
     */
    const send = (uri: string, write: () => Promise<unknown>) =>
      writeAssigning(write, input.transport, (transport) => {
        const file = decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
        return logged('transport.assign', { ref: { ...ref }, file, transport }, () => assignForNextWrite(adt, uri, transport));
      });
    const names = [...p.changed.keys()].sort(writeOrder);
    let settled = 0;
    let complete = false;
    try {
      complete = await writeFiles();
    } finally {
      // Stopped before its last file after writing or creating something (a target): out of the
      // activation, also as an earlier push's leftover. The next push writes the rest and activates it.
      // Nothing of it written this push: what an earlier push wrote completely may still be activated.
      const at = targets.findIndex((t) => t.id === p.id);
      if (settled < names.length && at >= 0) {
        partial.add(p.id);
        targets.splice(at, 1);
      }
    }
    if (wrote && complete) outcome.pushed.push(p.id);

    /** True when every file went through without an error. */
    async function writeFiles(): Promise<boolean> {
      for (const name of names) {
        const rel = `${p.object.dir}/${name}`;
        // Merged to exactly what the system has: nothing to write, only the base moves.
        if (p.expected.has(name) && contentHash(p.changed.get(name)!) === p.expected.get(name)) {
          entries[name] = withBase(entries[name], p.expected.get(name)!);
          await save();
          await dropRemote(root, rel);
          outcome.resolved.push(rel);
          settled++;
          continue;
        }
        const text = toSystem(p.changed.get(name)!, lineStyle(remote.get(name)!, name));
        const uri = folder + encodeURIComponent(name);
        const include = classInclude(name);
        try {
          if (name === mainFile || include) {
            await send(uri, () =>
              logged('object.update', { ref: { ...ref }, file: name }, () =>
                retryLockBusy(() => adt.lifecycle.update({ ...ref, uri: resolved.uri, source: text, ...(name === mainFile ? {} : { include }) }), wait),
              ),
            );
          } else {
            await send(uri, () =>
              logged('object.update', { ref: { ...ref }, file: name }, () => retryLockBusy(() => adt.repository.writeFile(uri, text), wait)),
            );
          }
        } catch (err) {
          if (err instanceof ThrottledError) throw err;
          const hint = isNotInTransport(err) && !input.transport ? ' (pass a transport request to record it in)' : '';
          (BLOCKED.test(message(err)) ? outcome.blocked : outcome.failed).push({ object: p.id, message: `${rel}: ${message(err)}${hint}` });
          return false;
        }
        // The new base is what the system keeps, not what was sent (ADR-007): a class comes back CRLF.
        // adt-ls serves its cache right after a write, so refresh first.
        if (!targets.some((t) => t.id === p.id)) targets.push({ id: p.id, ref, uri: resolved.uri });
        p.object.unactivated = true;
        entries[name] = { ...entries[name], draft: true };
        let kept: string;
        try {
          await adt.raw.lsp('adtLs/fileSystem/forceRefresh', { uri });
          kept = await adt.repository.readFile(uri);
          entries[name] = withBase(entries[name], contentHash(kept));
        } catch (err) {
          if (err instanceof ThrottledError) throw err;
          // Written, but the base can't be taken: push refuses the file and the next pull sees a conflict,
          // never a silent overwrite; `mirror status` lists it as a read error.
          delete entries[name]!.hash;
          entries[name]!.error = `reading it back after the write failed: ${message(err)}`;
          outcome.failed.push({ object: p.id, message: `${rel} written, but reading it back failed: ${message(err)}` });
          await save();
          // The file is on the system; only the files after it are missing.
          settled++;
          return false;
        }
        outcome.written.push(rel);
        wrote = true;
        // A created object's skeleton isn't what the system keeps (adt-ls adds and orders `.json` keys):
        // the local file takes the system's version, so local, base and system agree.
        if ((p.created || input.takeSystemVersion) && contentHash(kept) !== contentHash(p.changed.get(name)!)) {
          await writeFile(await safeTarget(root, rel), toLocal(kept));
          outcome.rewritten.push(rel);
        }
        await save();
        if (p.expected.has(name)) {
          await dropRemote(root, rel);
          outcome.resolved.push(rel);
        }
        settled++;
      }
      return true;
    }
  }

  /** A message class's `.msag.json` through REST (ADR-014): no adt-ls file, no activation. */
  async function pushMessageClass(p: PlannedObject): Promise<void> {
    const file = msagFileName(p.name);
    const rel = `${p.object.dir}/${file}`;
    const text = p.changed.get(file);
    if (text === undefined) return;
    const local = parseMsag(text);
    if (typeof local === 'string') {
      outcome.failed.push({ object: p.id, message: `${rel}: ${local}; nothing sent` });
      return;
    }
    const withRest = deps.withRest;
    if (!withRest) {
      outcome.failed.push({ object: p.id, message: `${rel}: no REST session to write message classes with; nothing sent` });
      return;
    }
    /** The class as the system has it now; undefined after a failure, which it reports. */
    const read = async (what: string) => {
      try {
        const now = await withRest((rest) => readMsag(rest, p.name));
        charge(now?.requests ?? 1);
        if (now) return now;
        outcome.failed.push({ object: p.id, message: `not found on the system${what}` });
      } catch (err) {
        if (err instanceof ThrottledError) throw err;
        outcome.failed.push({ object: p.id, message: `${rel}: reading the system's version failed${what}: ${message(err)}` });
      }
      return undefined;
    };
    const current = await read(', nothing written');
    if (!current) return;
    const lookupChain = async (pkg: string) => (await chainOf(pkg)) ?? [];
    try {
      await assertPackageWritable(deps.destination, current.package, { lookupChain });
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      outcome.refused.push({ object: p.id, message: message(err) });
      return;
    }
    if (current.package !== p.object.package.toUpperCase()) {
      outcome.refused.push({
        object: p.id,
        message: `in package ${current.package} on the system, ${p.object.package} in the mirror: moved on the system, pull first`,
      });
      return;
    }
    if (contentHash(current.text) !== (p.expected.get(file) ?? p.object.files[file]?.hash)) {
      const since = p.expected.has(file) ? `since its ${file}${REMOTE_SUFFIX} was written` : 'since the last pull or push';
      outcome.conflicts.push({ object: p.id, message: `${rel} changed on the system ${since}` });
      return;
    }
    const master = current.messageClass.masterLanguage.toUpperCase();
    if (local.originalLanguage !== master) {
      outcome.failed.push({
        object: p.id,
        message: `${rel}: header.originalLanguage is ${local.originalLanguage.toLowerCase()}, the class's is ${master.toLowerCase()}; a push doesn't change it, nothing sent`,
      });
      return;
    }
    const changes = msagChanges(current.messageClass, local);
    // What the file asks for and a push doesn't send (ADR-014).
    const left: string[] = [];
    if (changes.removed.length > 0) {
      left.push(`message ${changes.removed.join(', ')} not in the file, not deleted: a push deletes no messages (\`object delete-messages\` does)`);
    }
    if (changes.description !== undefined) left.push(`the description isn't sent: ${descriptionRefusal(p.name).message.replace(/^message class \S+: /, '')}`);
    let kept = current.text;
    const wrote = changes.messages.length > 0;
    if (wrote) {
      const ref = { name: p.name, objectType: 'MSAG/N' };
      try {
        await logged('object.update', { ref, file, ...(input.transport ? { transport: input.transport } : {}) }, () =>
          withRest((rest) =>
            updateMessageClass(
              rest,
              deps.destination,
              { name: p.name, messages: changes.messages, transport: input.transport },
              lookupChain,
            ),
          ),
        );
      } catch (err) {
        if (err instanceof ThrottledError) throw err;
        // The PUT may have gone through before the failure (a read-back off, the unlock): when the
        // system no longer has the base, the base is dropped, so the next push asks for a pull
        // instead of calling its own write a conflict.
        const now = await withRest((rest) => readMsag(rest, p.name)).catch((e: unknown) => {
          if (e instanceof ThrottledError) throw e;
          return undefined;
        });
        charge(now?.requests ?? 1);
        if (!now || contentHash(now.text) !== contentHash(current.text)) {
          delete p.object.files[file]!.hash;
          p.object.files[file]!.error = `the write failed and the system's version may have changed: ${message(err)}`;
          await save();
        }
        (BLOCKED.test(message(err)) ? outcome.blocked : outcome.failed).push({ object: p.id, message: `${rel}: ${message(err)}` });
        return;
      } finally {
        // Its reads, the package's, the lock, the write and the unlock.
        charge(6);
      }
      // Live at once: no inactive version, nothing to activate. The new base is what the system keeps.
      const after = await read(' after the write');
      if (!after) {
        delete p.object.files[file]!.hash;
        p.object.files[file]!.error = 'reading it back after the write failed';
        await save();
        return;
      }
      kept = after.text;
      outcome.written.push(rel);
    }
    p.object.files[file] = withBase(p.object.files[file], contentHash(kept));
    // With something left out the local file keeps it, unless the caller wants the system's state.
    if (contentHash(kept) !== contentHash(text) && (left.length === 0 || input.takeSystemVersion || p.created)) {
      await writeFile(await safeTarget(root, rel), toLocal(kept));
      outcome.rewritten.push(rel);
    }
    await save();
    if (p.expected.has(file)) {
      await dropRemote(root, rel);
      outcome.resolved.push(rel);
    }
    if (left.length > 0) {
      outcome.leftOut.push({ object: p.id, message: `${rel}: ${left.join('; ')}` });
    } else if (wrote) {
      outcome.pushed.push(p.id);
    }
  }

  /** Create a message class through REST (ADR-014), its base the empty class, then write its messages. */
  async function createMessageClassObject(n: PlannedCreate, pkg: string): Promise<void> {
    const withRest = deps.withRest;
    if (!withRest) {
      outcome.failed.push({ object: n.id, message: 'no REST session to create message classes with; nothing created' });
      return;
    }
    const lookupChain = async (p: string) => (await chainOf(p)) ?? [];
    const ref = { name: n.name, objectType: 'MSAG/N' };
    try {
      await logged('object.create', { ref, package: pkg, ...(input.transport ? { transport: input.transport } : {}) }, () =>
        withRest((rest) =>
          createMessageClass(rest, deps.destination, { name: n.name, packageName: pkg, description: n.input.description, transport: input.transport }, lookupChain),
        ),
      );
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      const text = message(err);
      if (EXISTS.test(text)) outcome.conflicts.push({ object: n.id, message: `exists on the system: pull to take it into the mirror (${text})` });
      else (BLOCKED.test(text) ? outcome.blocked : outcome.failed).push({ object: n.id, message: text });
      return;
    } finally {
      // The package's read, SAP's name check, the create and its read-back.
      charge(4);
    }
    outcome.created.push(n.id);
    const object: ManifestObject = { package: pkg, dir: n.dir, files: {} };
    manifest!.objects[n.id] = object;
    await save();
    const file = msagFileName(n.name);
    let created: Awaited<ReturnType<typeof readMsag>>;
    try {
      created = await withRest((rest) => readMsag(rest, n.name));
      charge(created?.requests ?? 1);
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      created = undefined;
    }
    if (!created) {
      outcome.failed.push({ object: n.id, message: 'created, but reading it failed, nothing written; pull, then push' });
      return;
    }
    object.files = { [file]: { hash: contentHash(created.text) } };
    await save();
    const p: PlannedObject = { id: n.id, type: n.type, name: n.name, object, changed: new Map(), expected: new Map(), created: true };
    const text = n.files.get(file)!;
    if (contentHash(text) === contentHash(created.text)) {
      outcome.pushed.push(n.id);
      return;
    }
    p.changed.set(file, text);
    await pushMessageClass(p);
  }

  const chains = new Map<string, Promise<string[] | undefined>>();
  /** A package's chain on the system, top down; undefined when the system has no such package. Once per push. */
  const chainOf = (pkg: string) => {
    if (!chains.has(pkg)) {
      chains.set(
        pkg,
        lookupPackageChain(adt)(pkg).catch((err) => {
          if (err instanceof ThrottledError) throw err;
          return undefined;
        }),
      );
    }
    return chains.get(pkg)!;
  };

  const recording = new Map<string, Promise<boolean | undefined>>();
  /** Whether a package records changes, asked once per push. */
  const recordingOf = (pkg: string) => {
    if (!recording.has(pkg)) {
      recording.set(
        pkg,
        deps.recordsChanges!(pkg).catch((err) => {
          if (err instanceof ThrottledError) throw err;
          return undefined;
        }),
      );
    }
    return recording.get(pkg)!;
  };

  /**
   * Create a new object, then write it as any other: gate on its folder's package, create, enter it
   * in the manifest with the template the system serves as its base, write the local files over it.
   * A push that stops after the create finds the object in the manifest next time.
   */
  async function createObject(n: PlannedCreate): Promise<void> {
    let pkg = knownPackage(manifest!, n.dir);
    let chain: string[] | undefined;
    if (!pkg) {
      chain = await chainOf(abapName(n.dir.slice(n.dir.lastIndexOf('/') + 1)));
      const placed = folderPackage(manifest!, n.dir, chain);
      if ('problem' in placed) {
        outcome.refused.push({ object: n.id, message: placed.problem });
        return;
      }
      pkg = placed.package;
    }
    try {
      await assertPackageWritable(deps.destination, pkg, chain ? { chain } : { lookupChain: async (p) => (await chainOf(p)) ?? [] });
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      outcome.refused.push({ object: n.id, message: message(err) });
      return;
    }
    // Without a request, `onprem` refuses some creates in such a package and files others in a request it
    // generates itself (M4 live): never leave the choice to the system.
    if (!input.transport && deps.recordsChanges) {
      const records = await recordingOf(pkg);
      if (records !== false) {
        const why = records ? `package ${pkg} records changes` : `can't tell whether package ${pkg} records changes`;
        outcome.blocked.push({ object: n.id, message: `${why}: pass a transport request to create it in` });
        return;
      }
    }
    if (n.type === MSAG_TYPE) return createMessageClassObject(n, pkg);
    const ref: ObjectRef = { name: n.name, objectType: n.input.objectType };
    try {
      await logged('object.create', { ref: { ...ref }, package: pkg, ...(input.transport ? { transport: input.transport } : {}) }, () =>
        retryLockBusy(
          () =>
            adt.lifecycle.create({
              ...ref,
              packageName: pkg,
              description: n.input.description,
              transportRequestNumber: input.transport ?? '',
              ...(n.input.additionalFields ? { additionalFields: n.input.additionalFields } : {}),
            }),
          wait,
        ),
      );
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      const text = message(err);
      if (EXISTS.test(text)) {
        outcome.conflicts.push({ object: n.id, message: `exists on the system: pull to take it into the mirror (${text})` });
      } else {
        const hint = !input.transport && /transport|request|corrnr/i.test(text) ? ' (pass a transport request to create it in)' : '';
        (BLOCKED.test(text) ? outcome.blocked : outcome.failed).push({ object: n.id, message: `${text}${hint}` });
      }
      return;
    }
    outcome.created.push(n.id);

    // In the manifest before anything else can fail: the next push or pull knows the object exists,
    // and a pull takes its files (a local file that differs gets a `.remote`).
    const object: ManifestObject = { package: pkg, dir: n.dir, files: {}, unactivated: true, created: true };
    manifest!.objects[n.id] = object;
    await save();
    const p: PlannedObject = { id: n.id, type: n.type, name: n.name, object, changed: new Map(), expected: new Map(), created: true };
    const resolved = await resolveGated(p);
    if (!resolved) return;
    const folder = resolved.uri.slice(0, resolved.uri.lastIndexOf('/') + 1);
    const files: ManifestObject['files'] = {};
    const remote = new Map<string, string>();
    try {
      const served = new Set((await adt.repository.readDirectory(folder)).filter((e) => e.kind === 'file').map((e) => e.name));
      for (const [name, text] of n.files) {
        // A class include the fresh class doesn't serve yet is written through the class, from empty.
        const include = n.type === 'CLAS' && classInclude(name) !== undefined;
        if (!served.has(name) && !include) {
          outcome.failed.push({ object: n.id, message: `${n.dir}/${name}: not a file of ${n.id} on the system, not sent` });
          continue;
        }
        const template = served.has(name) ? await adt.repository.readFile(folder + encodeURIComponent(name)) : '';
        files[name] = { hash: contentHash(template), draft: true };
        remote.set(name, template);
        if (contentHash(text) !== contentHash(template)) p.changed.set(name, text);
      }
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      outcome.failed.push({ object: n.id, message: `created, but reading its files failed, nothing written: ${message(err)}; pull, then push` });
      return;
    }
    object.files = files;
    await save();
    targets.push({ id: n.id, ref: { name: n.name, objectType: n.type }, uri: resolved.uri });
    await writeObject(p, resolved, remote);
  }

  if (!input.dryRun) {
    // One object at a time: adt-ls refuses a second lock attempt while one is in progress (LOCK_BUSY).
    try {
      // An unexpected error costs its object, not the push: the others are still written and activated.
      const each = async (id: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          if (err instanceof ThrottledError) throw err;
          outcome.failed.push({ object: id, message: message(err) });
        }
      };
      let done = 0;
      const step = () => deps.progress?.({ stage: 'writing', done, total, units: units() });
      step();
      for (const n of planned.creates) {
        await each(n.id, () => deps.hold({ name: n.name, objectType: n.type }, () => createObject(n)));
        done++;
        step();
      }
      for (const p of planned.objects) {
        await each(p.id, () => deps.hold({ name: p.name, objectType: p.type.slice(0, 4) }, () => pushObject(p)));
        done++;
        step();
      }
    } finally {
      await saving;
    }
  }

  // Objects an earlier push left waiting go into the same activation: one failing object leaves
  // most of a batch inactive, unrelated ones included (M4 live), and they'd wait for `mirror activate`.
  if (!input.dryRun && input.activate !== false && targets.length > 0) {
    for (const [id, object] of Object.entries(manifest.objects)) {
      const parsed = parseId(id);
      if (!object.unactivated || !parsed || partial.has(id) || targets.some((t) => t.id === id)) continue;
      const resolved = await resolveGated({ id, ...parsed, object });
      if (resolved) targets.push({ id, ref: { name: parsed.name, objectType: parsed.type }, uri: resolved.uri });
    }
  }

  const activates = !input.dryRun && input.activate !== false && targets.length > 0;
  if (activates) deps.progress?.({ stage: 'activating', done: 0, total: targets.length, units: units() });
  const activation = activates
    ? await activateTargets(
        adt,
        manifest,
        targets,
        async () => {
          await save();
          await saving;
        },
        deps.logWrite,
        { root, hold: deps.hold },
      )
    : undefined;

  // A move's `(was <package>)` entry is never activated, so it isn't listed as waiting.
  const unactivated = Object.entries(manifest.objects)
    .filter(([id, o]) => o.unactivated && parseId(id))
    .map(([id]) => id);
  const undone =
    outcome.conflicts.length +
    outcome.blocked.length +
    outcome.refused.length +
    outcome.failed.length +
    outcome.leftOut.length +
    planned.noBase.length +
    planned.moved.length +
    planned.cannotCreate.length +
    planned.misnamed.length;
  const conflictShare = planned.objects.length >= 3 && outcome.conflicts.length > planned.objects.length / 2;
  const adtLsChanged = adtLsChange(manifest.adtLs, deps.adtLsVersion);
  return {
    root,
    system: manifest.system,
    dryRun: input.dryRun === true,
    planned: listed(planned.objects.map((o) => o.id)),
    toCreate: listed(planned.creates.map((o) => o.id)),
    pushed: listed(outcome.pushed),
    created: listed(outcome.created),
    written: listed(outcome.written),
    rewritten: listed(outcome.rewritten),
    resolved: listed(outcome.resolved),
    conflicts: outcome.conflicts.slice(0, MAX_LISTED),
    blocked: outcome.blocked.slice(0, MAX_LISTED),
    refused: outcome.refused.slice(0, MAX_LISTED),
    failed: [...planned.noBase, ...outcome.failed].slice(0, MAX_LISTED),
    cannotCreate: planned.cannotCreate.slice(0, MAX_LISTED),
    misnamed: planned.misnamed.slice(0, MAX_LISTED),
    notSent: listed(planned.notSent),
    deletedLocally: listed(planned.deletedLocally),
    leftOut: outcome.leftOut.slice(0, MAX_LISTED),
    newLocally: listed(planned.newLocally),
    moved: listed(planned.moved),
    ...(activation ? { activation } : {}),
    unactivated: listed(unactivated),
    complete: undone === 0 && (activation === undefined || activationComplete(activation)),
    ...(conflictShare
      ? { note: 'most objects conflict: the manifest may be stale (was .adtplus/ checked out from an older commit?); pull, then push again' }
      : {}),
    ...(adtLsChanged ? { adtLsChanged } : {}),
    calls: calls(),
    units: units(),
    ms: Date.now() - started,
  };
}
