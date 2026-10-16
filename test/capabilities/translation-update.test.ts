import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { batchParts, changeset } from '../../src/backends/odata-ui.js';
import { RawAdtTimeoutError, type RawAdtClient, type RequestOptions } from '../../src/backends/rawadt.js';
import { createProject, deleteProject, parseProjectUpdate, planDefinition, updateProject, type CreateDeps, type UpdateDeps } from '../../src/capabilities/translation-update.js';
import { parseXliff } from '../../src/capabilities/translations.js';
import type { Destination } from '../../src/core/destinations.js';

const METADATA = readFileSync(new URL('./fixtures/translations/metadata.xml', import.meta.url), 'utf8');

interface Unit {
  id: string;
  source: string;
  target?: string;
  maxwidth: number;
}

/**
 * The service with state: one project ZP in ZPKG, pair EN → DE, message class ZADTPLUS_M (none with
 * `noProject`). An upload is kept per pair until a publish applies it; `DELTA` holds the units
 * without a target and the ones listed in `outdated`. Installed languages EN, DE, FR; addable text
 * sources as `addable` gives them.
 */
function fakeService(
  opts: {
    dataElement?: boolean;
    publishStatus?: string;
    lastUploaded?: { at: string; by: string };
    failPublish?: string;
    failCode?: string;
    pairs?: Array<[string, string]>;
    noProject?: boolean;
    addable?: Array<{ type: string; name: string }>;
  } = {},
) {
  const units: Unit[] = opts.dataElement
    ? [
        { id: 'DATA_ELEMENT:ZDE:SHORT_FIELD_LABEL', source: 'Rating', maxwidth: 10 },
        { id: 'DATA_ELEMENT:ZDE:LONG_FIELD_LABEL', source: 'Recipe Rating', maxwidth: 40 },
        { id: 'DATA_ELEMENT:ZDE:HEADING_FIELD_LABEL', source: '', maxwidth: 55 },
      ]
    : [
    { id: 'MESSAGE_CLASS:ZADTPLUS_M:SHORT_TEXT:001', source: 'Order saved', target: 'Auftrag gesichert', maxwidth: 73 },
    { id: 'MESSAGE_CLASS:ZADTPLUS_M:SHORT_TEXT:002', source: 'Order deleted', maxwidth: 20 },
    { id: 'MESSAGE_CLASS:ZADTPLUS_M:SHORT_TEXT:003', source: 'Order changed', target: 'Auftrag geaendert', maxwidth: 73 },
      ];
  const outdated = new Set(['MESSAGE_CLASS:ZADTPLUS_M:SHORT_TEXT:003']);
  const state = { publishStatus: opts.publishStatus ?? 'SUCCESS', lastUploaded: opts.lastUploaded, pending: undefined as string | undefined };
  const project = opts.noProject
    ? undefined
    : { description: 'Probe', pkg: 'ZPKG', sources: [{ Type: 'MESSAGE_CL', Name: 'ZADTPLUS_M' }], pairs: [...(opts.pairs ?? [['EN', 'DE']])] as Array<[string, string]> };
  let current = project;
  const unquote = (v: string) => v.slice(1, -1).replace(/''/g, "'");
  const batches: string[] = [];
  const xliff = (list: Unit[]) =>
    '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2"><file datatype="plaintext" original="ZP" source-language="en-US" target-language="de-DE"><body>' +
    (opts.dataElement ? '<group datatype="x-DATA_ELEMENT" resname="ZDE">' : '<group datatype="x-MESSAGE_CLASS" resname="ZADTPLUS_M">') +
    list
      .map((u) => `<trans-unit id="${u.id}" maxwidth="${u.maxwidth}" size-unit="char"><source>${u.source}</source>${u.target !== undefined ? `<target>${u.target}</target>` : ''}<note>n</note></trans-unit>`)
      .join('') +
    '</group></body></file></xliff>';
  const json = (d: unknown) => ({ status: 200, headers: new Headers(), body: JSON.stringify({ d }) });
  const part = (status: number, body: string) => `--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${body}\r\n`;
  const request = vi.fn(async (method: string, path: string, req: RequestOptions = {}) => {
    if (path.endsWith('/$metadata')) return { status: 200, headers: new Headers(), body: METADATA };
    if (path.endsWith('/getInstalledLanguages')) return json({ results: ['EN', 'DE', 'FR'].map((keyValue) => ({ keyValue })) });
    if (path.endsWith('/getAddableTextSources')) return json({ results: opts.addable ?? [] });
    if (path.includes('/Project(')) {
      if (!current) return { status: 404, headers: new Headers(), body: JSON.stringify({ error: { code: '/IWBEP/CM_MGW_RT/020', message: { value: 'Resource not found' } } }) };
      return json({
        ID: 'ZP',
        Description: current.description,
        PackageName: current.pkg,
        to_TextSource: { results: current.sources },
        to_Translation: {
          results: current.pairs.map(([SourceLanguage, TargetLanguage]) => ({
            SourceLanguage,
            TargetLanguage,
            PublishStatus: state.publishStatus,
            LastUploadedAt: state.lastUploaded ? `/Date(${Date.parse(state.lastUploaded.at)}+0000)/` : null,
            LastUploadedBy: state.lastUploaded?.by ?? '',
          })),
        },
      });
    }
    if (path.endsWith('/downloadTranslationFile')) {
      const delta = req.query?.downloadType === "'DELTA'";
      return json({ downloadTranslationFile: { fileContent: xliff(delta ? units.filter((u) => u.target === undefined || outdated.has(u.id)) : units) } });
    }
    if (method === 'POST' && path.endsWith('/$batch')) {
      batches.push(req.body!);
      const ops = [...req.body!.matchAll(/POST (\w+)\?(\S*) HTTP/g)].map((m) => ({
        name: m[1]!,
        params: Object.fromEntries(new URLSearchParams(m[2]!).entries()),
      }));
      const answers: string[] = [];
      for (const op of ops) {
        if (op.name === 'uploadTranslationFile') {
          state.pending = op.params.fileContent!.slice(1, -1).replace(/''/g, "'");
          state.publishStatus = 'PREPARED';
          state.lastUploaded = { at: '2026-10-12T20:00:00.000Z', by: 'Me' };
        } else if (op.name === 'publishTranslation') {
          if (opts.failPublish) return { status: 202, headers: new Headers(), body: `${part(400, JSON.stringify({ error: { code: opts.failCode ?? 'SMTR/069', message: { value: opts.failPublish } } }))}--b--` };
          for (const u of parseXliff(state.pending!).units) {
            const unit = units.find((x) => x.id === u.id)!;
            unit.target = u.target;
            outdated.delete(u.id);
          }
          state.publishStatus = 'SUCCESS';
        } else if (op.name === 'createProject') {
          current = { description: unquote(op.params.Description!), pkg: unquote(op.params.PackageName!), sources: [], pairs: [] };
        } else if (op.name === 'updateProject') {
          current!.description = unquote(op.params.Description!);
        } else if (op.name === 'addTextSources') {
          for (const t of JSON.parse(unquote(op.params.textSources!)) as Array<{ type: string; name: string }>) current!.sources.push({ Type: t.type, Name: t.name });
        } else if (op.name === 'createTranslation') {
          current!.pairs.push([unquote(op.params.sourceLanguage!), unquote(op.params.targetLanguage!)]);
        } else if (op.name === 'deleteProject') {
          current = undefined;
        }
        answers.push(part(200, JSON.stringify({ d: { [op.name]: { IsInvalid: false } } })));
      }
      return { status: 202, headers: new Headers(), body: `${answers.join('')}--b--` };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { rest: { request, baseUrl: 'https://host.example' } as unknown as RawAdtClient, request, batches, units, project: () => current };
}

const destination = (writeAllowlist: Destination['writeAllowlist'] = ['ZPKG']): Destination => ({
  id: 'cloud-erp',
  kind: 'cloud',
  auth: 'reentrance',
  client: '100',
  systemUrl: 'https://cloud-erp.example',
  extraCaCerts: [],
  writeAllowlist,
} as unknown as Destination);

function deps(rest: RawAdtClient, over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    rest,
    destination: destination(),
    lookupChain: async (pkg) => [pkg],
    assertObjectWritable: async () => undefined,
    ownUploads: new Map(),
    ...over,
  };
}

const write = (key: string, target: string, extra: Record<string, unknown> = {}) => ({ language: 'de', objectType: 'MSAG/N', name: 'ZADTPLUS_M', key, target, ...extra });
const posts = (request: ReturnType<typeof fakeService>['request']) => request.mock.calls.filter((c) => c[0] === 'POST');

describe('parseProjectUpdate', () => {
  it('lists every finding before any call', () => {
    expect(() =>
      parseProjectUpdate({
        name: 'x',
        translations: [{ language: 'deutsch', objectType: 'MSAG/N', name: 'ZADTPLUS_M', key: 'SHORT_TEXT:001', target: ' ', colour: 'red' }, { language: 'de' }],
      }),
    ).toThrow(
      /unknown key "name"[\s\S]*unknown key "colour"[\s\S]*not a language AFF lists[\s\S]*an empty "target" publishes an empty text[\s\S]*translations\[1\]: "objectType" is required/,
    );
    expect(() => parseProjectUpdate({ translations: [] })).toThrow(/non-empty list/);
    expect(parseProjectUpdate({ translations: [write('SHORT_TEXT:001', 'x')] }).translations).toHaveLength(1);
  });
});

describe('updateProject', () => {
  it('uploads only the sent units in one changeset, publishes in the next, returns the previous targets, verifies', async () => {
    const { rest, request, batches } = fakeService();
    const r = await updateProject(deps(rest), {
      name: 'zp',
      objectType: 'TRPR',
      update: { translations: [write('SHORT_TEXT:002', 'Auftrag gelöscht'), write('SHORT_TEXT:003', 'Auftrag geändert', { source: 'Order changed', status: 'outdated' })] },
    });
    expect(r.written).toEqual([
      { sourceLanguage: 'en', language: 'de', objectType: 'MSAG/N', name: 'ZADTPLUS_M', key: 'SHORT_TEXT:002', target: 'Auftrag gelöscht' },
      { sourceLanguage: 'en', language: 'de', objectType: 'MSAG/N', name: 'ZADTPLUS_M', key: 'SHORT_TEXT:003', previous: 'Auftrag geaendert', target: 'Auftrag geändert' },
    ]);
    expect(r.notVerified).toBeUndefined();
    expect(r.remaining).toBeUndefined();
    expect(batches).toHaveLength(2);
    const upload = decodeURIComponent(batches[0]!.match(/fileContent=([^&\s]*)/)![1]!);
    expect(upload).not.toContain('SHORT_TEXT:001');
    expect(upload).toContain('<target>Auftrag gelöscht</target>');
    expect(upload).toContain('tool-id="adtplus"');
    expect(batches[0]).not.toContain('transport=');
    expect(batches[1]).toMatch(/POST publishTranslation\?ProjectID=%27ZP%27&ProjectType=%275%27&SourceLanguage=%27EN%27&TargetLanguage=%27DE%27 HTTP/);
    // each changeset weighs its operations in the rate limit
    expect(posts(request).map((c) => c[2]?.units)).toEqual([1, 1]);
  });

  it('refuses unknown texts, a target over maxwidth, a changed source, a duplicate: all listed, nothing sent', async () => {
    const { rest, request } = fakeService();
    const err = await updateProject(deps(rest), {
      name: 'ZP',
      objectType: 'TRPR',
      update: {
        translations: [
          write('SHORT_TEXT:009', 'x'),
          write('SHORT_TEXT:002', 'Der Auftrag wurde endgültig gelöscht'),
          write('SHORT_TEXT:001', 'y', { source: 'Order stored' }),
          write('SHORT_TEXT:001', 'z'),
        ],
      },
    }).catch((e: Error) => e.message);
    expect(err).toMatch(/nothing was sent/);
    expect(err).toMatch(/SHORT_TEXT:009: no such text in project ZP \(SAP would ignore it\)/);
    expect(err).toMatch(/SHORT_TEXT:002: the target has 36 characters, SAP takes at most 20 \(it would cut it\)/);
    expect(err).toMatch(/SHORT_TEXT:001: "source" is read-only, now "Order saved", sent "Order stored"/);
    expect(err).toMatch(/SHORT_TEXT:001: given twice/);
    expect(posts(request)).toHaveLength(0);
  });

  it('refuses before downloading when the project\'s or an object\'s package is outside the allowlist', async () => {
    const { rest, request } = fakeService();
    await expect(updateProject(deps(rest, { destination: destination(['ZOTHER']) }), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } })).rejects.toThrow(
      /package "ZPKG" is not in the write allowlist/,
    );
    await expect(
      updateProject(deps(rest, { assertObjectWritable: async () => Promise.reject(new Error('package "ZFOREIGN" is not in the write allowlist')) }), {
        name: 'ZP',
        objectType: 'TRPR',
        update: { translations: [write('SHORT_TEXT:002', 'x')] },
      }),
    ).rejects.toThrow(/MSAG\/N ZADTPLUS_M: package "ZFOREIGN" is not in the write allowlist/);
    // The definition's and the allowlist's findings come in one refusal.
    await expect(
      updateProject(deps(rest, { destination: destination(['ZOTHER']) }), {
        name: 'ZP',
        objectType: 'TRPR',
        update: { package: 'ZOTHER', translations: [write('SHORT_TEXT:002', 'x', { language: 'fr' })] },
      }),
    ).rejects.toThrow(/package is read-only, now "ZPKG"[\s\S]*package "ZPKG" is not in the write allowlist[\s\S]*fr: project ZP has no language pair/);
    await expect(
      updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [{ ...write('K', 'x'), objectType: 'APPLICATION_LOG_OBJECT' }] } }),
    ).rejects.toThrow(/can't tell the package of this type/);
    expect(request.mock.calls.some((c) => String(c[1]).endsWith('/downloadTranslationFile'))).toBe(false);
    expect(posts(request)).toHaveLength(0);
  });

  it('refuses a pair someone else uploaded and didn\'t publish; overwrites one it left itself', async () => {
    const lastUploaded = { at: '2026-10-12T19:00:00.000Z', by: 'Someone' };
    const other = fakeService({ publishStatus: 'PREPARED', lastUploaded });
    await expect(updateProject(deps(other.rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } })).rejects.toThrow(
      /en→de: an upload by Someone at 2026-10-12T19:00:00.000Z is not published yet/,
    );
    const own = fakeService({ publishStatus: 'PREPARED', lastUploaded });
    const ownUploads = new Map([['ZP EN DE', { at: '2026-10-12T19:00:00.000Z' }]]);
    await updateProject(deps(own.rest, { ownUploads }), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } });
    expect(ownUploads.size).toBe(0);
  });

  it('fails closed on a PREPARED pair without an upload time; replaces its own with fewer texts (SAP replaces an upload)', async () => {
    const none = fakeService({ publishStatus: 'PREPARED' });
    await expect(
      updateProject(deps(none.rest, { ownUploads: new Map() }), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } }),
    ).rejects.toThrow(/an upload by someone at an unknown time is not published yet/);
    const lastUploaded = { at: '2026-10-12T19:00:00.000Z', by: 'Me' };
    const own = fakeService({ publishStatus: 'PREPARED', lastUploaded });
    const ownUploads = new Map([['ZP EN DE', { at: lastUploaded.at }]]);
    const r = await updateProject(deps(own.rest, { ownUploads }), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } });
    expect(r.written).toEqual([expect.objectContaining({ key: 'SHORT_TEXT:002', target: 'x' })]);
  });

  it('counts a target in UTF-16 code units, as ABAP does', async () => {
    const { rest } = fakeService();
    // 19 characters and an emoji: 21 code units, maxwidth 20.
    await expect(
      updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', `${'a'.repeat(19)}😀`)] } }),
    ).rejects.toThrow(/the target has 21 characters, SAP takes at most 20/);
  });

  it('a failed read after the publish keeps the result: the texts are live, with their previous targets', async () => {
    const service = fakeService();
    const real = service.request.getMockImplementation()!;
    let published = false;
    service.request.mockImplementation(async (method: string, path: string, req?: RequestOptions) => {
      if (published && path.endsWith('/downloadTranslationFile')) throw new Error('socket hang up');
      const res = await real(method, path, req);
      if (method === 'POST' && req?.body?.includes('publishTranslation')) published = true;
      return res;
    });
    const r = await updateProject(deps(service.rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:003', 'neu')] } });
    expect(r.written).toEqual([expect.objectContaining({ key: 'SHORT_TEXT:003', previous: 'Auftrag geaendert', target: 'neu' })]);
    expect(r.notVerified).toEqual(['en→de: published, but the read to verify it failed: socket hang up']);
  });

  it("a lost connection on the publish says it's unknown, keeps SAP's error type, and names the previous targets", async () => {
    const service = fakeService();
    const real = service.request.getMockImplementation()!;
    service.request.mockImplementation(async (method: string, path: string, req?: RequestOptions) => {
      if (method === 'POST' && req?.body?.includes('publishTranslation')) throw new Error('ECONNRESET');
      return real(method, path, req);
    });
    await expect(
      updateProject(deps(service.rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:003', 'neu')] } }),
    ).rejects.toThrow(/whether the publish reached SAP is unknown.*"SHORT_TEXT:003","Auftrag geaendert"/);
  });

  it("a timeout says unknown on the changeset itself, but 'nothing' when the CSRF fetch before it timed out", async () => {
    for (const [err, expected] of [
      [new RawAdtTimeoutError('POST', '/sap/opu/odata/sap/UI_SMTR_PROJECT/$batch', 120_000), /whether the publish reached SAP is unknown/],
      [new RawAdtTimeoutError('GET', '/sap/bc/adt/core/discovery', 120_000), /uploaded into ZP but not published, no text changed/],
    ] as const) {
      const service = fakeService();
      const real = service.request.getMockImplementation()!;
      service.request.mockImplementation(async (method: string, path: string, req?: RequestOptions) => {
        if (method === 'POST' && req?.body?.includes('publishTranslation')) throw err;
        return real(method, path, req);
      });
      await expect(
        updateProject(deps(service.rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:003', 'neu')] } }),
      ).rejects.toThrow(expected);
    }
  });

  it('a failed publish leaves the upload, says so, and lets the next update replace it', async () => {
    const { rest } = fakeService({ failPublish: 'No file has been uploaded.' });
    const ownUploads = new Map<string, { at: string }>();
    await expect(updateProject(deps(rest, { ownUploads }), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } })).rejects.toThrow(
      /uploaded into ZP but not published, no text changed .*SMTR\/069/,
    );
    expect(ownUploads.get('ZP EN DE')).toEqual({ at: '2026-10-12T20:00:00.000Z' });
  });

  it('asks for an open request once the project\'s was released', async () => {
    const { rest } = fakeService({ failPublish: 'Transport DEVK900777 is not modifiable.', failCode: 'SMTR/023' });
    await expect(updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } })).rejects.toThrow(
      /SAP wants an open request for this project \(its own was released\): pass "transport"\. uploaded into ZP but not published/,
    );
  });

  it('needs sourceLanguage when two pairs lead into the language; a missing pair is refused', async () => {
    const { rest } = fakeService({ pairs: [['EN', 'DE'], ['FR', 'DE']] });
    await expect(updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x')] } })).rejects.toThrow(/2 pairs into it .* give "sourceLanguage"/);
    await expect(updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [write('SHORT_TEXT:002', 'x', { language: 'fr' })] } })).rejects.toThrow(
      /fr: project ZP has no language pair into it/,
    );
  });

  it("accepts a read's definition keys unchanged, refuses changed read-only ones", async () => {
    const { rest, batches } = fakeService();
    await expect(
      updateProject(deps(rest), {
        name: 'ZP',
        objectType: 'TRPR',
        update: {
          textSources: [{ type: 'MESSAGE_CL', name: 'ZADTPLUS_M', objectType: 'DTEL/DE' }],
          languages: [{ source: 'en', target: 'de', publishStatus: 'PREPARED' }],
          translations: [write('SHORT_TEXT:002', 'x')],
        },
      }),
    ).rejects.toThrow(/MESSAGE_CL ZADTPLUS_M: "objectType" is read-only, now "MSAG\/N"[\s\S]*en→de: "publishStatus" is read-only, now "SUCCESS"/);
    const r = await updateProject(deps(rest), {
      name: 'ZP',
      objectType: 'TRPR',
      update: {
        header: { description: 'Probe' },
        package: 'zpkg',
        textSources: [{ type: 'MESSAGE_CL', name: 'ZADTPLUS_M', objectType: 'MSAG/N' }],
        languages: [{ source: 'en', target: 'de', publishStatus: 'SUCCESS', counts: { missing: 1 } }],
        translations: [write('SHORT_TEXT:002', 'x')],
      },
    });
    expect(r.written).toHaveLength(1);
    expect(r.changed).toBeUndefined();
    expect(batches).toHaveLength(2);
  });

  it('changes the description and adds sources and pairs in one changeset before the texts', async () => {
    const { rest, batches, project } = fakeService({ addable: [{ type: 'DATA_ELEM', name: 'ZDE' }] });
    const r = await updateProject(deps(rest), {
      name: 'ZP',
      objectType: 'TRPR',
      update: {
        header: { description: 'New' },
        textSources: [{ type: 'MESSAGE_CL', name: 'ZADTPLUS_M' }, { objectType: 'DTEL/DE', name: 'zde' }],
        languages: [{ source: 'en', target: 'de' }, { source: 'en', target: 'fr' }],
        translations: [write('SHORT_TEXT:002', 'x')],
      },
    });
    expect(r.changed).toEqual({
      description: { previous: 'Probe', description: 'New' },
      textSources: [{ type: 'DATA_ELEM', name: 'ZDE', objectType: 'DTEL/DE' }],
      languages: [{ source: 'en', target: 'fr' }],
    });
    expect(r.written).toHaveLength(1);
    expect(batches).toHaveLength(3);
    expect([...batches[0]!.matchAll(/POST (\w+)\?/g)].map((m) => m[1])).toEqual(['updateProject', 'addTextSources', 'createTranslation']);
    expect(batches[0]).not.toContain('MESSAGE_CL');
    expect(project()).toMatchObject({ description: 'New', pairs: [['EN', 'DE'], ['EN', 'FR']] });
  });

  it('a definition change alone is verified by a read', async () => {
    const { rest, batches } = fakeService();
    const r = await updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { languages: [{ source: 'en', target: 'fr' }] } });
    expect(r).toMatchObject({ changed: { languages: [{ source: 'en', target: 'fr' }] }, written: [] });
    expect(r.notVerified).toBeUndefined();
    expect(batches).toHaveLength(1);
  });

  it('refuses a malformed source, a pair into its own language, texts into no pair: nothing sent, SAP\'s lists not read', async () => {
    const { rest, request } = fakeService();
    const err = await updateProject(deps(rest), {
      name: 'ZP',
      objectType: 'TRPR',
      update: {
        textSources: [{ type: 'DATA_ELEM', name: 'ZNOPE' }, { objectType: 'TABL/DT', name: 'ZT' }],
        languages: [{ source: 'en', target: 'en' }],
        translations: [write('SHORT_TEXT:002', 'x', { language: 'fr' })],
      },
    }).catch((e: Error) => e.message);
    expect(err).toMatch(/nothing was sent/);
    expect(err).toMatch(/give "type" and "name" as a read shows them, or "objectType" and "name" of a type adt\+ maps/);
    expect(err).toMatch(/en→en: source and target are the same/);
    expect(err).toMatch(/fr: project ZP has no language pair into it; add it through "languages"/);
    expect(request.mock.calls.some((c) => /getInstalledLanguages|getAddableTextSources/.test(String(c[1])))).toBe(false);
    expect(posts(request)).toHaveLength(0);
  });

  it("refuses a language SAP doesn't have and a source it doesn't offer; a list it can't read is a finding too", async () => {
    const { rest, request } = fakeService();
    const err = await updateProject(deps(rest), {
      name: 'ZP',
      objectType: 'TRPR',
      update: { textSources: [{ type: 'DATA_ELEM', name: 'ZNOPE' }], languages: [{ source: 'en', target: 'ja' }] },
    }).catch((e: Error) => e.message);
    expect(err).toMatch(/language ja is not installed on cloud-erp[\s\S]*text source DATA_ELEM ZNOPE can't be added: SAP doesn't offer it/);
    expect(posts(request)).toHaveLength(0);
    const real = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, path: string, req?: RequestOptions) => {
      if (path.endsWith('/getInstalledLanguages')) throw new Error('socket hang up');
      return real(method, path, req);
    });
    await expect(updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { languages: [{ source: 'en', target: 'fr' }] } })).rejects.toThrow(
      /nothing was sent:\n- SAP's list of installed languages couldn't be read: socket hang up/,
    );
  });

  it('writes texts into a pair the same update adds, checked once the definition changeset made it (ADR-019 §5.3)', async () => {
    const { rest, batches } = fakeService();
    const r = await updateProject(deps(rest), {
      name: 'ZP',
      objectType: 'TRPR',
      update: { languages: [{ source: 'en', target: 'fr' }], translations: [write('SHORT_TEXT:002', 'Commande supprimée', { language: 'fr' })] },
    });
    expect(r.changed).toEqual({ languages: [{ source: 'en', target: 'fr' }] });
    expect(r.written).toEqual([expect.objectContaining({ language: 'fr', key: 'SHORT_TEXT:002', target: 'Commande supprimée' })]);
    expect([...batches.map((b) => [...b.matchAll(/POST (\w+)\?/g)].map((m) => m[1]))]).toEqual([['createTranslation'], ['uploadTranslationFile'], ['publishTranslation']]);
    expect(batches[2]).toContain('TargetLanguage=%27FR%27');
  });

  it("a new pair's text that fails its check is refused after the definition changed, and says so", async () => {
    const { rest, batches } = fakeService();
    await expect(
      updateProject(deps(rest), {
        name: 'ZP',
        objectType: 'TRPR',
        update: { languages: [{ source: 'en', target: 'fr' }], translations: [write('SHORT_TEXT:009', 'x', { language: 'fr' })] },
      }),
    ).rejects.toThrow(/project ZP's definition was changed .*, but no text was written; the new pairs' texts were refused:\n- en→fr MSAG\/N ZADTPLUS_M SHORT_TEXT:009: no such text/);
    expect(batches).toHaveLength(1);
  });
});

