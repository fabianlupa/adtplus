import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { MANIFEST_DIR, MANIFEST_FILE, SRC_DIR, isSafeRelativePath, isSafeSegment, safeTarget } from './layout.js';

/**
 * `.adtplus/mirror.json` (docs/decisions/007-mirror-mode.md, "Manifest"):
 * which files belong to which object, and each file's base hash. It holds no
 * URIs: nothing in it is trusted to address the system. Written with sorted
 * keys after every object, so git diffs stay small and a stopped pull resumes.
 */

export const MANIFEST_PATH = `${MANIFEST_DIR}/${MANIFEST_FILE}`;

const FileSchema = z
  .object({
    /** SHA-256 of the normalized content as last pulled; absent when it was never read. */
    hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** `.jsonc` stub or `.properties` texts: never sent by a push. */
    readOnly: z.literal(true).optional(),
    /** The logged-on user's inactive version was read. */
    draft: z.literal(true).optional(),
    /** The last read failed with this message. */
    error: z.string().optional(),
    /** Read in the unfinished pull with this id. */
    pull: z.string().optional(),
  })
  .strict();

const ObjectSchema = z
  .object({
    /** The package the object was last seen in. */
    package: z.string().min(1),
    /** Folder holding the files, relative to the mirror root: `src/<package>[/<subpackage>…]`. */
    dir: z.string().refine((d) => isSafeRelativePath(d) && d.split('/')[0] === SRC_DIR, 'not a safe path under src/'),
    files: z.record(z.string().refine(isSafeSegment, 'not a safe file name'), FileSchema),
    /** A push wrote it and it isn't activated yet: what `mirror activate` activates. */
    unactivated: z.literal(true).optional(),
    /** A push created it and hasn't read it back since its activation, which adds and changes files. */
    created: z.literal(true).optional(),
  })
  .strict();

const ManifestSchema = z
  .object({
    version: z.literal(1),
    system: z.string().min(1),
    packages: z.array(z.object({ name: z.string().min(1), subpackages: z.boolean() }).strict()),
    /** adt-ls version of the last pull. */
    adtLs: z.string().optional(),
    /** An unfinished pull. */
    pull: z
      .object({
        id: z.string(),
        startedAt: z.string(),
        /** Progress, for a caller watching the file (the git helper, G5b): objects to read, read so far, units spent. */
        total: z.number().int().nonnegative().optional(),
        done: z.number().int().nonnegative().optional(),
        units: z.number().nonnegative().optional(),
        updatedAt: z.string().optional(),
      })
      .strict()
      .optional(),
    objects: z.record(z.string(), ObjectSchema),
  })
  .strict();

export type ManifestFileEntry = z.infer<typeof FileSchema>;
export type ManifestObject = z.infer<typeof ObjectSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export function emptyManifest(system: string): Manifest {
  return { version: 1, system, packages: [], objects: {} };
}

export function newPullId(): string {
  return randomBytes(6).toString('hex');
}

/** Parse and check a manifest's text; `where` names it in errors. */
export function parseManifest(text: string, where: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${where}: invalid mirror manifest\n${issues.join('\n')}`);
  }
  return parsed.data;
}

/** The manifest under the real mirror `root`, or undefined when there is none. */
export async function loadManifest(root: string): Promise<Manifest | undefined> {
  const file = await safeTarget(root, MANIFEST_PATH);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseManifest(text, file);
}

/** JSON with object keys sorted at every level, two-space indent, final newline. */
export function serializeManifest(manifest: Manifest): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sorted(v)]),
      );
    }
    return value;
  };
  return `${JSON.stringify(sorted(manifest), null, 2)}\n`;
}

/** Write the manifest atomically: a temporary file next to it, then a rename. */
export async function saveManifest(root: string, manifest: Manifest): Promise<void> {
  const file = await safeTarget(root, MANIFEST_PATH, { mkdir: true });
  const tmp = path.join(path.dirname(file), `.${MANIFEST_FILE}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, serializeManifest(manifest), { flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
