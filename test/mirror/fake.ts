import type { AdtLsClient, DirectoryEntry } from '@arc-mcp/adt-ls';
import { vi } from 'vitest';
import type { MirrorDeps } from '../../src/mirror/pull.js';

/** Repotree root of the fake system; every path below is relative to it. */
export const ROOT = 'abap:/repotree-v1/FAKE/System%20Library/';

const enc = (segments: string[]): string => segments.map((s) => `${encodeURIComponent(s)}/`).join('');
const dec = (uri: string): string[] => {
  if (!uri.startsWith(ROOT)) throw new Error(`not a fake URI: ${uri}`);
  return uri.slice(ROOT.length).split('/').filter(Boolean).map(decodeURIComponent);
};

/**
 * An adt-ls client over an in-memory repotree: `files` maps a slash path
 * (`ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap`) to its content.
 * A folder holding `<name>.devck.jsonc` is a package `search` finds.
 */
export function fakeSystem(files: Record<string, string>) {
  const state = {
    files: { ...files },
    drafts: new Set<string>(),
    /** Throws on reading a path for which this returns an error. */
    failRead: (_path: string): Error | undefined => undefined,
    failDir: (_path: string): Error | undefined => undefined,
    failWrite: (_path: string): Error | undefined => undefined,
    /** What adt-ls serves right after a write: the written text, until a forceRefresh (probe 3). */
    cache: new Map<string, string>(),
    /** Activation errors by main file path: `{line, message}` (0-based line); such an object stays inactive. */
    activationErrors: new Map<string, { line: number; message: string }>(),
    /** Called per object folder an activation activates: what the system adds or changes then (M4 live). */
    onActivate: (_folder: string) => {},
    /** Throws on the next activation call when set. */
    failActivation: undefined as Error | undefined,
    /** Object folders (`…/ZCL_A/`) in no open request: a write fails with code 1001 until assigned. */
    noTransport: new Set<string>(),
    /** Requests an assign takes; any other is accepted by adt-ls and changes nothing (as on ONPREM). */
    requests: new Set<string>(),
    /** Assigned for the next write, per file path: adt-ls keeps it on the one file the URI names. */
    pending: new Map<string, string>(),
    /** Writes the system takes but records nothing for (an unchanged `.clas.abap`): the object stays in no request. */
    recordsNothing: (_path: string): boolean => false,
    /** Where each object's writes were recorded, per object folder. */
    recorded: new Map<string, string>(),
    /** Packages that record changes: a create there needs a transport request. */
    transportable: new Set<string>(),
    /** Folder paths (`ZADTPLUS_A/…/ZI_B/`) the listing leaves out though the object exists: ONPREM's never-activated views (M5 live). */
    unlisted: new Set<string>(),
    /** Throws on creating an object for which this returns an error. */
    failCreate: (_name: string): Error | undefined => undefined,
  };
  const children = (dir: string[]): DirectoryEntry[] => {
    const prefix = dir.length ? `${dir.join('/')}/` : '';
    const seen = new Map<string, DirectoryEntry['kind']>();
    for (const p of Object.keys(state.files)) {
      if (!p.startsWith(prefix) || [...state.unlisted].some((u) => p.startsWith(u))) continue;
      const rest = p.slice(prefix.length).split('/');
      seen.set(rest[0]!, rest.length > 1 ? 'directory' : 'file');
    }
    return [...seen].map(([name, kind]) => ({ name, kind }));
  };
  const read = vi.fn(async (uri: string) => {
    const path = dec(uri).join('/');
    const err = state.failRead(path);
    if (err) throw err;
    const text = state.cache.get(path) ?? state.files[path];
    if (text === undefined) throw new Error(`no file ${path}`);
    return text;
  });
  /** A write as the system keeps it: class sources CRLF, `.json` without its final newline (probe 3, P9). */
  const store = (path: string, text: string) => {
    const err = state.failWrite(path);
    if (err) throw err;
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    if (state.noTransport.has(folder)) {
      // The write's lock replaces what the file held, so its assignment is used up either way.
      const tr = state.pending.get(path);
      state.pending.delete(path);
      if (!tr) throw Object.assign(new Error(`The file ${path.split('/').pop()} could not be written: Object not assigned to a transport`), { code: 1001 });
      if (!state.recordsNothing(path)) {
        state.noTransport.delete(folder);
        state.recorded.set(folder, tr);
      }
    }
    if (state.files[path] === undefined) throw new Error(`no file ${path}: writeFile can't create`);
    const kept = /\.clas\.([a-z]+\.)?abap$/.test(path)
      ? text.replace(/\r?\n/g, '\r\n')
      : path.endsWith('.json')
        ? rebuilt(state.files[path], text)
        : text;
    state.files[path] = kept;
    state.cache.set(path, text);
  };
  /** The main file of an object: `<name>.<type>.<ext>`, a `.json` only when there is nothing else. */
  const mainFile = (name: string, type: string): string | undefined => {
    if (type.startsWith('DEVC')) return packageFile(name);
    const stem = `${name.toLowerCase().replace(/^\/([^/]+)\//, '($1)')}.${type.split('/')[0]!.toLowerCase()}.`;
    const own = Object.keys(state.files).filter((p) => {
      const segs = p.split('/');
      return segs.at(-2)?.toUpperCase() === name.toUpperCase().replace(/^\/([^/]+)\//, '($1)') && segs.at(-1)!.startsWith(stem);
    });
    const single = own.filter((p) => !p.slice(p.lastIndexOf('/') + 1 + stem.length).includes('.'));
    return single.find((p) => !p.endsWith('.json')) ?? single[0];
  };
  /** A package's `<name>.devck.jsonc`. */
  const packageFile = (name: string) =>
    Object.keys(state.files).find((p) => {
      const segs = p.split('/');
      return segs.at(-2) === name.toUpperCase() && segs.at(-1) === `${name.toLowerCase()}.devck.jsonc`;
    });
  /** Where adt-ls files a new object, and the files a create leaves (templates as adt-ls serves them). */
  const CREATED: Record<string, { folder: string; files: (lower: string, description: string) => Record<string, string> }> = {
    CLAS: {
      folder: 'Source Code Library/Classes',
      files: (l, d) => ({
        [`${l}.clas.abap`]: `CLASS ${l} DEFINITION PUBLIC.\r\nENDCLASS.\r\n\r\nCLASS ${l} IMPLEMENTATION.\r\nENDCLASS.\r\n`,
        [`${l}.clas.json`]: metadata(d, { category: 'standard' }),
      }),
    },
    DDLS: {
      folder: 'Core Data Services/Data Definitions',
      files: (l, d) => ({ [`${l}.ddls.acds`]: `define view entity ${l.toUpperCase()} as select from x { key y }`, [`${l}.ddls.json`]: metadata(d) }),
    },
    BDEF: {
      folder: 'Core Data Services/Behavior Definitions',
      files: (l, d) => ({ [`${l}.bdef.abdl`]: '', [`${l}.bdef.json`]: metadata(d) }),
    },
    SRVB: {
      folder: 'Business Services/Service Bindings',
      files: (l, d) => ({ [`${l}.srvb.json`]: metadata(d, { bindingType: 'ODATA V4', bindingTypeCategory: 'ui' }) }),
    },
  };
  const toUri = (path: string) => {
    const segs = path.split('/');
    return ROOT + enc(segs.slice(0, -1)) + encodeURIComponent(segs.at(-1)!);
  };
  const adt = {
    repository: {
      search: vi.fn(async (pattern: string) => {
        const hit = Object.keys(state.files).find((p) => {
          const segs = p.split('/');
          return segs.at(-1) === `${segs.at(-2)?.toLowerCase()}.devck.jsonc` && segs.at(-2) === pattern.toUpperCase();
        });
        return { references: hit ? [{ name: pattern.toUpperCase(), uri: `/sap/bc/adt/packages/${hit}` }] : [] };
      }),
      getLsUri: vi.fn(async (adtUri: string) => {
        const segs = adtUri.replace('/sap/bc/adt/packages/', '').split('/');
        return ROOT + enc(segs.slice(0, -1)) + encodeURIComponent(segs.at(-1)!);
      }),
      readDirectory: vi.fn(async (uri: string) => {
        const dir = dec(uri);
        const err = state.failDir(dir.join('/'));
        if (err) throw err;
        return children(dir);
      }),
      readFile: read,
      abapStat: vi.fn(async (uri: string) => (state.drafts.has(dec(uri).join('/')) ? 'inactive' : 'active')),
      /** One entry per draft file, named after its object (`CLAS/X`, `ZCL_A`), as ONPREM names an include's (P11). */
      listInactive: vi.fn(async () =>
        [...state.drafts].map((p) => {
          const segs = p.split('/');
          return { type: `${segs.at(-1)!.split('.')[1]!.toUpperCase()}/X`, name: segs.at(-2)!, uri: '' };
        }),
      ),
      writeFile: vi.fn(async (uri: string, content: string) => {
        store(dec(uri).join('/'), content);
        state.drafts.add(dec(uri).join('/'));
      }),
    },
    health: () => ({ destination: 'FAKE' }),
    lifecycle: {
      resolveAffUri: vi.fn(async (ref: { name: string; objectType: string; uri?: string }) => {
        if (ref.uri) return ref.uri;
        const path = mainFile(ref.name, ref.objectType);
        if (!path) throw new Error(`Object ${ref.name} (${ref.objectType}) not found via search.`);
        return toUri(path);
      }),
      create: vi.fn(
        async (args: { objectType: string; name: string; packageName: string; description: string; transportRequestNumber?: string }) => {
          const err = state.failCreate(args.name);
          if (err) throw err;
          const type = args.objectType.split('/')[0]!;
          const kind = CREATED[type];
          if (!kind) throw new Error(`fake adt-ls can't create ${args.objectType}`);
          if (Object.keys(state.files).some((p) => p.split('/').includes(args.name))) {
            throw new Error(`${type} ${args.name} already exists`);
          }
          const pkg = packageFile(args.packageName);
          if (!pkg) throw new Error(`Package ${args.packageName} does not exist`);
          if (state.transportable.has(args.packageName) && !args.transportRequestNumber) {
            throw new Error('Request is missing: a transport request is required');
          }
          const folder = `${pkg.slice(0, pkg.lastIndexOf('/'))}/${kind.folder}/${args.name}`;
          for (const [f, text] of Object.entries(kind.files(args.name.toLowerCase(), args.description))) {
            state.files[`${folder}/${f}`] = text;
            state.drafts.add(`${folder}/${f}`);
          }
          return { filePath: toUri(`${folder}/${Object.keys(kind.files('x', ''))[0]!.replace(/^x/, args.name.toLowerCase())}`) };
        },
      ),
      update: vi.fn(async (args: { uri: string; source: string; include?: string }) => {
        let path = dec(args.uri).join('/');
        if (args.include) {
          path = path.replace(/\.abap$/, `.${args.include}.abap`);
          // Writing a class include the class doesn't have yet makes it (assumed; live-checked in M4).
          state.files[path] ??= '';
        }
        store(path, args.source);
        state.drafts.add(path);
      }),
    },
    raw: {
      lsp: vi.fn(async (method: string, params: { uri?: string }) => {
        if (method === 'adtLs/fileSystem/forceRefresh') {
          state.cache.delete(dec(params.uri!).join('/'));
          return null;
        }
        if (method === 'adtLs/cts/transport/assignTransportToObject') {
          const { objectUri, transport } = params as unknown as { objectUri: string; transport: string };
          if (state.requests.has(transport)) state.pending.set(dec(objectUri).join('/'), transport);
          return true;
        }
        if (method === 'adtLs/activation/activate') {
          if (state.failActivation) throw state.failActivation;
          const objectDiagnostics: unknown[] = [];
          for (const uri of (params as unknown as { fileUris: string[] }).fileUris) {
            const main = dec(uri).join('/');
            const folder = main.slice(0, main.lastIndexOf('/') + 1);
            const error = state.activationErrors.get(main);
            if (error) {
              const range = (line: number) => ({ start: { line, character: 2 }, end: { line, character: 9 } });
              const json = main.replace(/\.[^./]+$/, '.json');
              objectDiagnostics.push(
                { fileUri: uri, diagnostic: [{ range: range(error.line), severity: 1, source: 'abapActivation', message: error.message }] },
                { fileUri: toUri(json), diagnostic: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: 'not activated' }] },
                { fileUri: toUri(json), diagnostic: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: error.message }] },
                { fileUri: uri, diagnostic: [{ range: range(error.line), severity: 1, message: error.message }] },
              );
              continue;
            }
            for (const d of [...state.drafts]) if (d.startsWith(folder)) state.drafts.delete(d);
            state.onActivate(folder);
          }
          return { isCheckExecuted: true, isActivationExecuted: true, isGenerationExecuted: true, objectDiagnostics, refreshFileUris: [] };
        }
        throw new Error(`fake adt-ls has no ${method}`);
      }),
    },
  } as unknown as AdtLsClient;
  return { adt, state };
}