describe('planDefinition', () => {
  const project = { description: 'P', package: 'ZPKG', textSources: [{ type: 'PACKAGE', name: 'ZPKG' }], languages: [] };

  it('keeps one of each new source and pair, maps ADT types, refuses extra keys on a new pair', () => {
    const plan = planDefinition(project, {
      textSources: [{ objectType: 'DEVC/K', name: 'zpkg' }, { objectType: 'CLAS/OC', name: 'zcl_x' }, { type: 'TEXT_POOL', name: 'CL_ZCL_X' }],
      languages: [{ source: 'en', target: 'de' }, { source: 'en', target: 'de' }, { source: 'en', target: 'fr', publishStatus: 'SUCCESS' }],
    });
    expect(plan.newSources).toEqual([{ type: 'TEXT_POOL', name: 'CL_ZCL_X' }]);
    expect(plan.newPairs).toEqual([{ source: 'EN', target: 'DE' }]);
    expect(plan.findings).toEqual(['new language pair en→fr: only "source" and "target", not "publishStatus"']);
  });

  it('checks the description, an objectType that contradicts the type, unknown keys', () => {
    const plan = planDefinition(project, {
      header: { description: 'x'.repeat(61) },
      textSources: [{ type: 'MESSAGE_CL', name: 'ZM', objectType: 'DTEL/DE' }, { type: 'MESSAGE_CL', name: 'ZM2', colour: 'red' }],
    });
    expect(plan.findings).toEqual([
      'header.description takes 1 to 60 characters',
      'text source MESSAGE_CL ZM: "objectType" DTEL/DE isn\'t that type\'s',
      'text source MESSAGE_CL ZM2: unknown "colour"',
    ]);
  });
});

