import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { Destination } from '../../src/core/destinations.js';
import type { SessionManager } from '../../src/core/session.js';
import type { DaemonProgress, DaemonRequest, DaemonResponse } from '../../src/daemon/protocol.js';
import { createDaemonServer } from '../../src/daemon/server.js';
import { parseAddress } from '../../src/git/address.js';
import { fetchStream } from '../../src/git/fetch.js';
import { realGit } from '../../src/git/git.js';
import { fakeSystem } from '../mirror/fake.js';
import { createHash } from 'node:crypto';
import { RawAdtError } from '../../src/backends/rawadt.js';
import { ThrottledError } from '../../src/daemon/ratelimit.js';

/** The search's type for a mirror type, as ONPREM names them. */
const SEARCH_TYPES: Record<string, string> = { CLAS: 'CLAS/OC', INTF: 'INTF/OI', DDLS: 'DDLS/DF', DTELDE: 'DTEL/DE', PROG: 'PROG/P', FUGR: 'FUGR/F' };

/**
 * The REST side of the fake system for `mirror.changes`: the info-system search lists every
 * object folder (and package) with its package, and an object's metadata carries a `changedAt`
 * taken from its files' content, so any change on the system moves it. As on ONPREM, a function
 * group's own date leaves its includes out; each include has metadata of its own
 * (`…/includes/<name>`, 404 once gone), listed in its `objectstructure` (the main program aside). Text elements answer an etag from the text files alone,
 * as on ONPREM, where a text-only edit moves no date. `failMeta` names keys whose metadata answers 500.
 * `components` puts packages in software components: the search's `comp=` finds their objects, and a
 * package's REST definition (`/sap/bc/adt/packages/<name>`) names it with its super package.
 */
