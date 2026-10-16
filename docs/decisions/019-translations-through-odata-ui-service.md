# ADR-019: Translations through the unreleased OData UI service `UI_SMTR_PROJECT`

- Status: accepted 2026-10-12

## Context

ADT has no translation API, neither in adt-ls 1.1.2 nor in either system's discovery. In ABAP
Cloud, development objects are translated in translation projects (R3TR `TRPR`) through the Fiori
app "Maintain Translations" (F4950). Its only data source is the OData V2 UI service
`UI_SMTR_PROJECT`. The service is the same on `onprem` and `cloud-erp`, answers in the REST fallback's session,
and carried the whole lifecycle in a `cloud-erp` probe. `UI_*` services aren't released: SAP may change
them with any release, and nobody documents them.

What the probe showed and the design rests on:

- A project belongs to a package and lists text sources (an object, or a whole package) and
  language pairs. Texts move per pair: `downloadTranslationFile` returns XLIFF 1.2, and
  `uploadTranslationFile` followed by `publishTranslation` writes them. An upload alone changes no
  text.
- `ALL` holds every unit, with a `<target>` where a translation exists. `DELTA` holds the missing
  ones (no `<target>`) and the outdated ones (a `<target>` whose source changed since). Downloads
  have no side effects.
- An upload fails with 414 between 20 and 100 KB as a URL parameter and works in `$batch`. SAP
  silently cuts a target longer than `maxwidth` at publish and silently ignores units it doesn't
  know.
- **The project carries the request.** Creating it in a package that records changes needs one,
  and the project is locked there. A publish writes `LANG` entries of the translated objects into
  the project's request, even when an object is locked in another one, and refuses a different
  request (`SMTR/230`).

AFF keeps translations out of an object's JSON, in `.i18n.<lang>.properties` files, but specifies
no process and no outdated mark, and the system doesn't serve these files to adt-ls yet.
Translation projects stay the way in.

The questions are asked from both ends. After a change, an agent asks about an object ("which
translations of this data element are outdated?"). Maintaining translations works on a project:
many objects, one language pair, one upload and one publish.

## Decision

### 1. A new fallback kind: OData UI service

A call to `UI_SMTR_PROJECT` is an **OData UI fallback**. ADR-002's rules apply where they make
sense, with these differences:

- The result is tagged `via: "odata-ui"`.
- **Retirement:** when SAP releases an API for translations (a released OData service, or ADT
  support adt-ls can reach), or adt-ls serves AFF translation files that can tell outdated from
  current. ADR-002's `nativeAvailable` probe has nothing to look for; the service check (6) takes
  its place in `system status`.
- **Same session as REST:** the reentrance-ticket session and its CSRF token, the per-system rate
  limit (every OData call and every `$batch` operation counts as one request), the call log, and
  ADR-002's rules (never retry a 401). adt+ sends its own user agent and none of the app's
  identifying headers (ADR-005, "no disguise").

### 2. Two ways in: the object reads, the project writes

- **A translation project is an object type**, `TRPR`, form-based like MSAG and DEVC: `object
  read`, `create`, `update` (with `properties`) and `deleteObject`. Every translation write goes
  through it, including the texts.
- **`object translations` reads texts** from the object's side (or a package's); `read TRPR`
  reads them from the project's. Each entry names its project and language pair, in the shape
  `update TRPR` takes, so a text is read and written back without transformation.
- **There is no write through the translated object.** It would suggest that the change lands in
  the object's request, but the `LANG` entries go to the project's request. And AFF keeps
  translations out of the object's JSON, so `properties` on a DTEL with translations is a shape
  AFF doesn't have. If AFF translation files reach adt-ls, the object path is designed then.

### 3. Read: `object translations`

Takes an object (`objectType` and `name`) or a package, and optionally `language` (the target
language) and `translationStatus` (any of `translated`, `missing`, `outdated`, `empty`). Without
`translationStatus` it returns every text with its status: adt+ doesn't decide which ones matter.
A project's texts come through `read TRPR` (4).

**Finding the projects** for an object or a package (the service has no reverse lookup):

1. One `GET Project?$expand=to_TextSource,to_Translation`, developer projects (`Type='5'`) only.
   Not cached: a project made in the app shows up on the next call.
