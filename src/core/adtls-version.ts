import { parseAdtLsVersion, resolveAdtLsPath } from '@arc-mcp/adt-ls';

/**
 * The adt-ls release adt+ was verified against. Kept apart from the SDK's own
 * VERIFIED_ADT_LS_VERSION: adt+'s hand-built requests (transport assign,
 * publishService, writeFile by URI) were decoded from the 1.1.2 jars, and a
 * newer vendored SDK can move its constant without those being rechecked.
 * Bump this only after `npm run smoke` passed on both systems.
 */
export const VERIFIED_ADT_LS = '1.1.2';

export interface AdtLsInfo {
  /** Binary the SDK resolves right now (ADT_LS_PATH, vendor/adt-ls/, newest sapse.adt-vscode); null when none is found. */
  path: string | null;
  /** Full version from a live session, else the extension folder's version; null when neither says. */
  version: string | null;
  source: 'session' | 'path' | 'unknown';
  verified: string;
  /** major.minor.patch equals `verified`; null when the version is unknown. */
  match: boolean | null;
  /** Why no binary was found. */
  error?: string;
}

/** `…/sapse.adt-vscode-1.1.2-darwin-arm64/adt-ls/…` → `1.1.2`. */
export function versionFromPath(binPath: string): string | null {
  return binPath.match(/sapse\.adt-vscode-(\d+\.\d+\.\d+)/i)?.[1] ?? null;
}

export function sameRelease(a: string, b: string): boolean {
  const pa = parseAdtLsVersion(a);
  const pb = parseAdtLsVersion(b);
  return !!pa && !!pb && pa.every((n, i) => n === pb[i]);
}

/** What adt-ls adt+ runs on. Never opens a session: a session version is used only when one already exists. */
export function adtLsInfo(opts: { sessionVersion?: string; resolvePath?: () => string } = {}): AdtLsInfo {
  let path: string | null = null;
  let error: string | undefined;
  try {
    path = (opts.resolvePath ?? resolveAdtLsPath)();
  } catch (err) {
    error = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }
  const pathVersion = path ? versionFromPath(path) : null;
  const version = opts.sessionVersion ?? pathVersion;
  return {
    path,
    version,
    source: opts.sessionVersion ? 'session' : pathVersion ? 'path' : 'unknown',
    verified: VERIFIED_ADT_LS,
    match: version ? sameRelease(version, VERIFIED_ADT_LS) : null,
    ...(error ? { error } : {}),
  };
}

export function adtLsWarnings(info: AdtLsInfo): string[] {
  if (info.error) return [`adt-ls not found: ${info.error}`];
  if (info.match === false) {
    return [
      `adt-ls ${info.version} is not the verified ${info.verified}: adt+'s hand-built requests ` +
        '(transport assign, object publish, object update) may break. Run `npm run smoke -- --system <id>` ' +
        'in the adtplus repo before relying on writes.',
    ];
  }
  return [];
}
