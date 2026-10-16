/**
 * Read-only live smoke run against one SAP system, through the daemon the way
 * the MCP server and CLI reach it. Run after an ADT for VS Code update or when
 * `adtplus_status` warns about the adt-ls version:
 *
 *   npm run smoke -- --system onprem [--class ZCL_...] [--probe-transport DEVK000000]
 *
 * Without `--class` it takes the first `ZCL_ADTPLUS*` class under `ZADTPLUS_TEST`.
 *
 * Nothing is written. The one write-path step, `transport assign` to a request
 * that does not exist, reaches SAP and changes nothing: for a class already in a
 * request the SDK's lock read-back refuses it; for a class in no open request it
 * is held for a next write that never comes (`onNextWrite`, docs/testing.md). `update` and publish/unpublish cannot be
 * checked without a write and stay manual.
 */
import type { StatusResponse, DaemonRequest, DaemonResponse } from '../../src/daemon/protocol.js';
import { sendCommand } from '../../src/daemon/client.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const system = flag('system');
if (!system) {
  console.error('usage: npm run smoke -- --system <id> [--class <name>] [--probe-transport <tr>]');
  process.exit(2);
}
const probeTransport = flag('probe-transport') ?? `${system.toUpperCase().slice(0, 3)}K000000`;

let failures = 0;

async function call<T>(req: DaemonRequest): Promise<T> {
  const res = await sendCommand<DaemonResponse>(req, { client: 'cli' });
  if (!res.ok) throw new Error((res as { error: string }).error);
  return ('result' in res ? res.result : res) as T;
}

async function step<T>(name: string, fn: () => Promise<T>, summary: (v: T) => string = () => ''): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const value = await fn();
    console.log(`ok    ${name} (${Date.now() - t0} ms) ${summary(value)}`);
    return value;
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name} (${Date.now() - t0} ms) ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** The package three segments above the object folder in a repotree URI (core/placement.ts). */
function packageOf(uri: string, name: string): string | undefined {
  const segs = uri.split('/').map(decodeURIComponent);
  const i = segs.findIndex((s) => s.toUpperCase() === name.toUpperCase());
  return i >= 3 ? segs[i - 3] : undefined;
}

const status = await step('system status', () => call<StatusResponse>({ cmd: 'system.status' }), (s) =>
  `adt-ls ${s.adtLs.version ?? '?'} (${s.adtLs.source}), verified ${s.adtLs.verified}`,
);
for (const w of status?.warnings ?? []) console.log(`      ⚠ ${w}`);

await step('system connect', () => call<{ session: { adtLsVersion?: string } }>({ cmd: 'system.connect', system }), (r) =>
  `adt-ls ${r.session.adtLsVersion ?? '?'}`,
);

// A class inside the write allowlist: the assign probe must get past adt+'s own gate to reach SAP.
type Hit = { name: string; uri: string };
const explicit = flag('class');
const hit = await step(
  'object search',
  async () => {
    const { hits } = await call<{ hits: Hit[] }>({
      cmd: 'object.search',
      system,
      query: explicit ?? 'ZCL_ADTPLUS*',
      objectType: 'CLAS/OC',
      maxResults: 50,
    });
    const found = hits.find((h) => (explicit ? h.name === explicit.toUpperCase() : h.uri.includes('/ZADTPLUS_TEST/')));
    if (!found) throw new Error(`no class ${explicit ?? 'ZCL_ADTPLUS* under ZADTPLUS_TEST'} found; pass --class`);
    return found;
  },
  (h) => h.name,
);
if (!hit) {
  console.log(`\n${failures} step(s) failed`);
  process.exit(1);
}

const ref = { name: hit.name, objectType: 'CLAS/OC' };
const pkg = packageOf(hit.uri, hit.name);

await step('object resolve', () => call<{ uri: string }>({ cmd: 'object.resolve', system, ref }), (r) => r.uri.split('/').slice(-1)[0] ?? '');
type Read = { served?: string; totalLines: number; includes?: string[]; matches?: unknown[] };
await step('object read', () => call<Read>({ cmd: 'object.read', system, ref }), (r) =>
  `${r.totalLines} lines, served ${r.served}, includes ${r.includes?.join(',') || 'none'}`,
);
await step('object read active', () => call<Read>({ cmd: 'object.read', system, ref, version: 'active' }), (r) => `${r.totalLines} lines`);
await step('object read grep', () => call<Read>({ cmd: 'object.read', system, ref, grep: '^\\s*METHOD\\s', context: 0 }), (r) =>
  `${r.matches?.length ?? 0} METHOD lines`,
);
if (pkg) {
  await step('object list', () => call<{ entries: unknown[] }>({ cmd: 'object.list', system, package: pkg }), (r) => `${r.entries.length} entries in ${pkg}`);
  await step('package read', () => call<unknown>({ cmd: 'object.read', system, ref: { name: pkg, objectType: 'DEVC/K' } }), () => pkg);
  await step('transport find', () =>
    call<unknown>({ cmd: 'transport.find', system, ref: { name: hit.name, objectType: 'CLAS/OC' }, package: pkg, isCreation: false }),
  );
} else {
  failures++;
  console.log(`FAIL  package of ${hit.uri} not found`);
}
await step('transport list', () => call<{ total: number }>({ cmd: 'transport.list', system, maxResults: 5 }), (r) => `${r.total} requests`);
await step('transport check', () => call<unknown>({ cmd: 'transport.check', system, ref }));
await step('navigate outline', () => call<unknown>({ cmd: 'navigate.outline', system, ref }));
await step('quality syntax', () => call<unknown>({ cmd: 'quality.syntax', system, ref }));
await step('quality format', () => call<{ engine: string; changed: boolean }>({ cmd: 'quality.format', system, ref }), (r) => `${r.engine}, changed ${r.changed}`);
await step('navigate whereUsed', () => call<unknown>({ cmd: 'navigate.whereUsed', system, ref }));
await step('object lockStatus', () => call<unknown>({ cmd: 'object.lockStatus', system, ref }));

// Refused by the lock read-back (class in a request), held for the next write (class in none), or
// refused because the package records no changes (local). Anything else means the request shape broke.
await step(`transport assign probe (${probeTransport})`, async () => {
  let result: { assigned?: unknown };
  try {
    result = await call<{ assigned?: unknown }>({ cmd: 'transport.assign', system, ref, transport: probeTransport });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/was not assigned/.test(msg)) return 'refused by read-back, as expected';
    if (/needs no transport/.test(msg)) return 'local package: no transport needed, as expected';
    throw err;
  }
  if (result.assigned === 'onNextWrite') return 'class in no open request: held for a next write, nothing changed';
  throw new Error(`${probeTransport} was accepted — it should not exist; check the object's lock`);
}, (m) => m);

console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
process.exit(failures ? 1 : 0);