function createDeps(rest: RawAdtClient, over: Partial<CreateDeps> = {}): CreateDeps {
  return { rest, destination: destination(), lookupChain: async (pkg) => [pkg], recordsChanges: async () => true, ...over };
}

describe('createProject', () => {
  const input = { name: 'zp', objectType: 'TRPR', package: 'zpkg', description: 'Probe', transport: 'devk900771' };

  it('creates the project alone, then adds sources and pairs in one changeset, and reads it back', async () => {
    const { rest, batches } = fakeService({ noProject: true, addable: [{ type: 'MESSAGE_CL', name: 'ZADTPLUS_M' }] });
    const r = await createProject(createDeps(rest), {
      ...input,
      properties: { textSources: [{ objectType: 'MSAG/N', name: 'zadtplus_m' }], languages: [{ source: 'en', target: 'de' }] },
    });
    expect(r).toEqual({
      name: 'ZP',
      objectType: 'TRPR',
      package: 'ZPKG',
      description: 'Probe',
      textSources: [{ type: 'MESSAGE_CL', name: 'ZADTPLUS_M', objectType: 'MSAG/N' }],
      languages: [{ source: 'en', target: 'de' }],
      transport: 'DEVK900771',
      via: 'odata-ui',
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatch(/POST createProject\?ID=%27ZP%27&Type=%275%27&Name=%27ZP%27&Description=%27Probe%27&PackageName=%27ZPKG%27&transport=%27DEVK900771%27 HTTP/);
    expect([...batches[1]!.matchAll(/POST (\w+)\?/g)].map((m) => m[1])).toEqual(['addTextSources', 'createTranslation']);
  });

  it('refuses before any call: a bad name or description, translations, a different header.description', async () => {
    const { rest, request } = fakeService({ noProject: true });
    const err = await createProject(createDeps(rest), {
      ...input,
      name: 'Z-P',
      description: ' ',
      properties: { header: { description: 'Other' }, translations: [write('SHORT_TEXT:001', 'x')] },
    }).catch((e: Error) => e.message);
    expect(err).toMatch(/the create was refused, nothing was sent/);
    expect(err).toMatch(/"Z-P" is not a project name SAP takes/);
    expect(err).toMatch(/"description" takes 1 to 60 characters/);
    expect(err).toMatch(/"translations" can't come with the create/);
    expect(err).toMatch(/"header.description" differs from "description"/);
    expect(request).not.toHaveBeenCalled();
  });

  it('needs a request where the package records changes; refuses a missing package, a project that exists, a language not installed', async () => {
    const none = fakeService({ noProject: true });
    await expect(createProject(createDeps(none.rest), { ...input, transport: undefined })).rejects.toThrow(/package ZPKG records changes: the project needs a request, pass "transport"/);
    await expect(createProject(createDeps(none.rest, { recordsChanges: async () => undefined }), input)).rejects.toThrow(/package ZPKG does not exist on cloud-erp/);
    await expect(createProject(createDeps(none.rest, { destination: destination(['ZOTHER']) }), input)).rejects.toThrow(/not in the write allowlist/);
    await expect(createProject(createDeps(none.rest), { ...input, properties: { languages: [{ source: 'en', target: 'ja' }] } })).rejects.toThrow(/language ja is not installed/);
    expect(posts(none.request)).toHaveLength(0);
    const exists = fakeService();
    await expect(createProject(createDeps(exists.rest), input)).rejects.toThrow(/translation project ZP already exists on cloud-erp/);
    expect(posts(exists.request)).toHaveLength(0);
  });

  it('sends no transport with the fill: the project\'s request records it', async () => {
    const { rest, batches } = fakeService({ noProject: true });
    await createProject(createDeps(rest), { ...input, properties: { languages: [{ source: 'en', target: 'de' }] } });
    expect(batches[0]).toContain('transport=%27DEVK900771%27');
    expect(batches[1]).not.toContain('transport=');
  });

  it("takes empty properties; a create's shape errors say create", () => {
    expect(parseProjectUpdate({}, 'create')).toEqual({});
    expect(() => parseProjectUpdate({ colour: 1 }, 'create')).toThrow(/^the create was refused, nothing was sent/);
  });

  it('a local package needs no request', async () => {
    const { rest, batches } = fakeService({ noProject: true });
    const r = await createProject(createDeps(rest, { recordsChanges: async () => false }), { ...input, transport: undefined });
    expect(r.transport).toBeUndefined();
    expect(batches[0]).not.toContain('transport=');
  });

  it("names the project left behind when SAP doesn't offer a source", async () => {
    const { rest, batches, project } = fakeService({ noProject: true });
    await expect(createProject(createDeps(rest), { ...input, properties: { textSources: [{ objectType: 'MSAG/N', name: 'ZNOPE' }] } })).rejects.toThrow(
      /translation project ZP was created in ZPKG, without text sources or language pairs; delete it or add them in an update:\n- text source MESSAGE_CL ZNOPE can't be added/,
    );
    expect(batches).toHaveLength(1);
    expect(project()).toBeDefined();
  });
});

const deleteDeps = (rest: RawAdtClient, over: Partial<CreateDeps & UpdateDeps> = {}) => ({ ...createDeps(rest, over), ownUploads: new Map(), ...over });

describe('deleteProject', () => {
  it('deletes the pairs, the sources and the project in one changeset', async () => {
    const { rest, batches, project } = fakeService({ pairs: [['EN', 'DE'], ['EN', 'FR']] });
    const r = await deleteProject(deleteDeps(rest), { name: 'zp', objectType: 'TRPR', transport: 'devk900771' });
    expect(r).toEqual({
      name: 'ZP',
      objectType: 'TRPR',
      textSources: [{ type: 'MESSAGE_CL', name: 'ZADTPLUS_M', objectType: 'MSAG/N' }],
      languages: [{ source: 'en', target: 'de' }, { source: 'en', target: 'fr' }],
      notes: ['the translations it published stay in the objects'],
      via: 'odata-ui',
    });
    expect(batches).toHaveLength(1);
    expect([...batches[0]!.matchAll(/POST (\w+)\?/g)].map((m) => m[1])).toEqual(['deleteTranslation', 'deleteTranslation', 'deleteTextSource', 'deleteProject']);
    expect(batches[0]).toContain('text_source_type=%27MESSAGE_CL%27');
    expect(project()).toBeUndefined();
  });

  it("refuses a pair holding someone's unpublished upload; deletes one adt+ left", async () => {
    const lastUploaded = { at: '2026-10-12T19:00:00.000Z', by: 'Someone' };
    const other = fakeService({ publishStatus: 'PREPARED', lastUploaded });
    await expect(deleteProject(deleteDeps(other.rest), { name: 'ZP', objectType: 'TRPR' })).rejects.toThrow(
      /the delete was refused, nothing was sent: en→de holds an upload by Someone at 2026-10-12T19:00:00.000Z, not published/,
    );
    expect(posts(other.request)).toHaveLength(0);
    const own = fakeService({ publishStatus: 'PREPARED', lastUploaded });
    const ownUploads = new Map([['ZP EN DE', { at: lastUploaded.at }]]);
    await deleteProject(deleteDeps(own.rest, { ownUploads }), { name: 'ZP', objectType: 'TRPR' });
    expect(own.project()).toBeUndefined();
    expect(ownUploads.size).toBe(0);
  });

  it("refuses a project outside the allowlist and one that doesn't exist", async () => {
    const { rest, request } = fakeService();
    await expect(deleteProject(deleteDeps(rest, { destination: destination(['ZOTHER']) }), { name: 'ZP', objectType: 'TRPR' })).rejects.toThrow(/not in the write allowlist/);
    expect(posts(request)).toHaveLength(0);
    const none = fakeService({ noProject: true });
    await expect(deleteProject(deleteDeps(none.rest), { name: 'ZP', objectType: 'TRPR' })).rejects.toThrow(/translation project ZP does not exist on cloud-erp/);
  });
});

describe('data elements', () => {
  const label = (key: string, target: string) => ({ language: 'de', objectType: 'DTEL/DE', name: 'ZDE', key, target });

  it('refuses some of a data element\'s texts alone: SAP would publish the others empty or mark them outdated', async () => {
    const { rest, request } = fakeService({ dataElement: true });
    await expect(updateProject(deps(rest), { name: 'ZP', objectType: 'TRPR', update: { translations: [label('SHORT_FIELD_LABEL', 'Bewertung')] } })).rejects.toThrow(
      /DTEL\/DE ZDE: a data element's texts are written together.*send LONG_FIELD_LABEL too/,
    );
    expect(posts(request)).toHaveLength(0);
  });

  it('writes all of them together; one without a source (an unset label) has nothing to send', async () => {
    const { rest } = fakeService({ dataElement: true });
    const r = await updateProject(deps(rest), {
      name: 'ZP',
      objectType: 'TRPR',
      update: { translations: [label('SHORT_FIELD_LABEL', 'Bewertung'), label('LONG_FIELD_LABEL', 'Rezeptbewertung')] },
    });
    expect(r.written.map((w) => w.key)).toEqual(['SHORT_FIELD_LABEL', 'LONG_FIELD_LABEL']);
  });
});

describe('changeset', () => {
  /** SAP's answer to an upload whose XLIFF held a bare "&" (cloud-erp, 2026-10-13): the changeset failed, nothing was written. */
  const FAILED =
    '--CAC86209D0899A00CE091E39BD4AFD720\r\nContent-Type: application/http\r\nContent-Length: 1406\r\ncontent-transfer-encoding: binary\r\n\r\n' +
    'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json;charset=utf-8\r\nContent-Length: 1285\r\ndataserviceversion: 1.0\r\n\r\n' +
    '{"error":{"code":"SXCO_PUBLIC/000","message":{"lang":"en","value":"The following XML parse error occurred at line 8, column 62: unexpected symbol"}}}' +
    '\r\n--CAC86209D0899A00CE091E39BD4AFD720--\r\n';
  const answering = (status: number, body: string) =>
    ({ request: vi.fn(async () => ({ status, headers: new Headers(), body })) }) as unknown as RawAdtClient & { request: ReturnType<typeof vi.fn> };

  it("throws SAP's error when the changeset failed, counting each operation in the rate limit", async () => {
    const rest = answering(202, FAILED);
    const ops = [{ name: 'uploadTranslationFile', params: { fileContent: "it's" } }, { name: 'uploadTranslationFile', params: { fileContent: 'x' } }];
    await expect(changeset(rest, ops, 'upload')).rejects.toThrow('upload failed (HTTP 400 SXCO_PUBLIC/000): The following XML parse error occurred at line 8, column 62');
    const [, path, opts] = rest.request.mock.calls[0]! as [string, string, RequestOptions];
    expect(path).toBe('/sap/opu/odata/sap/UI_SMTR_PROJECT/$batch');
    expect(opts.units).toBe(2);
    expect(opts.body).toContain("POST uploadTranslationFile?fileContent=%27it%27%27s%27 HTTP/1.1");
  });

  it('reports a written operation whose answer still carries an error, and refuses an answer it does not know', async () => {
    const ok =
      '--A\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n' +
      'sap-message: {"code":"SMTR/009","message":"no target","severity":"warning","details":[{"code":"SMTR/1","message":"bad","severity":"error"}]}\r\n\r\n' +
      '{"d":{"publishTranslation":{"IsInvalid":true}}}\r\n--B--\r\n--A--';
    expect(await changeset(answering(202, ok), [{ name: 'publishTranslation', params: {} }], 'publish')).toEqual([
      { name: 'publishTranslation', status: 200, errors: ['SMTR/1: bad', 'SAP marked publishTranslation invalid'], warnings: ['SMTR/009: no target'] },
    ]);
    await expect(changeset(answering(200, '<html/>'), [{ name: 'publishTranslation', params: {} }], 'publish')).rejects.toThrow(/HTTP 200/);
    await expect(changeset(answering(202, ok), [{ name: 'a', params: {} }, { name: 'b', params: {} }], 'publish')).rejects.toThrow(/1 answers to 2 operations/);
  });
});

describe('batchParts', () => {
  it('reads each answer of a $batch response', () => {
    const body =
      '--A\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nsap-message: {"code":"X/1","message":"m","severity":"warning"}\r\n\r\n{"d":{}}\r\n--B--\r\n--A--';
    const [p] = batchParts(body);
    expect(p).toMatchObject({ status: 200, body: '{"d":{}}' });
    expect(p!.headers.get('sap-message')).toContain('X/1');
  });
});