2. A project covers an object when a text source is the object itself, or a `PACKAGE` source for
   the object's own package: a `PACKAGE` source doesn't reach subpackages. The mapping between
   ADT types and text source types, with the XLIFF group each gives:

   | ADT type | Text source (type, name) | XLIFF group `datatype` |
   |---|---|---|
   | `DEVC/K` | `PACKAGE`, the package | (its objects' groups) |
   | `DDLS/DF` | `DATA_DEF` | `x-DATA_DEFINITION` |
   | `DDLX/EX` | `MTDT_XTNSN` | `x-METADATA_EXTENSION` |
   | `DTEL/DE` | `DATA_ELEM` | `x-DATA_ELEMENT` |
   | `DOMA/DD` | `DOMAIN` | `x-DOMAIN` |
   | `MSAG/N` | `MESSAGE_CL` | `x-MESSAGE_CLASS` |
   | `CLAS/OC` | `TEXT_POOL`, `CL_<class>` | `x-TEXT_POOL` |
   | `FUGR/F` | `TEXT_POOL`, `FG_<group>` | `x-TEXT_POOL` |

   Other types (application log objects, business catalogs, the `LTO_*` types …) are read with
   their service type and source name, without an ADT type. A project takes sources of its own
   software component only (`SMTR/168` otherwise), so only projects there can cover an object.
3. Confirmed in the file: the downloaded XLIFF has a `<group resname="<source name>">` for it.
   Otherwise the object has no translatable text in that project's source language, and the
   result says so, with SAP's warnings from `sap-message` ("No text found for … in language
   EN").

When no project covers the object, the result says so and lists none; adt+ never creates a
project to read.

**Per language pair** of each covering project: `ALL` and `DELTA`, the units of the requested
objects kept. A text is **translated** (a target, not in `DELTA`), **missing** (no target),
**outdated** (a target, in `DELTA`) or **empty** (`<target/>`: an empty translation was published.
Users see an empty text, and `DELTA` doesn't list it).

**"Outdated" is per project, as in SAP's app.** `ALL` is the same in every project, since the
texts belong to the object, but `DELTA` is kept per unit per project: a unit leaves a project's
`DELTA` when that project publishes it with the current source. So "outdated"
means "this project hasn't published the current source". With one project per object and
language pair, the normal setup, that is the object's state; a translation made outside the
project (SE63) reads as outdated there, as in the app.

**Projects that overlap:** when several projects cover an object with the same language pair,
`translations` returns each one's entries and a warning naming them: their "outdated" can
differ, and a publish through one doesn't clear the others. adt+ doesn't merge them. The
lookup's one `GET` shows the overlap; it costs no further call.

**Each entry:** project, language pair, object (adt+'s type and name, mapped from the group's
`datatype`; the raw type where no mapping exists), text key (the unit id without its object
prefix, e.g. `SHORT_FIELD_LABEL`, `SHORT_TEXT:001`), source, target, `maxwidth`, the note, status.
No XLIFF in the result; AFF translation files could fill the same shape.

**Narrowing and paging:** `language`, `translationStatus`, and `grep` (a regex over "<objectType>
<name> <key> <source> <target>", as `grep` narrows a message class read). Pages:

- `maxResults` caps a page (default 100, at most 500);
- `truncated: true` says the result was cut;
- `nextCursor` then fetches the next page when passed back as `cursor`.

Entries are sorted by project, language pair, object and key. The cursor names the last entry
rather than a position, so a text published between two pages doesn't shift the rest. This
convention applies to the translation reads only for now; harmonizing paging across the surface is
a backlog item.

Languages are BCP 47 tags as in AFF (`de`, `zh-Hant`; AFF's `languages.md` maps them to SAP's
codes), throughout. ISO 639-1 alone can't tell SAP's Chinese variants apart (AFF #582).

### 4. The `TRPR` type

**`read`** returns the definition by default, without downloading anything:

```json
{
  "header": { "description": "…" },
  "package": "ZPKG",
  "textSources": [{ "type": "PACKAGE", "name": "ZPKG", "objectType": "DEVC/K" }],
  "languages": [{ "source": "en", "target": "de", "publishStatus": "SUCCESS",
                  "lastUploaded": { "at": "…", "by": "…" }, "lastPublished": { "at": "…", "by": "…" } }]
}
```

Text source types are the service's (as the app shows them); `objectType` is added where adt+
knows the mapping.

The texts are opt-in: with `translationStatus` the read downloads `ALL` and `DELTA` per pair and
adds `translations` with those texts, each entry as in 3 without the project, narrowed and paged
as in 3. Each language pair then also carries its counts per status; `maxResults: 0` returns only
the counts. So `read` and `update` share one shape (ADR-018), and a project of thousands of texts
costs nothing until asked for. `objectType` and `name` name the project here, so one object inside
it is narrowed with `grep`, or read through `translations`.

**`create`** takes `package` and `description` like every type, and optionally `textSources` and
`languages` in `properties`. In a package that records changes it needs `transport`, given
explicitly, and is refused before any request otherwise (as for MSAG). adt+ never picks a request
(`getTransports` stays unused). Languages are checked against `getInstalledLanguages` before
anything is written. `createProject` is its own call, because a changeset's operations don't see
each other's writes. Then text sources are checked against `getAddableTextSources` (it needs the
project), and `addTextSources` and the `createTranslation`s go in one changeset, all or nothing.
If that fails, the project is left in place, empty, and the result names it.

**`update`** takes `properties`, merged by key (ADR-018): `header.description`, new
`textSources` (adt+ sends only those the project lacks: SAP fails the whole changeset on one it
has, `SMTR/065`), new `languages`, and `translations`:

```json
{ "translations": [{ "language": "de", "objectType": "DTEL/DE", "name": "ZADTPLUS_X",
                    "key": "SHORT_FIELD_LABEL", "target": "…" }] }
```

`objectType`, `name`, `key` and `language` identify the text; `target` is what is written. The
other keys of a read entry (`source`, `maxwidth`, `note`, `status`) are read-only, and **a
read-only key is accepted when unchanged and refused when it differs.** A read entry can be sent
back as it is, with only `target` filled in. Its `source` then works as a precondition: if the
source text changed since the read, the entry is refused with its current values, and the same
holds for `maxwidth` and `status` (someone published in between). Leaving them out sends the
target without that check. This sharpens ADR-018's "read-only keys are refused", whose point is
that they can't be changed; applying it to MSAG and DEVC (`formatVersion`) is a backlog item.

AFF has no `trpr` format, so the shape is adt+'s own (ADR-018 allows that for a type without
one, like TTYP).

Removing a text source or a language pair isn't offered yet: leaving it out never deletes it
(ADR-018), and an irreversible action for it isn't needed so far. The app does it.

**`deleteObject`** (`adtplus_irreversible`, `confirm: true`): deletes the language pairs, the text
sources and the project; `transport` where the package records changes, as for every delete.

### 5. Writing texts: `update TRPR` with `translations`

In this order, all before the first write:

1. **Switch:** `ADTPLUS_DENY`, then `allowTranslations: true` on the system (7).
2. **Allowlist (ADR-003):** the project lands in its own package, which must be covered. With
   `translations`, **every translated object's package too**, since their `LANG` entries are
   written. Fails closed.
3. **Language pairs:** each language in `translations` must be a pair of the project (or added by
   the same update's `languages`). A pair that is `PREPARED` (uploaded, not published) by another
   user is refused: publishing would publish their upload. One the caller left `PREPARED` (a
   failed earlier update) is overwritten by the new upload.
4. **Texts, checked by adt+ against `ALL`:** every object and key must be a unit (SAP would ignore
   an unknown one silently); every target must fit `maxwidth` (SAP would cut it silently); no empty
   target; one target per key; read-only keys sent along must equal the current values (4). Every
   finding is listed in the refusal; nothing is cut or dropped.

Then three `$batch` changesets, each all or nothing (a changeset's operations don't see each
other's writes, so what depends on an earlier write goes in the next one;
probe):

1. `updateProject`, `addTextSources`, `createTranslation`s, when the update has any;
2. one upload per language pair. Each file holds only the units being written: a unit left out
   keeps its published translation;
3. one publish per language pair.

An error, or an error in `sap-message`, stops before the next changeset; warnings are reported.
The partial states that remain are a changed definition with no texts written (after 1), and the
caller's own uploads, not published (after 2). Neither changes a text, and the result names it.
The result carries the old targets: a changed translation can be set back by another update. A
translation that didn't exist before can't be removed again: an empty target doesn't remove it,
it publishes an empty text, which is why adt+ refuses empty targets.

**Request:** an update sends no `transport`; SAP takes the project's. When SAP asks for one (the
project's request was released; not probed yet), the update refuses with SAP's message and the
caller passes `transport`.

**Verify:** `ALL` and `DELTA` again per pair. Every sent target must be in `ALL` unchanged; the
result lists what's still missing or outdated in the objects it touched.

### 6. Only these calls, and when SAP changes them

| Use | Calls |
|---|---|
| service check | `$metadata` |
| read | `Project` (`$expand` `to_TextSource`, `to_Translation`); `downloadTranslationFile` (`ALL`, `DELTA`, `XLIFF`) |
| create, update | `getInstalledLanguages`, `getAddableTextSources`; `createProject`, `updateProject`, `addTextSources`, `createTranslation`, `uploadTranslationFile`, `publishTranslation` |
| delete | `deleteTranslation`, `deleteTextSource`, `deleteProject` |

Every write goes through a `$batch` changeset, even a single call (no URL limit, all or
nothing). Not used: `getTransports` (not understood), `getPackages`, `getProjectTypes`, other project types
than `5`.

- Before the first call in a session, adt+ reads `$metadata` once and checks the entity sets,
  properties, function imports and parameters above, with their types. On a mismatch every
  translation action refuses with "`UI_SMTR_PROJECT` changed on <system>: <what>", and `system
  status` shows it. adt+ never guesses and never switches to other calls.
- XLIFF is parsed as XML (ADR-012 doesn't apply: it isn't ABAP). A file without the expected
  `file`/`group`/`trans-unit` structure, or a unit without `maxwidth`, makes an update refuse;
  `translations` reports it. A unit id in an unknown pattern is passed on whole as the key.
- An answer SAP hasn't given before (status, `sap-message`) is reported raw, never read as
  success.
- Adapting to a change is a code change after a live probe, recorded in `known-issues.md` with the
  app version seen (F4950 100.39.2 on `onprem`, 2608.0.0 on `cloud-erp`).

### 7. Off by default, per system

`allowTranslations: true` in `systems.json` or an approved project config (a trust-dialog field
like `allowRuntimeLogs`) switches all of it on: `translations`, and `read`/`create`/`update`/
`deleteObject` on `TRPR`. Without it they refuse, naming the switch, and the descriptions say so.

Why: ADR-005 rests on ADT APIs and the channels FAQ Q33 names; an unreleased Fiori UI service is
neither. Translations of repository objects are development artifacts, so they stay within
ADR-005's scope. adt+ reads one object, package or project per call, never the whole system, and
every call counts against the budget.

### 8. Surface (ADR-018)

| MCP | Daemon | CLI | Gate |
|---|---|---|---|
| `adtplus_object` `translations` | `object.translations` | `adtplus object translations` | T |
| `adtplus_object` `read` on `TRPR` | `object.read` | `adtplus object read` | T |
| `adtplus_object_write` `create`, `update` on `TRPR` | `object.create`, `object.update` | `adtplus object create`, `update` | T, A |
| `adtplus_irreversible` `deleteObject` on `TRPR` | `object.delete` | `adtplus object delete` | T, A, C |

One new action and one new type; no new tool. New parameters on `adtplus_object`: `language`,
`translationStatus` (not `status`, which in a tool of 12 actions reads as activation or lock
status) and `cursor`; `grep` and `maxResults` gain the translation reads. `sap-reviewer` gets `translations` through
`adtplus_object`. Descriptions start with SAP's terms ("Maintain Translations", "translation
project"). Gate letter **T** = `allowTranslations`.

## Consequences

- Verified on `cloud-erp` only: `onprem` has no translation projects (`getPackages` answers 400).
- adt-ls's `search` and `resolve` know `TRPR`; its `read` serves a placeholder, so `read` goes to
  the service.
- `transport read` lists the `LANG` entries a publish records.
- Open (backlog): one paging convention for the whole surface (`dumps` and `gatewayErrors` move a
  time window, `search`/`versions`/`list` only cap, `transport diff` pages by cursor); accepting a
  read-only key when unchanged for MSAG and DEVC.
- A change to the write gates is built under ADR-003's review rule (`/code-review high`).

## Changes

- 2026-10-15: restated as it holds today for the public release.
