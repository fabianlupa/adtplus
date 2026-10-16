import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DaemonRequest, DaemonResponse } from './protocol.js';

/**
 * JSONL record of every daemon request. On by default with metadata only:
 * time, client, command, system, duration and outcome (ADR-005, footprint).
 * `ADTPLUS_LOG=0` turns it off, and then nothing is opened or created.
 *
 * `ADTPLUS_LOG=1` or a file path adds the error text and a digest of the
 * params, for validating chat-client behaviour (an eval reads the readOnly
 * stamp from it). The digest is never a dump: `source` bodies are reduced to a
 * length, secret-looking keys are blanked, long strings are replaced by their
 * length, and the whole digest is size-capped. The session layer (ADR-001,
 * Keychain-sourced) is never logged.
 */

const MAX_STRING = 80;
const MAX_ITEMS = 10;
const MAX_DIGEST_CHARS = 600;
const MAX_ERROR_CHARS = 400;
const SECRET_KEY = /pass|secret|token|cookie|auth|credential|key/i;
/** Keys whose value is content, not a parameter: only its length is logged. */
const CONTENT_KEYS = new Set(['source', 'additionalFields', 'statement']);

/** `metadata`: time, client, cmd, system, duration, ok. `full` adds the error text and the params digest. */
export type CallLogDetail = 'metadata' | 'full';

export interface CallLogTarget {
  path: string;
  detail: CallLogDetail;
}

function defaultCallLogPath(): string {
  return path.join(homedir(), '.cache', 'adtplus', 'calls.jsonl');
}

/**
 * Unset or empty → metadata to the default file next to the daemon state.
 * `0` → off. `1` → full lines to the default file. Any other value → full
 * lines to that file.
 */
export function resolveCallLog(value: string | undefined): CallLogTarget | undefined {
  const v = value?.trim() ?? '';
  if (v === '') return { path: defaultCallLogPath(), detail: 'metadata' };
  if (v === '0') return undefined;
  if (v === '1') return { path: defaultCallLogPath(), detail: 'full' };
  return { path: path.resolve(v), detail: 'full' };
}

function digestValue(key: string, value: unknown, depth: number): unknown {
  if (SECRET_KEY.test(key)) return '<redacted>';
  if (CONTENT_KEYS.has(key)) {
    if (typeof value === 'string') return { len: value.length };
    if (value && typeof value === 'object') return { keys: Object.keys(value).slice(0, MAX_ITEMS) };
    return '<omitted>';
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length <= MAX_STRING ? value : { len: value.length };
  if (Array.isArray(value)) {
    if (depth >= 2) return { items: value.length };
    return {
      items: value.length,
      first: value.slice(0, MAX_ITEMS).map((v) => digestValue(key, v, depth + 1)),
    };
  }
  if (typeof value === 'object') {
    if (depth >= 2) return { keys: Object.keys(value).length };
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_ITEMS)
        .map(([k, v]) => [k, digestValue(k, v, depth + 1)]),
    );
  }
  return `<${typeof value}>`;
}

/** Size-capped digest of a request's parameters (everything but cmd, system, client). */
export function digestParams(req: DaemonRequest): Record<string, unknown> {
  const digest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req)) {
    if (key === 'cmd' || key === 'system' || key === 'client' || key === 'projectConfigs' || value === undefined) continue;
    digest[key] = digestValue(key, value, 0);
  }
  if (JSON.stringify(digest).length > MAX_DIGEST_CHARS) {
    return { truncated: true, keys: Object.keys(digest).slice(0, 20) };
  }
  return digest;
}

export interface CallLog {
  /** `projectFiles`: the project configs the request's system was merged from (ADR-006). */
  record(req: DaemonRequest, res: DaemonResponse, startedAt: number, durationMs: number, projectFiles?: string[]): void;
}

/** Returns null — and touches nothing — when logging is off. Never throws on write failure. */
export function createCallLog(target: CallLogTarget | undefined): CallLog | null {
  if (!target) return null;
  const { path: logPath, detail } = target;
  let dirReady = false;
  return {
    record(req, res, startedAt, durationMs, projectFiles) {
      const line = {
        ts: new Date(startedAt).toISOString(),
        client: req.client ?? null,
        cmd: req.cmd,
        system: 'system' in req ? req.system : undefined,
        ...(projectFiles && projectFiles.length > 0 ? { config: projectFiles } : {}),
        ms: durationMs,
        ok: res.ok,
        ...(detail === 'full'
          ? { error: res.ok ? undefined : res.error.slice(0, MAX_ERROR_CHARS), params: digestParams(req) }
          : {}),
      };
      try {
        if (!dirReady) {
          mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
          dirReady = true;
        }
        appendFileSync(logPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      } catch {
        // Logging must never break a request.
      }
    },
  };
}
