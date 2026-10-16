import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { ACTIVATE_MAX_REFS, activateUris } from '../capabilities/object.js';
import { assertObjectWritable } from '../capabilities/policy.js';
import { objectPlacement } from '../core/placement.js';
import { resolveObject } from '../core/resolve.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { adtLsChange } from './files.js';
import { isSafeSegment, parseId, resolveRoot } from './layout.js';
import { loadManifest, saveManifest, type Manifest } from './manifest.js';
import { MAX_LISTED, counting, listed, takeFile, type Listed, type MirrorDeps, type MirrorLocation } from './pull.js';
import type { ObjectIssue, PushDeps } from './push.js';

/**
 * Activation for mirror pushes (docs/decisions/007-mirror-mode.md, "Push" 7:
 * one activation call for everything; batches of at most 50, docs/tools/mirror.md).
 * Diagnostics come back per repotree file URI with a 0-based range (probe 3,
 * P8); they map to local files through the object's folder. Whether an object
 * really is active afterwards is asked of the system (`abapStat`, no backend
 * request), not inferred from the diagnostics.
 */

export interface ActivationTarget {
  /** Manifest key: `CLAS ZCL_X`. */
  id: string;
  ref: ObjectRef;
  /** The resolved main file. */
  uri: string;
}

export interface MirrorDiagnostic {
  /** Relative to the mirror root; the bare file name when no mirrored object holds it. */
  path: string;
  /** 1-based; 0 for a message about the whole object (on its `.json`). */
  line: number;
  col?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface ActivationResult {
  activated: Listed;
  notActivated: Listed;
  errors: number;
  warnings: number;
  /** Errors first, at most `MAX_LISTED`. */
  diagnostics: MirrorDiagnostic[];
  /** An activation call that failed as a whole. */
  failure?: string;
  /** Created objects read back after their activation; absent when none was activated. */
  readBack?: ReadBack;
}

/** What the read-back of activated new objects took into the mirror. */
export interface ReadBack {
  /** Files the system added or changed at activation, written locally. */
  taken: Listed;
  /** Changed locally too: the system's version is in `<file>.remote`. */
  conflicts: Listed;
  /** Folders or files that failed to read: the object is read back on its next activation, or by a pull. */
  failed: ObjectIssue[];
}

/** Where push and `mirror activate` read created objects back. */
export interface ReadBackOptions {
  root: string;
  hold: MirrorDeps['hold'];
}

interface RawDiagnostic {
  fileUri?: string;
  diagnostic?: Array<{ range?: { start?: { line?: number; character?: number } }; severity?: number; message?: string }>;
}

const folderOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/') + 1);

/** An error diagnostic on a file in `folder`. */
function hasError(raw: unknown[], folder: string): boolean {
  return (raw as RawDiagnostic[]).some((e) => (e.fileUri ?? '').startsWith(folder) && (e.diagnostic ?? []).some((d) => d.severity === 1));
}

/** Diagnostics on local paths: a file of a mirrored object → `<dir>/<file>`; one message once. */
function mapDiagnostics(raw: unknown[], targets: ActivationTarget[], manifest: Manifest): MirrorDiagnostic[] {
  const out = new Map<string, MirrorDiagnostic>();
  for (const entry of raw as RawDiagnostic[]) {
    const fileUri = entry.fileUri ?? '';
    const file = decodeURIComponent(fileUri.slice(fileUri.lastIndexOf('/') + 1));
    const target = targets.find((t) => fileUri.startsWith(folderOf(t.uri)));
    const dir = target ? manifest.objects[target.id]?.dir : undefined;
    const path = dir ? `${dir}/${file}` : file;
    for (const d of entry.diagnostic ?? []) {
      const start = d.range?.start ?? {};
      const objectLevel = file.endsWith('.json') && !start.line && !start.character;
      const diagnostic: MirrorDiagnostic = {
        path,
        line: objectLevel ? 0 : (start.line ?? 0) + 1,
        ...(objectLevel ? {} : { col: (start.character ?? 0) + 1 }),
        severity: d.severity === 1 ? 'error' : 'warning',
        message: d.message ?? '',
      };
      // The same error comes back on the .json and on the source (probe 3): keep each message once per path and line.
      out.set(`${path}\0${diagnostic.line}\0${diagnostic.message}`, diagnostic);
    }
  }
  // `onprem` also repeats a source error as an object-level message on the .json (M3 live): keep the one with a line.
  const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1) + (p.split('/').pop()?.split('.')[0] ?? '');
  const onLines = new Set([...out.values()].filter((d) => d.line > 0).map((d) => `${dir(d.path)}\0${d.message}`));
  for (const [key, d] of out) if (d.line === 0 && onLines.has(`${dir(d.path)}\0${d.message}`)) out.delete(key);
  return [...out.values()].sort(
    (a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line,
  );
}

/**
 * Activate `targets` (already gated) in batches, map the diagnostics, and
 * clear `unactivated` and the draft flags of every object the system now
 * serves active. With `readBackOptions`, activated objects a push created are
 * read back. `save` persists the manifest.
 */
export async function activateTargets(
  adt: AdtLsClient,
  manifest: Manifest,
  targets: ActivationTarget[],
  save: () => Promise<void>,
  logWrite?: PushDeps['logWrite'],
  readBackOptions?: ReadBackOptions,
): Promise<ActivationResult> {
  const diagnostics: unknown[] = [];
  let failure: string | undefined;
  for (let i = 0; i < targets.length; i += ACTIVATE_MAX_REFS) {
    const batch = targets.slice(i, i + ACTIVATE_MAX_REFS);
    const at = Date.now();
    const params = { refs: batch.map((t) => t.ref) };
    try {
      const result = await activateUris(adt, batch.map((t) => t.uri));
      logWrite?.('object.activate', params, undefined, Date.now() - at);
      diagnostics.push(...result.diagnostics);
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logWrite?.('object.activate', params, message, Date.now() - at);
      failure ??= message;
    }
  }

  const activated: string[] = [];
  const notActivated: string[] = [];
  for (const t of targets) {
    const object = manifest.objects[t.id];
    if (!object) continue;
    // A file whose stat fails counts as inactive when the activation failed or reported an error on
    // the object; after a clean activation it counts as active, so one flaky stat doesn't hold it forever.
    const doubtful = failure !== undefined || hasError(diagnostics, folderOf(t.uri));
    let inactive = false;
    for (const [name, entry] of Object.entries(object.files)) {
      if (!entry.draft) continue;
      const version = await adt.repository.abapStat(folderOf(t.uri) + encodeURIComponent(name)).catch((err: unknown) => {
        if (err instanceof ThrottledError) throw err;
        return 'unknown' as const;
      });
      if (version === 'inactive' || (version === 'unknown' && doubtful)) inactive = true;
      else delete entry.draft;
    }
    if (inactive) {
      notActivated.push(t.id);
    } else {
      delete object.unactivated;
      activated.push(t.id);
    }
  }
  await save();

  const created = targets.filter((t) => activated.includes(t.id) && manifest.objects[t.id]?.created);
  const readBack = readBackOptions && created.length > 0 ? await readBackCreated(adt, manifest, created, readBackOptions) : undefined;
  if (readBack) await save();

  const mapped = mapDiagnostics(diagnostics, targets, manifest);
  const errors = mapped.filter((d) => d.severity === 'error').length;
  return {
    activated: listed(activated),
    notActivated: listed(notActivated),
    errors,
    warnings: mapped.length - errors,
    diagnostics: mapped.slice(0, MAX_LISTED),
    ...(failure ? { failure } : {}),
    ...(readBack ? { readBack } : {}),
  };
}

/**
 * Read each activated new object's folder once more: activation adds and changes files (class
 * include templates and `texts.en.properties`, a DDLS `.json`'s `sourceType`; M4 live). Each file
 * goes through pull's rule, so a local change is never overwritten. The object stays `created`
 * until every file was read.
 */
async function readBackCreated(
  adt: AdtLsClient,
  manifest: Manifest,
  targets: ActivationTarget[],
  opts: ReadBackOptions,
): Promise<ReadBack> {
  const taken: string[] = [];
  const conflicts: string[] = [];
  const failed: ObjectIssue[] = [];
  for (const t of targets) {
    const object = manifest.objects[t.id]!;
    const folder = folderOf(t.uri);
    await opts.hold(t.ref, async () => {
      let names: string[];
      try {
        names = (await adt.repository.readDirectory(folder)).filter((e) => e.kind === 'file' && isSafeSegment(e.name)).map((e) => e.name);
      } catch (err) {
        if (err instanceof ThrottledError) throw err;
        failed.push({ object: t.id, message: `${object.dir}: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      let complete = true;
      for (const name of names.sort()) {
        const rel = `${object.dir}/${name}`;
        const result = await takeFile(adt, opts.root, object.dir, folder, name, object.files);
        if (result === 'written') taken.push(rel);
        else if (result === 'conflict') conflicts.push(rel);
        else if (result === 'error') {
          complete = false;
          failed.push({ object: t.id, message: `${rel}: ${object.files[name]!.error}` });
        }
      }
      if (complete) delete object.created;
    });
  }
  return { taken: listed(taken), conflicts: listed(conflicts), failed: failed.slice(0, MAX_LISTED) };
}

/** Everything activated, and every created object read back without a conflict. */
export function activationComplete(a: ActivationResult): boolean {
  return a.notActivated.count === 0 && !a.failure && (a.readBack === undefined || (a.readBack.conflicts.count === 0 && a.readBack.failed.length === 0));
}

export interface MirrorActivateInput extends MirrorLocation {
  system: string;
}

export interface MirrorActivateResult {
  root: string;
  system: string;
  /** Unactivated objects outside the allowlist, moved on the system, or not found. */
  refused: ObjectIssue[];
  activation: ActivationResult;
  complete: boolean;
  note?: string;
  adtLsChanged?: { pulled: string; running: string };
  calls: number;
  units: number;
  ms: number;
}

/** `mirror activate`: the objects a push wrote and didn't activate, gated again. */
export async function activateMirror(deps: PushDeps, input: MirrorActivateInput): Promise<MirrorActivateResult> {
  const started = Date.now();
  const { adt, calls, units } = counting(deps.adt);
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) {
    throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  }
  const refused: ObjectIssue[] = [];
  const targets: ActivationTarget[] = [];
  for (const [id, object] of Object.entries(manifest.objects)) {
    const parsed = parseId(id);
    if (!object.unactivated || !parsed) continue;
    const ref = { name: parsed.name, objectType: parsed.type };
    try {
      const resolved = await resolveObject(adt, ref);
      await assertObjectWritable(deps.destination, resolved);
      const onSystem = objectPlacement(resolved.uri, resolved)?.package;
      if (onSystem?.toUpperCase() !== object.package.toUpperCase()) {
        throw new Error(`in package ${onSystem} on the system, ${object.package} in the mirror: moved on the system, pull first`);
      }
      targets.push({ id, ref, uri: resolved.uri });
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      refused.push({ object: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const activation = await activateTargets(adt, manifest, targets, () => saveManifest(root, manifest), deps.logWrite, {
    root,
    hold: deps.hold,
  });
  const adtLsChanged = adtLsChange(manifest.adtLs, deps.adtLsVersion);
  return {
    root,
    system: manifest.system,
    refused,
    activation,
    complete: refused.length === 0 && activationComplete(activation),
    ...(targets.length === 0 && refused.length === 0 ? { note: 'nothing to activate: no pushed object is waiting' } : {}),
    ...(adtLsChanged ? { adtLsChanged } : {}),
    calls: calls(),
    units: units(),
    ms: Date.now() - started,
  };
}
