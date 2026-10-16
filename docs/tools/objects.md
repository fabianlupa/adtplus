# Objects

Find, read, create, change, activate and delete repository objects, packages and message classes
among them. Tools: `adtplus_object` (read), `adtplus_object_write` (write), `adtplus_irreversible`
(`deleteObject`, `deleteMessages`); CLI `adtplus object <action>` in kebab case. A package's own
details (validate, create, update, delete): [packages.md](packages.md). Backend and gate letters:
[capabilities.md](../capabilities.md#legend).

| Action | Backend | Gate | Verified |
|---|---|---|---|
| [resolve](#resolve) | adt-ls | — | both |
| [search](#search) | adt-ls | — | both |
| [read](#read) | adt-ls (MSAG, DEVC, `version` number: REST; TRPR: OData UI) | — (TRPR: T) | both (MSAG: `onprem`; TRPR: `cloud-erp`) |
| [translations](#translations) | OData UI | T | `cloud-erp` |
| [versions](#versions) | REST | — | both |
| [diff](#diff) | REST | — | both |
| [list](#list) | adt-ls | — | both |
| [listInactive, lockStatus](#listinactive-lockstatus) | adt-ls | — | both |
| [validate](packages.md#validate) (DEVC) | REST | — | both |
| [create](#create) | adt-ls (MSAG, DEVC: REST) | A (DEVC: superpackage) | both (MSAG: `onprem`) |
| [update](#update) | adt-ls (MSAG, DEVC: REST; TRPR: OData UI) | A, M (TRPR: T, A) | both (MSAG: `onprem`; TRPR: `cloud-erp`) |
| [activate](#activate) | adt-ls | A (each ref) | both |
| [publish, unpublish](#publish-unpublish) | adt-ls | A, C | both |
| [generators, generatorSchema](#generators-generatorschema) | adt-ls (federated tool) | — | both |
| [generate](#generate) | adt-ls (federated tool) | A | both |
| [serviceInfo](#serviceinfo) | adt-ls | — | both |
| [applyQuickfixes](#applyquickfixes) | adt-ls (federated tool) | A, M (each object) | both |
| [deleteObject](#deleteobject) | adt-ls raw (MSAG, DEVC: REST) | A (DEVC: superpackage), C | both (MSAG: `onprem`) |
| [deleteMessages](#deletemessages) | REST | A, C, M | `onprem` |

Subtyped refs (`SRVD/SRV`, `BDEF/BDO`, `DDLX/EX`) work on every action, `search`'s type filter
included (the SDK searches them by their main type, adt-ls#11 and #26, since 0.7.0). Which object
types each action supports: [object-types.md](../object-types.md).

## properties

A package (`DEVC/K`), a domain (`DOMA/DD`), a data element (`DTEL/DE`) and a message class
(`MSAG/N`) have no source: they are form-based (ADR-018). `read` returns them, and `create` and
`update` take them, as `properties`: the type's AFF JSON (`devc-v1`, `doma-v1`, `dtel-v1`,
`msag-v1`, vendored in `src/mirror/aff-schemas`), SAP's field names, the shape a mirror's
`.msag.json` has.

- Checked against AFF's schema without its `required`: a partial document passes; a key AFF
  doesn't know, or a value it refuses, is refused with every finding and the type's fields.
- An update merges by key: objects key by key, a message list by `number`. What isn't sent stays
  as it is; leaving a message out never deletes it (`adtplus_irreversible deleteMessages` does).
  One exception: a domain's `fixedValues` and `fixedValueIntervals`, when sent, are the new lists
  (SAP's write replaces the whole domain; the removal lands in the inactive version, and not
  activating it undoes it). Sending one of them keeps the other.
- `formatVersion` and `header.originalLanguage` are refused in an update. What else a type takes:
  [packages.md](packages.md#update), [message classes](#update) below.
- AFF has no field for a message's "self-explanatory" flag or its long text: adt+ leaves both as
  they are (SE91 by hand; long texts: backlog).
- A translation project (`TRPR`) is form-based too, in a shape of adt+'s own: AFF has no `trpr`
  (ADR-019 §4). [`read`](#read), and [`update`](#update) with `translations`; `create` and
  `deleteObject` on it are refused, with or without `allowTranslations`.

## resolve

- Confirmed by a read; URIs re-rooted onto `vfsMount`.

## search

- Default cap 25, max 100; check `truncated`.
- `DRTY/STY`, `DTEB/DF`, `CHDO/CHD`, `RONT/ROT`, `DRAS/RAS` are searched by their main type:
  adt-ls's subtyped filter finds nothing for them on `onprem` ([known-issues.md](../known-issues.md)).

## read

Source by name (ADR-010).

- `include` for classes; `served` says whether the text is the user's draft (`abapStat`).
- `version: "active"` runs under the daemon's exclusive object hold. Every include is stat'ed; a
  failed stat counts as a missing include only when the class folder doesn't list the file, else
  it fails the read; none of the asked includes: "has no include …".
- An object adt-ls won't switch, such as one never activated (`cloud-erp`, DDLS), answers "has no active
  version"; other active-read failures name adt-ls's error.
- Narrowing: the whole text verbatim, or `method` (found through abaplint's statements), `grep`
  (+`context`; the regex is stopped after 1 s, `vm` time limit) or `fromLine`/`toLine`; `maxLines`
  without a default.
- A class's whole main read lists its existing `includes` (SAP's templates count).
- A mirror of the same MCP session holding the object adds a note.
- `version` with a number from [versions](#versions) (`00001`…) reads that released version over
  REST (2 requests: the feed, the content), narrowed the same way, with `version` (request,
  author, time) in place of `served`. A class's main source comes as the version store rebuilt it
  (a note says so). `00000` and `99999` read as `active` and `inactive`, through adt-ls.

**Message classes** (`MSAG/N`, REST fallback):

- `properties` (`msag-v1`: header and messages, in the master language), `package`; with `grep`,
  `totalMessages`.
- `grep` over "<number> <text>", no other narrowing.
- 1 request (2 when the logon language isn't the master language).
- SAP's `documented` flag isn't reported: it doesn't say whether a long text exists.

**Packages** (`DEVC/K`, REST fallback): `properties` (`devc-v1`), 1 request, no narrowing
([packages.md](packages.md#read)).

**Domains** (`DOMA/DD`, REST fallback): `properties` (`doma-v1`), `package`, `version` (the
inactive version when there is one, else the active), 1 request, no narrowing.

- Texts in the master language, whatever the logon language (SAP's answer; translations aren't
  read).
- Fixed values and intervals apart, empty or off fields left out; values a fixed value append
  contributes are listed as its name in `fixedValueAppends`, not as the domain's.
- Output style: SAP's codes `00`–`06` as AFF's names (`normal` … `engineering`).

**Data elements** (`DTEL/DE`, REST fallback): `properties` (`dtel-v1`), `package`, `version` (as for
domains), 1 request, no narrowing.

- Texts (description, field labels) in the master language, as for domains.
- `dataTypeInformation`: a domain-based or reference one by `typeName` only (a domain's type is the
  domain's), a predefined type or a reference to one by `predefinedType`.
- `fieldLabels` with each label's length; `additionalProperties` with what is set. The flag SE11
  calls "basic direction is set to LTR" (`DD04L-LTRFLDDIS`) is AFF's `basicDirection:
  rightToLeft`, AFF's value for `X`; unset, AFF's default `leftToRight` is left out.

**Translation projects** (`TRPR`, OData UI fallback, gate T; ADR-019 §4): developer projects
(type 5) only. adt-ls's own `read` serves a placeholder for `TRPR`; `search` and `resolve` find
projects through adt-ls as for any type.

- `properties`: `header.description`, `package`, `textSources` (the service's type and name, with
  `objectType` where adt+ maps it; a text pool's `CL_<class>`/`FG_<group>` also with
  `objectName`), `languages` (BCP 47 `source` and `target`, `publishStatus`, `lastUploaded` and
  `lastPublished` with time and user). 2 requests on the session's first translation call (the
  service check), 1 after; nothing downloaded.
- `language` narrows the pairs listed. `translationStatus` also reads the texts: per pair `ALL`
  and `DELTA` (2 requests each), `counts` per status on each pair, `translations` with the entries
  of [translations](#translations) without `project`, narrowed by `translationStatus` and `grep`
  and paged the same way. `maxResults: 0` returns the counts only. `grep`, `maxResults` and
  `cursor` without `translationStatus` are refused.
- No source narrowing (`include`, `version`, `method`, `context`, lines) on a project, and none of
  the translation parameters on any other type.

## translations

> **Experimental**, like translation projects (`TRPR`): SAP's UI service is unreleased and only `cloud-erp` has been tried.

Texts of an object, or of a package (`DEVC/K`), from every translation project that covers it, as
SAP's app "Maintain Translations" shows them (ADR-019 §3). OData UI fallback, gate T.

- Types: DDLS, DDLX, DTEL, DOMA, MSAG, CLAS and FUGR (their text pools), and DEVC: the text
  sources adt+ maps to an ADT type. Others are refused before any call.
- **Projects:** one `GET Project` lists every developer project with its sources and pairs (not
  cached). One covers an object through the object's own source or a `PACKAGE` source of its own
  package (a superpackage's doesn't reach it); a package through its own `PACKAGE` source or the
  source of one of its own objects (read through adt-ls's repotree, without subpackages; a folder
  that can't be read refuses the call rather than leave its objects out). None covering it: a
  warning, no download; adt+ never creates a project to read.
- A package read keeps the texts of the types adt+ maps only: a text of `LTO_DRTY`,
  `IAM_BUSINESS_CATALOG` and the like can't be matched to a package's objects, so a warning names
  the types left out, and `read` of the project lists them.
- **Per pair** of each covering project (`language`: only those with that target): `ALL` and
  `DELTA` (only `ALL` when `translationStatus` asks for neither translated nor outdated). Only
  the units of the asked-for objects are kept; a project whose file has none says so in
  `warnings`, with SAP's messages that name the object ("No text found for … in language EN").
- **Status:** `missing` (no target), `empty` (`<target/>`: an empty translation was published),
  `outdated` (a target, in this project's `DELTA`), else `translated`. "Outdated" is per project:
  a text published through one project stays outdated in every other one covering it. Several
  projects covering the same object and pair: each one's entries, and a warning naming them.
- **Entry:** `project`, `sourceLanguage`, `language` (target; BCP 47 as in AFF, e.g. `zh-Hant`;
  SAP's code where AFF lists none, e.g. `AR`, which `language` takes back as it is),
  `objectType` and `name` (adt+'s type; the service's own type where none maps, e.g. `LTO_DRTY`),
  `key` (the unit id without its `<type>:<name>:` prefix, e.g. `SHORT_FIELD_LABEL`,
  `TEXT_ELEMENT_TEXT:TEXT_SYMBOL:001`; an id in another pattern whole), `source`, `target`,
  `maxwidth`, `note`, `status`. No XLIFF in the result.
- **Narrowing and paging:** `translationStatus` (any of the four), `grep` (a regex over
  "<objectType> <name> <key> <source> <target>", case-insensitive, stopped after 1 s);
  `maxResults` (default 100, at most 500; `0`: only `total`); sorted by project, pair, object,
  key; `truncated` and `nextCursor`, passed back as `cursor`. The cursor names the last entry, so
  a text published between two pages doesn't shift the next one. `total` counts every match.
- XLIFF that lacks the expected structure (no `file`, a unit without `maxwidth`, a unit outside a
  group) is listed in `warnings`.
- Cost: 1 adt-ls resolve (an object's package) or a repotree walk of the package, then 1 request
  for the projects and 1–2 per pair; the service check once per REST session.

## versions

An object's version history (REST fallback, `capabilities/versions.ts`; no adt-ls call for it in
1.1.2).

- The version feed of the object's source file, found from adt-ls's AFF file name (1 adt-ls call),
  so a function module or a group's include needs no group name. A class without `include`: its
  main source and all four includes, each tagged `include`; with one: that include only.
- Each entry: `version`, `state` (`draft` `99999`, `active` `00000`, `released` `00001`…, or
  `stored` for a numbered one without request, stored by hand), `request` and its `description`,
  `author`, `at` (UTC by the measured system clock, [known-issues.md](../known-issues.md#system-clock)). Per file: the draft, the active version, then numbered ones newest first.
  `maxResults` (default 50, max 500) cuts each file's list, `truncated` says so.
- A class's feeds are read one after another; one that fails is noted and the others listed.
- A released version names the request whose release made it. The active version and the draft
  name the open request holding the object, or the one that imported it.
- Only versions made in this system: an imported object has just `00000` (a note says so), as
  does a local one.
- Source types only (classes, interfaces, programs and includes, function groups and modules, CDS
  sources, BDEF, SRVD, TABL); others are refused ("no version history adt+ can read").
- 1 request per file read: 5 for a whole class, else 1.
- `read` with a version number adds the mirror note like any read.

## diff

Two versions of one source file as a unified diff (REST fallback, `capabilities/versions.ts`).

- `version` (the newer side) and `baseVersion` (the older) each take a number from
  [versions](#versions), `active` or `inactive` (the draft, else the active version).
  Defaults: `inactive` against the last release (a version stored by hand only when none was
  released), "what changed since the last release"; a number alone goes against the numbered
  version before it.
- One file: `include` picks a class's include, as in `read`. Both sides come from the version
  store, so a class's main source is rebuilt alike on both and differs only where the code does.
- Headed by the AFF file name (`--- zcl_x.clas.abap (old)`), `context` unchanged lines (default
  3), `maxLines` cuts it (`truncated`). The same text on both sides: `diff` is `''` and a note
  says so. A side that doesn't exist names the versions that do.
- 3 requests: the feed and both contents.

## list

- `depth` 3 in one call lists objects (object = directory, so `truncated` is normal).

## listInactive, lockStatus

No notes.

## create

- `package`, `description`; a source-based type's `additionalFields` (CLI `--fields`), checked
  against the system's creation form first: unknown, missing or out-of-list values are refused with
  the type's full field list. A form-based type takes `properties` instead.
- The result's `filePath` is in VS Code's namespace, like every repotree URI the daemon hands out.

**Message classes** (`MSAG/N`, REST fallback):

- No `additionalFields`; SAP's name check first. `properties.messages` adds messages right after
  the create (an `update`, in the same request).
- Texts in the logon language; the system's `languageVersion` sent when not standard (`cloud-erp` not
  verified).
- In a package that records changes only with `transport`, refused before any request
  otherwise (SAP would create it unrecorded).
- Read back.

**Packages:** [packages.md](packages.md#create).

**Domains** (`DOMA/DD`, REST fallback):

- `properties` with at least `format.dataType` and `format.length`; no `header` (the description
  is `description`) and no `fixedValueAppends`. An output length left out or 0 is computed by the
  activation (`onprem`: `DEC` 10,2 → 13).
- SAP's name check first. Texts in the logon language (SAP keeps a domain's texts in its master
  language only; a create naming another left them inconsistent), the system's `languageVersion`
  sent when not standard (`cloud-erp` sets `cloudDevelopment` itself).
- The request rule of message classes; one POST with the whole domain. The result is the inactive
  version (`version`: `new` on `onprem`, `inactive` on `cloud-erp`): `activate` it.
- Read back: a field SAP stored other than sent fails the call.

**Data elements** (`DTEL/DE`, REST fallback):

- `properties` with at least `dataTypeInformation.category` and its type (`typeName`, or
  `predefinedType.dataType`); no `header`. A label length left out is the label's maximum (10, 20,
  40, 55), as SE11 starts it; a label longer than its length is refused before any call (SAP's
  activation would refuse it, its write doesn't). Names (type, search help and its parameter,
  parameter ID, default component name) are sent in upper case: SAP stores them as sent, then its
  activation finds none.
- SAP's name check, the language and the request rule as for domains. SAP's create doesn't store
  everything sent (it gives every label its maximum length; `cloud-erp`'s drops a predefined type), so
  when the read-back differs a lock → PUT of the whole data element follows, then the read-back
  that fails the call. Never activated (`version: new`): `activate` it.

**Translation projects** (`TRPR`, OData UI fallback, gates T and A; ADR-019 §4): a developer
project in `package`, its ID the name (at most 30 characters), `description` at most 60.
`properties` takes `textSources` (`{type, name}` as a read shows them, or `{objectType, name}` of a
type adt+ maps, a package as `DEVC/K`) and `languages` (`{source, target}`, BCP 47); no
`translations`, the project has no texts yet.

- In a package that records changes only with `transport` (adt+ picks none), refused before any
  request otherwise. The package must exist.
- New languages are checked against SAP's installed ones before anything is written.
- The name, description and `properties` are checked before any session.
- `createProject` is its own call, since the next ones need the project. Then the text sources are
  checked against `getAddableTextSources` (which needs the project: an object of another software
  component isn't offered), and `addTextSources` and the pairs go in one changeset, without
  `transport`: the project's request records them, another one is refused (`SMTR/230`). If that
  fails, the project stays, empty, and the error names it.
- Read back: the result is the project as SAP then shows it.

## update

`source` for a source-based object, or `properties` for a form-based one (one of them; the other
is refused).

**Source:**

- Writes the inactive version.
- `include` only for classes, one of `definitions`/`implementations`/`macros`/`testclasses`
  (others refused).
- **Class frame comments** (ADR-012): a class main source with a comment outside the sections and
  methods is refused before the write, naming the line, unless the system's text has the same
  comment in the same place (read only then; `onprem` keeps one after the last `ENDCLASS`, so a class
  read and written back may carry one).
  - Checked: abaplint's `no_comments_between_methods` for the implementation, plus, until abaplint
    has it (backlog), comments between definition and implementation and after the last
    `ENDCLASS`, also on the line of the definition's or the last `ENDCLASS`.
  - Allowed: comments before `CLASS … DEFINITION` (public section) and on `METHOD`/`ENDMETHOD`
    lines. Statements there are left to SAP.
- **An object in no open request** (code 1001): with `transport` (CLI `--transport`)
  the written file is assigned to that request and written again, as `push` does; without, the
  error says to pass one.
- **Gate M:** the MCP server sends the roots of every mirror call of its process. A manifest there
  for the same system holding the object with a pushable file refuses the write before any SAP
  call, naming the files to edit (a function module or function group include: its group's files
  named after it). No manifest (folder deleted) holds nothing; one that doesn't parse refuses. The
  CLI sends none.

**Message classes** (`properties`: `messages` and/or `header.description`), one lock → PUT → unlock:

- Messages: number, text ≤ 73 characters without a line break. Every message needs its number (SAP
  offers no free one) and its text.
- SAP keeps the messages not sent; a changed message keeps its self-explanatory flag; a new one
  gets SAP's default.
- `header.description` ≤ 60 characters (SAP cuts a longer one). One that differs from the current one is
  refused before the write: SAP records that change as `LIMU MESS <class>` without a message
  number and leaves a phantom message class in the package ([below](#known-issues)). An unchanged
  one passes.
- No inactive version: live at once.
- Read, sent and verified in the class's master language (a read in the logon language mixes in
  translations).
- A class no request holds (the lock names none) in a package that records changes needs
  `transport` (CLI `--transport`), refused before the write otherwise: SAP would
  write it unrecorded.
- Result: each message with its `previous` text (null: new).
- 4 requests (+1 read when the logon language isn't the master language, +1 package read for a
  class no request holds).
- Gate M as for source; a mirror holds a message class as its `.msag.json` (ADR-014).
- Long texts not supported (Eclipse edits them only in the GUI).

**Packages:** [packages.md](packages.md#update).

**Domains** (`properties`: any of `header.description`, `format`, `outputCharacteristics`,
`fixedValues`, `fixedValueIntervals`, `valueTable`), read → lock → PUT → unlock → read:

- Merged onto the current domain (its inactive version if it has one), then sent whole: SAP's PUT
  replaces the domain. `fixedValues`/`fixedValueIntervals` sent are the new lists;
  `valueTable: {"name": ""}` removes the value table.
- AFF's schema refuses an unknown data type or style before any call: SAP stores one and refuses
  it only at activation. An interval needs its `highLimit` (AFF requires it).
- Sent as SAP stores them: fixed values in upper case unless `caseSensitive` (SAP uppercases them
  itself), the conversion routine always (SAP stores `alpha` as sent, then its activation finds no
  routine). A changed `format` without `outputCharacteristics.length` sends output length 0: the
  activation computes it for the new type.
- `header.originalLanguage` and `header.abapLanguageVersion` are refused; texts are written in the
  master language the read gave.
- A domain with fixed value appends is refused: the PUT would replace their values.
- Writes the inactive version: `activate` activates it. Result: the domain's `properties` and the
  `previous` ones.
- The request rule of message classes; gate M as for source (a mirror holds a domain only as a
  stub).

**Data elements** (`properties`: any of `header.description`, `dataTypeInformation`,
`fieldLabels`, `additionalProperties`), read → lock → PUT → unlock → read, as for domains:

- Merged by key onto the current data element, then sent whole (SAP's PUT replaces it). Another
  `category` starts from no type: the old one's name or predefined type doesn't carry over; another
  `dataType` from no length and decimals, unless sent. Another search help drops the old one's
  parameter; a parameter without a search help is refused.
- The checks and the upper-case names of a create, the label check only on the labels the update
  changes; AFF's schema refuses an unknown data type or a label longer than AFF's maximum before
  any call.
- Writes the inactive version. SAP's activation may change what was written: a reference type's
  `changeDocumentRelevant` is reset (warning "Change documents reset").

**Translation projects** (`TRPR`, OData UI fallback, gates T and A; ADR-019 §5): `properties`
with `translations`, each `{language, objectType, name, key, target}` (at most 500); an entry of
a [translations](#translations) read, or of a `TRPR` read with `translationStatus`, goes back as
it is with `target` changed. Its other keys (`project`, `source`, `maxwidth`, `note`, `status`)
are read-only: accepted when equal to the current value, refused when not, so a text changed
since the read is refused. `sourceLanguage` only when two pairs lead into `language`.

The rest of a read is merged by key: a new `header.description` (at most 60 characters) changes it;
`textSources` and `languages` the project lacks are added (as for `create`), checked against SAP's
lists with the other findings; ones it has are accepted with their read-only keys unchanged. Leaving
one out never removes it (the Maintain Translations app does that). `package` is read-only. The
definition is one changeset before the uploads; when it is the whole update, a read verifies it.
Texts into a pair the same update adds are checked once that changeset made the pair (its `ALL`
exists only then): a refusal then says the definition was changed and no text written.

- Checked before anything is written, in two refusals at most (the texts need the pairs): first
  the switch, the read's other keys, the allowlist for the project's package and every translated
  object's (a confirmed resolve; a type adt+ can't place is refused), since a publish writes their
  `LANG` entries, and the pairs; when none of these refuses, the new sources and languages against
  SAP's lists (one it can't read is a finding too); then
  each text against the pair's `ALL`: a known unit (SAP would ignore an unknown one), within
  `maxwidth` counted in UTF-16 code units as ABAP does (SAP would cut it), not empty (an empty
  target publishes an empty text and can't remove a translation), given once.
- A pair `PREPARED` (uploaded, not published) is refused unless this daemon left that upload,
  at that time: publishing would publish it. SAP names the uploader by display name only, so
  after a daemon restart adt+'s own leftover counts as another's, and one without an upload time
  as well. adt+ replaces its own leftover: a new upload replaces a pair's pending one, so its
  texts the update doesn't send again aren't published.
- **A data element's texts go together:** SAP keeps them in one record per language, so
  publishing some of them publishes the others empty where the language had none, and marks them
  outdated where it had them (`cloud-erp`). An update sending some of a data element's texts in a pair is
  refused, naming the others to send along (unchanged ones with their current target). Message
  classes, text pools, domains, CDS views and metadata extensions keep each text separate; the
  `LTO_*` types aren't probed.
- Writes: one `$batch` changeset with an upload per pair (adt+'s own XLIFF, only the sent units:
  a unit left out keeps its translation), then one with a publish per pair. No `transport`: SAP
  takes the project's request and writes `LANG` entries into it for the objects whose texts the
  publish changed only, even when the object itself is locked in another request. A
  changeset SAP refuses changes nothing; a refused publish leaves the upload `PREPARED` (no text
  changed), which the next update with the same texts replaces. A lost connection says it's
  unknown whether the upload or publish reached SAP, with the previous targets. Once the
  project's request is released, SAP wants an open request (`SMTR/022` without one, `SMTR/023`
  for the released one) and the refusal says to pass `transport`; that request then holds the
  project. While the project's request is open, another one is refused (`SMTR/230`).
- A read to verify that fails after the publish lands in `notVerified`: the texts are live, and
  `written` keeps their `previous` targets.
- Result: `written` with each text's `previous` target (absent: there was none); `notVerified`
  when a read afterwards doesn't show a sent target; `remaining`, the touched objects' texts still
  missing or outdated; SAP's warnings.
- Requests: 3 on the session's first translation call (service check, project), 2 after; 1 per
  pair (`ALL`, +1 `DELTA` when a `status` is sent along); the two changesets count one per
  operation; 2 per pair to verify.

## activate

- A batch of at most 50, per-phase diagnostics; without `refs` the one object `name`/`objectType`
  give.
- **Nothing activated:** an answer with neither check nor activation run and no diagnostic is an
  error. When every object's `abapStat` is active, it says there is no inactive version and that a
  change in an unsaved editor isn't stored (write with `update`); otherwise it names the
  objects not served active. A batch where one object had something to activate answers as
  before, the already active ones not told apart.
- **Domains and data elements** activate through ADT's activation (REST): adt-ls's answers
  "Internal error." for a domain. Every object of a batch is gated first (`activateBatch`'s REST
  lane); then the domains and data elements in one request (SAP orders them: a data element on a
  domain of the same batch takes its type), then the rest through adt-ls, one answer (a phase
  counts as run when it ran in both). Their diagnostics name the ADT URI and `object`
  (`DOMA ZADTPLUS_X`), severity as adt-ls's. SAP's `activationExecuted` doesn't tell whether each
  object activated (a cancelled data element answers "true"; an active one can carry an error,
  "became active despite inconsistent references"), so each one's version is read afterwards: one
  not active makes `activationExecuted` false and adds an error naming it; a read that fails adds a
  warning and keeps SAP's answer (the activation has run). An answer without an
  activation result (SAP's inactive-objects list) is an error. `forceActivation` is refused when
  the batch has a domain or data element.
- No objects, or one without `name` and `objectType`, is refused before any call.

## publish, unpublish

- SAP's one action toggles: adt+ reads the binding's state first (`allowedAction`; S/4HANA 2023
  and OData V2: `published`) and refuses, with nothing sent, a binding already in the state asked
  for. `allowPublishService: false` refuses both.
- Read-back via `fetch_services`, else the binding details.
- Cloud ~132 s; refused for minutes after a publish ([below](#known-issues)).

## generators, generatorSchema

RAP generators: a full RAP service (CDS views, BDEFs, behaviour pool, draft table, metadata
extension, service definition and binding) from one object. adt-ls's own tools
`abap_generators-list_generators` and `get_schema`, as SAP's ADT MCP Server has them.

- `generators`: `id`, `title`, `referencedObjectTypes`, the description as plain text. `onprem`:
  `uiservice`, `webapiservice` (from a TABL). `cloud-erp`: `ui-service` (TABL, BDEF or DDLS),
  `webapi-service` (TABL), `x-ui-service` (no reference object).
- `generatorSchema`: the JSON schema of `content` and the generator's proposed `content`, names
  derived from `referencedObject` (`ZR_<table>`, `ZBP_…`, `<table>_D`, `ZUI_…_O4`). The two systems
  propose different shapes (`onprem`: `RAP Layers`; `cloud-erp`: AFF-based, with a `sessionId`). `cloud-erp` proposes
  free names: with the first set in place it suffixes `000` (`ZR_ADTP_PAR_TRIP000`); `onprem` proposes the
  same names again.
- A `cloud-erp` proposal still generates in a later session (its `sessionId` doesn't bind it).
- adt+ fills `metadata.package` with `package`: `onprem`'s proposal leaves it empty, and `generate`
  then fails "Package does not exist".
- A generator that needs a reference object refuses without one ("referencedObjectType is not
  valid. Expected one of: TABL").

## generate

- Runs a generator into `package` with `content` (default: the proposal unchanged); allowlist on
  the package (looked up, fails closed). The generator creates in `content.metadata.package`, so adt+
  sets it to `package` and refuses content naming another package. `transport`
  for a transportable package.
- All objects at once, **active**. The result lists them. `onprem`: 9 objects in ~20 s. `cloud-erp`: 14, with
  access controls (DCLS), two behaviour pools, an SAP object type (RONT) and object node type
  (NONT).
- A name that exists fails the whole run with nothing created: the tool answers OK with
  `validationMessages` and no objects, which adt+ turns into an error naming the message. `onprem` names
  the object ("ZADTP_PAR_TRIP_D already exists"); `cloud-erp` only says "An exception was raised".

## serviceInfo

- A service binding's services (`listServices`: binding type, OData version, service definitions
  and versions), and for a published one the service URL and entity sets (`getServiceInfo`).
- Unpublished OData V4: `serviceInfo` null with a note to publish (the backend reports the state for
  V4 only). On V2 a failed URL read goes into `notes` instead of failing the call.
- `service` picks one of several services; default the first.

## applyQuickfixes

- Every deterministic quick fix of an ATC worklist (`adtplus_quality atc` with `quickfixes`), on
  all its objects (`abap_atc_execute_deterministic_quickfixes`). No AI fixes: those need a Joule
  license.
- Gates on every object in the worklist, from the worklist's own package names (each package
  looked up once): allowlist and the mirror gate (ADR-009). One refusal applies nothing. A worklist
  without a fixable finding is refused. The objects are locked for other daemon commands while the
  fixes run.
- **A worklist is applied once** per daemon: its findings still offer the fixes afterwards, and a
  second run would apply them to the changed source. Run ATC again for a fresh worklist.
- An answer without `affectedObjects` isn't taken as "nothing changed": the result says the fixes
  may have changed objects and to check `listInactive`.
- The changed objects are left **inactive**; the result lists them (`changed`, a class for its
  include) and says to activate. `transport` records the change; without one a change
  that needs a request fails.
- `onprem`, `ABAP_CLOUD_READINESS`: `MOVE a TO b` became `B = A.`, `SELECT * FROM t INTO TABLE itab`
  became `SELECT FROM T fields * INTO TABLE @ITAB.` (upper case, not pretty-printed). The
  default variants found nothing fixable.
- `cloud-erp`, `FUNCTIONAL_DB` (also in the cloud default): "SELECT .. UP TO .. ROWS without ORDER BY"
  became `… ORDER BY PRIMARY KEY` on a line of its own, names upper case.

## deleteObject

- Delete by URI (adt-ls raw).
- An object in no open request (code 1001): with `transport` the deleted file and the main source
  are assigned to that request and the delete sent again; without, the error says to pass one.
- A message class, a domain or a data element: lock → DELETE, the same request rule as its
  `update`, checked gone.
- A package (`DEVC/K`): [packages.md](packages.md#delete).
- A translation project (`TRPR`, gates T and A): its language pairs, text sources and the project
  in one changeset, all or nothing; `transport` once its request is released. A pair holding
  someone's upload, not published, is refused (it would be lost; adt+'s own leftover may go). The
  translations it published stay in the objects. SAP's messages are reported; a read checks it's
  gone.

## deleteMessages

- A message class's message `numbers`, all or none: a number the class lacks refuses the call (SAP
  would answer OK).
- Read first (the deleted texts are in the result); the request rule of a message class `update`;
  checked gone.

## Known issues

- **A create of a CDS aspect (DRAS) or CDS type (DRTY) fails now and then** (`cloud-erp`, 2026-10-13):
  adt-ls answers "`creationAdapter` is null" (a Java NPE) and leaves nothing behind. It failed 3
  times in two sessions and worked 6 times in three others, also on sessions up for 8 minutes and
  without the creation form read first; cause unknown, no workaround verified (backlog).
- **`read` says `served: "active"` after `applyQuickfixes`** (`onprem` and `cloud-erp`, 2026-10-11): the fix changes
  the source in the backend, past adt-ls, whose `abapStat` still reports active while `read`
  returns the fixed, inactive text. Activate after the fixes; `version: "active"` reads the
  activated text.

- **Message classes over REST** (`onprem`, 2026-10-10).
  adt-ls 1.1.2 bundles SAP's plug-in but serves a placeholder and refuses writes and deletes
  ("Object type not supported: MSAG/N"). On the REST API: a PUT is an upsert (messages it leaves
  out stay; `mc:deletedmessages` deletes); an over-long text fails with "error when deserializing
  in ST_ADT_MESSAGE_CLASS"; deleting a missing number answers 200; a GET answers in the logon
  language with the master language as fallback per message, a PUT writes the master language;
  and a class no request holds is written **unrecorded** in a package that records changes (no
  "not assigned" error, the lock just names no request). adt+ checks the length, the numbers and
  the request itself, and reads in the master language. `cloud-erp` (after its software update, adt+
  2026-10-11): create, read, write, delete and the mirror round work as on `onprem`; its
  `ZADTPLUS_TEST` records nothing (the lock answers `IS_LOCAL` `X`, `transport check` needs no
  request), so a `transport` is accepted and unused there.
- **A message class's description change leaves a phantom object** (`onprem`, 2026-10-10, three
  classes). A PUT that changes the description
  records `LIMU MESS <class>` in the request, without a message number, and the object directory
  then holds `R3TR MSAG <class without its last three characters>` in the class's package
  (`ZADTPLUS_MSGPH_T1` → `ZADTPLUS_MSGPH`): the info-system search lists it, a GET answers 404, and it blocks
  deleting the package. Message writes and deletes, and a create's description, are recorded
  right. adt+ refuses a changed description (`update`, mirror push's `leftOut`).
  Creating a class under the phantom's name and deleting it removes the entry. Unknown whether
  Eclipse ADT (same API) does the same, and how the `LIMU MESS` entry imports. `cloud-erp` does the
  same in a package that records changes (`ZADTPLUS_ADT_DIFF_SUB`, 2026-10-11; `ZADTPLUS_TEST` there
  records nothing and leaves no phantom) (backlog "Message class description changes"). Retire when a description write is recorded
  right (`LIMU MSAD`?).
- **Search index can be stale** (a deleted object still found); resolve confirms by a read.
- **A create without a request in a package that records changes** (`onprem`, M4 live):
  DDLS, DCLS and DDLX fail with "Parameter corrNr could not be
  found"; an INTF is created in a request `onprem` generates itself ("Generated Request for Change
  Recording"); a class create answered HTTP 500 and still created the class, in another generated
  request. Mirror push therefore creates in such a package only with `transport` (REST package read
  of `recordChanges`); `object create` leaves it to SAP.
- **One failing object leaves a mass activation's non-DDIC objects inactive** (`onprem` and `cloud-erp`, M4
  live): tables and views activate, BDEFs, classes, interfaces, SRVD/SRVB, DDLX and DCLS of the
  same call stay inactive, unrelated ones included, and only the first error shows. Mirror push
  activates the objects left waiting with its next activation.
- **Activating objects with nothing inactive answers with no error** (`onprem` live):
  `adtLs/activation/activate` returns
  `isCheckExecuted: false`, `isActivationExecuted: false` and no diagnostic; `onprem` still says
  `isGenerationExecuted: true`, the cloud system of the second dev session review all three false.
  A refused activation runs the check (`isCheckExecuted: true`, error diagnostics), so the two can
  be told apart. `object activate` turns the first into an error ("nothing activated"). The mirror
  isn't affected: it asks `abapStat` what is active, not the flags.
- **A comment after a class's final `ENDCLASS` goes active without an activation** (`onprem`):
  the write succeeds, SAP's own `source/main`
  has the line in the active version, and there is no inactive version, so an activation finds
  nothing. The other places outside a class's includes are SAP's to refuse: a statement after
  `ENDCLASS` ("The statement THIS is unexpected"), a comment between definition and implementation
  ("The class contains unknown comments which can't be stored"). A comment before
  `CLASS … DEFINITION` goes into the public section as usual. A `"` comment before the first
  `METHOD`, between methods or before the last `ENDCLASS` is refused like one between definition
  and implementation. A comment on the line of the definition's `ENDCLASS`,
  `CLASS … IMPLEMENTATION` or the last `ENDCLASS` goes active without an activation like one after
  the last `ENDCLASS`; one on an `ENDMETHOD` line is stored in the method as usual. `update`
  and mirror push refuse every comment outside the sections and methods before writing
  (`core/class-regions.ts`), so the silent case can't happen through adt+.
- **A `//` comment in an SRVD fails its activation** ("Comments are not supported and will be
  deleted on save", an error on `onprem` and `cloud-erp`). `mirror check` doesn't catch it.
- **`cloud-erp` un-publish is refused for a while after a publish** (seen: refused up to +16 min, accepted
  at +10, +21, +62 min; a V2 binding too, accepted at ~+12 min on 2026-09-24); the trigger is
  unknown. `publish`/`unpublish` report an instant refusal as such; `settleTimeoutMs` re-sends every
  60 s (off by default).
- **OData V2 bindings: `allowedAction` is always PUBLISH, and `fetch_services` has no
  `isPublished`** (`cloud-erp`, 2026-09-23; `onprem` lacks `isPublished` on V4 too). `objectData.published`
  follows the real state. `publish`/`unpublish` take a V2 direction from `published` and reads back
  from the details when `fetch_services` has no state.

- **An incompatible field change to a database table holding data isn't activated** (`onprem` and `cloud-erp`,
  2026-10-14): CHAR 20 to INT4 with five rows answers two errors, "Field TEXT: Type changed from
  NVARCHAR to INTEGER" (`cloud-erp`: `DD_DBAL(008)`) and "TABL … was not activated" (`D0(408)`). The
  active version and the rows stay as they were, the change stays an inactive draft. With the
  table empty the same activation passes. SAP's database adjustment (SE14's) is reachable as
  quick fixes on the table name, on both systems (`cloud-erp` included), but adt+ doesn't offer them yet
  (backlog, "Tables holding data"). A conversion that meets a
  value it can't convert aborts and leaves the table half-converted; on `cloud-erp` nothing in ADT
  undoes that (the table can't even be deleted).
- **Deleting a database table drops its rows without asking** (`onprem` and `cloud-erp`, 2026-10-14):
  `deleteObject` on a table with five rows answers like any delete.

Cross-cutting ones (an object in no open request, one lock attempt per session, a dead session's
lock, the subtyped search filter): [known-issues.md](../known-issues.md).