/**
 * A `.json` write as adt-ls keeps it: rebuilt from the object's metadata, so keys the written text
 * lacks stay as they were, and without a final newline (probe 3, P9).
 */
function rebuilt(before: string, written: string): string {
  try {
    const old = JSON.parse(before) as Record<string, unknown>;
    const neu = JSON.parse(written) as Record<string, unknown>;
    const header = { ...(old.header as object), ...(neu.header as object) };
    const merged = { ...old, ...neu, ...(old.header || neu.header ? { header } : {}) };
    const text = JSON.stringify(merged, null, 2);
    return text === JSON.stringify(neu, null, 2) ? written.replace(/\n$/, '') : text;
  } catch {
    return written.replace(/\n$/, '');
  }
}

/** A `.json` as adt-ls serves a fresh object: its own key order, no final newline. */
function metadata(description: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ formatVersion: '1', header: { description, originalLanguage: 'en', abapLanguageVersion: 'standard' }, ...fields }, null, 2);
}

/** Deps for the mirror engine: `concurrency` objects at once, a hold that records what it held. */
export function fakeDeps(adt: AdtLsClient, concurrency = 4) {
  const held: string[] = [];
  return {
    held,
    deps: {
      adt,
      concurrency,
      hold: (async (ref, fn) => {
        held.push(`${ref.objectType} ${ref.name}`);
        return fn();
      }) satisfies MirrorDeps['hold'],
      adtLsVersion: '1.1.2',
    },
  };
}

/** A small package: a class with a CRLF source and texts, a data element stub, a subpackage with a view. */
export const PACKAGE = {
  'ZADTPLUS_A/zadtplus_a.devck.jsonc': '{ "package": 1 }',
  'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap': 'CLASS zcl_a DEFINITION.\r\nENDCLASS.\r\n',
  'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.json': '{\n  "header": {}\n}',
  'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.texts.en.properties': 'T01=Hello\r\n',
  'ZADTPLUS_A/Dictionary/Data Elements/ZDE_A/zde_a.dtelde.jsonc': '// stub\n{}',
  'ZADTPLUS_A/ZADTPLUS_A_SUB/zadtplus_a_sub.devck.jsonc': '{}',
  'ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/zi_b.ddls.acds': 'define view entity ZI_B as select from t000 { key mandt }  \r\n',
  'ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/zi_b.ddls.json': '{}',
};