export function fakeRest(sys: ReturnType<typeof fakeSystem>) {
  const failMeta = new Set<string>();
  const components: Record<string, string> = {};
  /** Version feeds by URL (`/sap/bc/adt/oo/classes/zcl_a/includes/main/versions`), newest first as SAP lists them. */
  const versions: Record<string, FakeVersion[]> = {};
  /** Feeds that answer 500, and feeds whose read the rate limit stops. */
  const failFeeds = new Set<string>();
  const throttleFeeds = new Set<string>();
  /** Requests by number, as `transportrequests/<number>` reads them. */
  const requests: Record<string, { owner: string; description: string; releasedLocal?: string }> = {};
  /** The system clock ahead of UTC: the released list's root then carries its local time as `changedAt`. */
  const clock: { offsetMinutes?: number } = {};
  /** The released-in-two-weeks list. */
  const released: Array<{ number: string; owner: string; description: string; releasedLocal?: string; objects: Array<{ pgmid: string; type: string; name: string; deleted?: boolean }> }> = [];
  const objects = () => {
    const folders = new Map<string, { type: string; name: string; package: string; files: string[] }>();
    const packages = new Set(Object.keys(sys.state.files).filter((p) => p.endsWith('.devck.jsonc')).map((p) => p.slice(0, p.lastIndexOf('/'))));
    for (const p of Object.keys(sys.state.files)) {
      const dir = p.slice(0, p.lastIndexOf('/'));
      if (packages.has(dir)) continue;
      const name = dir.split('/').at(-1)!;
      const own = p.split('/').at(-1)!.split('.')[1]!.toUpperCase();
      let pkg = dir;
      while (pkg && !packages.has(pkg)) pkg = pkg.slice(0, pkg.lastIndexOf('/'));
      const entry = folders.get(dir) ?? { type: SEARCH_TYPES[own] ?? own, name, package: pkg.split('/').at(-1)!, files: [] };
      entry.files.push(p);
      folders.set(dir, entry);
    }
    return { folders: [...folders.values()], packages: [...packages].map((p) => p.split('/').at(-1)!) };
  };
  const calls: string[] = [];
  const request = vi.fn(async (_method: string, path: string, opts: { query?: Record<string, string> } = {}) => {
    calls.push(path);
    if (failFeeds.has(path)) return { status: 500, headers: new Headers(), body: '' };
    if (throttleFeeds.has(path)) throw new ThrottledError('throttled', 30_000);
    const history = historyAnswer(path, versions, requests, released, clock);
    if (history) return history;
    const { folders, packages } = objects();
    const pkg = path.match(/^\/sap\/bc\/adt\/packages\/([^/]+)$/);
    if (pkg) {
      const name = decodeURIComponent(pkg[1]!).toUpperCase();
      const dir = Object.keys(sys.state.files).find((p) => p.endsWith(`/${name.toLowerCase()}.devck.jsonc`));
      // Only a package placed in a component reads: the push tests rely on not knowing whether one records changes.
      if (!dir || !(name in components)) return { status: dir ? 500 : 404, headers: new Headers(), body: '' };
      const parent = dir.split('/').slice(0, -2).at(-1) ?? '';
      const body =
        `<pak:package adtcore:name="${name}"><pak:attributes pak:packageType="development"/><pak:superPackage adtcore:name="${parent}"/>` +
        `<pak:transport><pak:softwareComponent pak:name="${components[name] ?? ''}"/></pak:transport></pak:package>`;
      return { status: 200, headers: new Headers(), body };
    }
    if (path.endsWith('/informationsystem/search')) {
      const root = opts.query!.packageName;
      const comp = opts.query!.comp;
      const refs = [
        ...packages.map((p) => `<adtcore:objectReference adtcore:uri="/fake/DEVC/${p}" adtcore:type="DEVC/K" adtcore:name="${p}" adtcore:packageName="${p}"/>`),
        ...folders.map((f) => `<adtcore:objectReference adtcore:uri="/fake/${f.type}/${f.name}#x" adtcore:type="${f.type}" adtcore:name="${f.name}" adtcore:packageName="${f.package}"/>`),
      ].filter((r) =>
        comp !== undefined ? components[r.match(/adtcore:packageName="([^"]*)"/)![1]!] === comp : r.includes(`adtcore:packageName="${root}`),
      ).slice(0, Number(opts.query!.maxResults ?? Infinity));
      return { status: 200, headers: new Headers(), body: `<adtcore:objectReferences>${refs.join('')}</adtcore:objectReferences>` };
    }
    const texts = path.match(/^\/sap\/bc\/adt\/textelements\/(classes|programs|functiongroups)\/([^/]+)$/);
    if (texts) {
      const type = { classes: 'CLAS/OC', programs: 'PROG/P', functiongroups: 'FUGR/F' }[texts[1]!]!;
      const owner = folders.find((x) => x.type === type && x.name.toLowerCase() === decodeURIComponent(texts[2]!));
      if (!owner) return { status: 404, headers: new Headers(), body: '' };
      const files = owner.files.filter((p) => p.includes('.texts.'));
      const etag = createHash('sha1').update(files.map((p) => sys.state.files[p]).join('\0')).digest('hex').toUpperCase();
      return { status: 200, headers: new Headers(), body: `<rept:subobject adtcore:name="symbols"><atom:link href="source/symbols" etag="${etag}A"/></rept:subobject>` };
    }
    const structure = path.match(/^\/fake\/FUGR\/F\/([^/]+)\/objectstructure$/);
    if (structure) {
      const group = folders.find((x) => x.type === 'FUGR/F' && x.name === structure[1]);
      const prefix = `${structure[1]!.toLowerCase()}.fugr.`;
      const includes = (group?.files ?? [])
        .map((p) => p.split('/').at(-1)!)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.reps.abap') && !f.startsWith(`${prefix}sapl`))
        .map((f) => f.slice(prefix.length, -'.reps.abap'.length).toUpperCase());
      const elements = includes.map((i) => `<abapsource:objectStructureElement adtcore:name="${i}" adtcore:type="FUGR/I"/>`);
      return { status: 200, headers: new Headers(), body: `<abapsource:objectStructureElement adtcore:name="${structure[1]}" adtcore:type="FUGR/F">${elements.join('')}` };
    }
    const include = path.match(/^\/fake\/FUGR\/F\/([^/]+)\/includes\/([^/]+)$/);
    if (include) {
      const group = folders.find((x) => x.type === 'FUGR/F' && x.name === include[1]);
      const files = group?.files.filter((p) => p.split('/').at(-1)!.startsWith(`${include[1]!.toLowerCase()}.fugr.${decodeURIComponent(include[2]!)}.reps.`)) ?? [];
      if (files.length === 0) return { status: 404, headers: new Headers(), body: '' };
      const at = createHash('sha1').update(files.map((p) => sys.state.files[p]).join('\0')).digest('hex').slice(0, 12);
      return { status: 200, headers: new Headers(), body: `<x adtcore:changedAt="${at}"/>` };
    }
    const [, , type1, type2, name] = path.split('/');
    const type = type2 && name ? `${type1}/${type2}` : type1!;
    const objName = name ?? type2!;
    if (failMeta.has(`${type} ${objName}`)) return { status: 500, headers: new Headers(), body: '' };
    const f = folders.find((x) => x.type === type && x.name === objName);
    const own = f?.files.filter((p) => !p.includes('.texts.') && !(f.type === 'FUGR/F' && p.includes('.reps.')));
    const hash = own ? createHash('sha1').update(own.map((p) => sys.state.files[p]).join('\0')).digest('hex').slice(0, 12) : 'pkg';
    return { status: 200, headers: new Headers(), body: `<x adtcore:changedAt="${hash}"/>` };
  });
  const expectOk = async (method: string, path: string, context: string, opts: { query?: Record<string, string> } = {}) => {
    const res = await request(method, path, opts);
    if (res.status >= 400) throw new RawAdtError(res.status, undefined, res.body, context);
    return res;
  };
  return { request, expectOk, failMeta, components, calls, versions, failFeeds, throttleFeeds, requests, released, clock };
}

export interface FakeVersion {
  id: string;
  author: string;
  updated: string;
  request?: string;
  description?: string;
  content: string;
}

const ok = (body: string) => ({ status: 200, headers: new Headers(), body });

/** The version feeds, their contents, request reads and the released list (P4, P6), or undefined for any other path. */
function historyAnswer(
  path: string,
  versions: Record<string, FakeVersion[]>,
  requests: Record<string, { owner: string; description: string; releasedLocal?: string }>,
  released: ReturnType<typeof fakeRest>['released'],
  clock: { offsetMinutes?: number },
) {
  const lastChanged = (local?: string) => (local ? ` tm:lastchanged_timestamp="${local}"` : '');
  if (path.endsWith('/versions')) {
    const list = versions[path];
    if (!list) return { status: 404, headers: new Headers(), body: '' };
    const entries = list.map(
      (v) =>
        `<atom:entry><atom:author><atom:name>${v.author}</atom:name></atom:author>` +
        `<atom:content type="text/plain" src="${path}/19700101000000/${v.id}/content"/><atom:id>${v.id}</atom:id>` +
        (v.request
          ? `<atom:link adtcore:name="${v.request}" href="/sap/bc/adt/cts/transportrequests/${v.request}" rel="http://www.sap.com/adt/relations/transport/request" type="application/vnd.sap.adt.transportrequests.v1+xml" title="${v.description ?? ''}"/>`
          : '') +
        `<atom:title>${v.description ?? ''}</atom:title><atom:updated>${v.updated}</atom:updated></atom:entry>`,
    );
    return ok(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>x</atom:title>${entries.join('')}</atom:feed>`);
  }
  const content = path.match(/^(.*\/versions)\/\d+\/(\d{5})\/content$/);
  if (content) {
    const v = versions[content[1]!]?.find((x) => x.id === content[2]);
    return v ? ok(v.content) : { status: 404, headers: new Headers(), body: '' };
  }
  const request = path.match(/^\/sap\/bc\/adt\/cts\/transportrequests\/([A-Z0-9]+)$/);
  if (request) {
    const r = requests[request[1]!];
    if (!r) return { status: 404, headers: new Headers(), body: '' };
    return ok(`<tm:root><tm:request tm:number="${request[1]}" tm:owner="${r.owner}" tm:desc="${r.description}" tm:status="R"${lastChanged(r.releasedLocal)}></tm:request></tm:root>`);
  }
  if (path === '/sap/bc/adt/cts/transportrequests') {
    const body = released.map(
      (r) =>
        `<tm:request tm:number="${r.number}" tm:owner="${r.owner}" tm:desc="${r.description}" tm:status="R"${lastChanged(r.releasedLocal)}>` +
        `<tm:abap_object tm:pgmid="CORR" tm:type="RELE" tm:name="${r.number}T 20261007 060456 ${r.owner}"/>` +
        r.objects.map((o) => `<tm:abap_object tm:pgmid="${o.pgmid}" tm:type="${o.type}" tm:name="${o.name}"${o.deleted ? ' tm:obj_func="D"' : ''}/>`).join('') +
        `<tm:task tm:number="${r.number}T" tm:owner="${r.owner}" tm:status="R"><tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZTASK_ONLY"/></tm:task></tm:request>`,
    );
    // The answer's time in the system's local time, labelled `Z`, as ONPREM sends it.
    const root =
      clock.offsetMinutes === undefined ? '<tm:root>' : `<tm:root adtcore:changedAt="${new Date(Date.now() + clock.offsetMinutes * 60_000).toISOString().slice(0, 19)}Z">`;
    return ok(`${root}<tm:workbench><tm:released>${body.join('')}</tm:released></tm:workbench></tm:root>`);
  }
  return undefined;
}

/**
 * A temp repository and the daemon over a fake system, every request stamped as
 * the git helper's: what the fetch and push tests run against.
 */
export function gitWorld() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-git-')));
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const daemons: Array<{ close(): Promise<void> }> = [];

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  function daemonWith(sys: ReturnType<typeof fakeSystem>, extra: Partial<Destination> = {}) {
    const rest = fakeRest(sys);
    const sessionManager = {
      get: vi.fn(async () => ({ adt: sys.adt, info: { adtLsVersion: '1.1.2' } })),
      withRest: vi.fn(async (_key: string, fn: (r: unknown) => Promise<unknown>) => fn(rest)),
      register: vi.fn((d: Destination) => d.id),
      disposeAll: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const daemon = createDaemonServer({
      sessionManager,
      destinations: {
        onprem: {
          id: 'onprem',
          kind: 'onprem',
          auth: 'basic',
          client: '100',
          systemUrl: 'https://onprem.example',
          extraCaCerts: [],
          writeAllowlist: [],
          allowGitRemote: true,
          ...extra,
        },
      },
      socketPath: path.join(dir, `s${daemons.length}.sock`),
      callLog: null,
      resolveAdtLsPath: () => {
        throw new Error('no adt-ls in this test');
      },
    });
    daemons.push(daemon);
    const send = (req: DaemonRequest, onProgress?: (p: DaemonProgress) => void): Promise<DaemonResponse> =>
      daemon.handleRequest({ ...req, client: 'git', ...(onProgress ? { progress: true } : {}) }, onProgress);
    return { send, sessionManager, rest, socketPath: daemon.socketPath };
  }

  /** One import, its stream fed to fast-import as git would; what the helper said. */
  async function fetchInto(
    send: (req: DaemonRequest) => Promise<DaemonResponse>,
    address = 'onprem/package/ZADTPLUS_A',
    at = '2026-10-07T08:00:00Z',
    /** false: the stream never reaches git, as when fast-import fails. */
    land = true,
  ) {
    const said: string[] = [];
    const stream = await fetchStream({
      send,
      git: realGit(repo),
      gitDir: path.join(repo, '.git'),
      remote: 'origin',
      address: parseAddress(address),
      say: (line) => said.push(line),
      now: () => new Date(at),
    });
    if (land) execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: Buffer.concat(stream) });
    return { said, stream: Buffer.concat(stream).toString() };
  }

  async function cleanup() {
    for (const d of daemons) await d.close();
    rmSync(dir, { recursive: true, force: true });
  }

  return { dir, repo, git, daemonWith, fetchInto, cleanup };
}
