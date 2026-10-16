# Backlog

Open work only. Delete an item when it's done; the commit message tells the story. Nothing here blocks
daily use. Write an item in a few lines: what, why, where it stands, with the evidence it needs.

## Order

Agreed order (user, 2026-10-10); everything else has none yet.

1. [Gap review](#next-gap-review-2026-10-10), step 3: source code search, TTYP (DOMA and DTEL done, their shared lifecycle too).
2. Gap review, step 4: class surgery, transports beyond own requests.
3. When ADT for VS Code 1.2 ships (Q4/2026): probe the new adt-ls, retire the REST fallbacks it
   covers (end of the gap review section).

## Next: gap review 2026-10-10

Goal (user, 2026-10-10): adt+ alone covers day-to-day agentic ABAP work, with no other ABAP MCP
server needed.
Start in this order:

Step 1, retiring the ADT MCP Server, is done: the tools since 2026-10-11, the server switched off in VS Code
2026-10-12.

Step 2, the debug loop, is done: syntax of unsaved text, short dumps, gateway error log and
system messages. Mirror `check --remote` can now use `navigate
syntax` with `source` (deferred item below).

3. **Small and independent**, in this order:
   - **Source code search:** REST, on-prem only (SAP's tool for it: 2702/2027); refuse clearly on
     `cloud-erp`. Result capped and paged;
   - **Later sessions:** TTYP create and edit (REST, like DOMA; SAP plans none; a kind in
     `rest-form-object.ts`, its AFF schema in `properties.ts`'s `FORM_TYPES` (read and update
     route by it) and an entry in the daemon's `REST_FORMS`); the TABL gaps: mirror create for
     TABL/DS, technical settings and indexes (separate ADT objects; in scope or a known limit is
     undecided);
   - **Tables holding data** (live 2026-10-14; user to
     decide each):
     - an incompatible field change isn't activated while the table has rows; SAP's message only
       says "Type changed from … to …". The adjustment exists as ADT quick fixes on the table
       name, on `onprem` and `cloud-erp`: `adjust_ddic_table` (convert data), `adjust_ddic_table_delete_data`,
       `ddic_delete_db_table`, and `continue_adjust_ddic_table` after an aborted conversion. Where it
       goes (an `activate` option, its own action, or `applyQuickfixes` for source objects) and
       its gate are open; ADR-018 and the write gates (ADR-003) decide. The apply request
       must carry no `sap-client`/`sap-language` in its URL (SAP looks the fix up by the full URI
       and dumps otherwise), so RawAdtClient needs a way to send them as headers only.
       Destroying data (delete data, delete on database) needs a confirm like `deleteObject`'s.
       A conversion that hits a value it can't convert aborts with "Operation was aborted" and a
       short dump (`CONVT_NO_NUMBER` in `RADGENREP`), leaving the table half-converted: say so,
       and name the dump and the `QCM` table. On `cloud-erp` that state couldn't be undone through ADT at
       all, so a convert there needs a check first that the data converts;
     - **leftover on `cloud-erp`:** `ZADTP_TB_PROBE` is stuck in an aborted conversion; ADT has no
       "Unlock table" (`RFAC_QUICKFIX` lists none). SAP incident under "Upstream" below;
     - quick fix 319 "Activate '&1' and adjust dependent objects" (a domain or data element whose
       change needs dependent tables adjusted) belongs with DOMA/DTEL `activate`; not probed yet;
     - `deleteObject` drops a table with its rows without a word: count them first (data preview,
       if allowed) and refuse or warn.
4. **After that:**
   - **Class surgery:** add a method, change a signature, delete a method, as read + splice +
     `updateSource` (method read exists), locating through abaplint's parsed statements
     (ADR-012), never our own parser;
   - **Transports beyond own modifiable requests:** list other owners and statuses (probe
     `searchTransports` parameters), then delete, `remove_object`, reassign (REST).

**When ADT for VS Code 1.2 ships** (Q4/2026; SAP's Tools roadmap, re-read 2026-10-10): probe the
new adt-ls read-only on `onprem` and `cloud-erp` for the requests behind DEVC, the Transport Organizer
(release, released requests), the Timeline view, DTEL, MSAG, the SQL Notebook and the Dictionary
Activation Log; retire the REST fallbacks it covers (known-issues "REST fallbacks"); decide whether
the activation log belongs in `activate`'s errors (TABL/DDIC activations). The `adtls-upgrade.md`
checklist runs first.

Not planned (same review): completion, SQL/profiler/auth traces, `odata_perf`, `cds_sql`, FLP,
`set_api_state`, `change_package`, abapGit/gCTS, KTD, ARC-1's `SAPContext deps/impact`.

## Upstream (SDK, abaplint)

- **SAP incident to file: an aborted table conversion on `cloud-erp` that ADT can't clear** (2026-10-14;
  the user files it): `ZADTP_TB_PROBE` (TABL/DT, `ZADTPLUS_OBJTYPES`, request `DEVK900785`) is
  locked by an aborted conversion; ADT offers no unlock, the delete is refused. The draft text, what was
  tried and the logs to attach are kept outside the repo.
  Once SAP has cleared it, delete the table and this item; if SAP names a way ADT can do it
  (another quick fix, a Fiori app), note it in `tools/objects.md`.
- **Upstream issues to file** (need a design talk with the maintainer first; no
  system/object names in public texts):
  - warn/strict mode when adt-ls ≠ `VERIFIED_ADT_LS_VERSION`;
  - `extraCaCerts` should cover the Node ticket GET too (today needs
    `NODE_EXTRA_CA_CERTS`);
  - no automatic re-logon after a 401 with Basic auth (account lock counter).
    `basic` has sent `sap-client` since 0.6.1, but it retries on every
    `requestBrowserBasedLogon` and only logs a failed ticket GET; with a
    one-attempt guard and a reported failure, `onprem` could drop its `custom`
    handler (`core/session.ts`);
  - transport assign: `transport.assign` checks the CTS lock after assigning,
    and that check cancels the assignment for an object in no open request
    (the next write would record it). Offer an assign without the read-back,
    and `MODIFICATION` in `check`'s operation type (VS Code sends it). adt+
    uses `raw.lsp` `assignTransportToObject` until then. Also: `assignTransportToObject`
    takes an `objectUri` but holds for that one file's next write (adt-ls 1.1.2 keeps it in
    the file's lock result); document
    that, or make it object-wide;
  - ABAP Unit risk levels: `runUnitTests` and `runUnitTestsWithCoverage` take
    no `riskLevels`. adt-ls's `adtLs/abapUnit/runTests` does
    (`HARMLESS`/`DANGEROUS`/`CRITICAL`); the `abap_run_unit_tests` MCP tool
    hard-codes all three. Add the option, and route `runUnitTests` through the
    LSP request when it's set. Evidence:.
  - Waiting for evidence: the CLAS create HTTP 500, DDLX delete.
  - `format` takes text (2026-10-12, ADR-017): adt-ls formats the text `didOpen` sends, but the
    SDK's `format` sends the stored source only, and `raw.lsp` sends no notifications. With
    text, engine `sap` formats CDS text too and the REST pretty printer fallback retires.
  - adt-ls LSP methods the SDK doesn't wrap (from the 1.1.2 method list;
    untested headless). Probe read-only
    on `onprem` and `cloud-erp` first, then file feature requests for the ones that work:
    `fileSystem/getPackageName`, `getObjectName`, `getFolderUri`, `stat`
    (package/name/folder for a URI without a search); `fileSystem/lockFile`,
    `unlockFile` (explicit locks); `businessservice/srvb/getPreviewURL`,
    `getServiceEntitySet`; `abapUnit/discoverTests` (list tests without
    running); `cts/transport/searchTransportsSimple` (check overlap with
    `transport.list`). The other ~50 are VS Code UI plumbing (debugger, model-driven
    forms, code prediction, destinations/projects, editor notifications).
  - logon failures don't name the network: without the VPN, `connect` fails as
    "did not reach 'connected' (no logon result)" (known-issues). The SDK's
    `ensureLoggedOn` gets no logon result and drops the cause; it should report
    the host as unreachable (DNS/TCP/TLS error). adt+ doesn't probe the host
    itself (user, 2026-10-06: no SDK workarounds);
  - one lock attempt per session: adt-ls refuses a write while another one on the same session
    is locking ("another lock attempt is still in progress"; the SDK's 0.7.0 queue is per object).
    The SDK should queue lock attempts per session. Until then only mirror push retries
    (`retryLockBusy`); other writes aren't given the retry (user, 2026-10-06: no SDK workarounds);
  - `abapStat` on a file its folder doesn't list (a class without test classes, `cloud-erp`) throws a plain
    `Error` "abapStat returned no version for <uri>", like any other failure. A typed not-found
    (or `undefined`) would let callers tell them apart; adt+ lists the folder after a failed stat instead;
  - the per-object queue (0.7.0) covers source, lifecycle, repository file
    and navigation calls, not quality, services or `raw`. With those in the
    queue too, the daemon's exclusive lock around the active read could go
    (known-issues).
- **Upstream (SDK), from `object read`** (ADR-010):
  `source.read({version: 'active'})` on an object without an active version throws the generic
  "did not switch … to the active version"; adt+ matches that text. A typed error, or a check
  before the toggle, would be sturdier. Not yet seen on `onprem`.
- **Upstream to abaplint: MSAG from AFF** (2026-10-10; ADR-012): `msag_consistency` reads neither
  the name nor the messages from a `.msag.json` ("Message class name "undefined""), so `mirror
  check` drops it and checks the file itself (`msag_file`). Propose reading AFF's `msag-v1`.
- **Upstream to abaplint: namespaced interface method** (2026-10-11; ADR-012): abaplint's
  `MethodName` takes no namespace after `~`, so `METHOD zif_x~/ns/m.` parses as an unknown
  statement (abaplint 2.120.54). Propose `^(\/\w+\/)?\w+(~(\/\w+\/)?\w+)?$`; once released,
  delete the stopgap in `implementedMethod` (`core/abap-statements.ts`).
- **Upstream to abaplint: `no_comments_between_methods`** (user, 2026-10-10; ADR-012; the user
  opens the issue/PR). Probed on `onprem`: (1) the
  rule misses comments between definition and implementation and after the last `ENDCLASS`
  (own line, or on the line of the definition's `ENDCLASS` or the last `ENDCLASS`): SAP refuses
  the first and takes the others into the active source without an activation; (2) it flags a
  comment on an `ENDMETHOD.` line, which SAP stores in the method's include (false positive).
  Draft the issue text with the probe table; once released, delete the stopgap in
  `core/class-regions.ts` and the filter `isEndMethodLineComment` in `mirror/lint.ts`.

## Objects, navigation, transports, quality

- **Catalog types, open after the `cloud-erp` and `onprem` probes** (2026-10-13;
  the probe objects stay in `cloud-erp`'s `ZADTPLUS_OBJTYPES`, `onprem`'s holds the two fixtures only):
  - **Function groups in the mirror:** push should activate an edited function module (or
    include, FUGR/I on `onprem`) by its own file, not the group's main program; `mirror check` should not fail on the
    `.func.json`/`.reps.json` adt-ls serves without AFF's required `includeNumber`/`header`.
    Undecided (user, 2026-10-13): a schema exception per file kind, or the fields filled on pull
    (which a push would send back though adt-ls never sent them). Then claim E/A for FUGR.
  - **SDK: five more subtypes for `searchTypes`** (`DRTY/STY`, `DTEB/DF`, `CHDO/CHD`, `RONT/ROT`,
    `DRAS/RAS`, `onprem`): propose them for the SDK's `SUBTYPE_FILTER_MISSES`, then drop
    `core/search-type.ts`.
  - **Report the JSON types' syntax bug to SAP** (CHDO, NROB, RONT, NONT, DESD: "Json factory
    must be set as load option"), with an adt-ls trace of the failing check.
  - **DRAS/DRTY create fails now and then** ("`creationAdapter` is null"): not reproduced on
    demand; the native wizard route (`objectCreation/create`) fails the same way, and neither a
    form read first nor session age made the difference. Note the session's history the next time
    it happens, then report it to SAP.
  - **NROB:** `ZADTP_APNR` uses `CHAR10` for now (user, 2026-10-13). Whether it moves to an own NUMC
    domain once DOMA create exists (gap review step 3) is undecided.
  - **NONT on `onprem`:** create answers "Unsupported Media Type" (supported:
    `application/vnd.sap.adt.objecttype.new.content.add`), from the federated tool; untried: the
    VS Code wizard's route (`objectCreation/create`). If that fails too, `onprem`'s release (7.58)
    likely can't, as with DRAS; else report it to SAP with the media type. ADT's discovery
    doesn't tell: `onprem` advertises NONT like RONT, which works.
- **Accept a caller's `uri` on refs** (the adt+ side of adt-ls#29, released in
  0.7.0): `resolve`/`search`/`list` hand out URIs, and passing one back would
  save the name search (2 counted calls per ref, ADR-005). Today the daemon
  drops any `uri` a client sends and passes on only URIs it resolved itself,
  because the write gate reads the package off the URI. First probe on a
  throwaway whether adt-ls serves a hand-built repotree path that puts a
  foreign object under an allowlisted package; if it does, take the package
  from the system (`fileSystem/getPackageName`) instead.
- **From an agent run in VS Code** (user, 2026-10-02):
  - **Where-used on an interface method:** `references` at the method's
    declaration in the interface returns only the implementing class, not
    the callers (`onprem`, `ZIF_ADTPLUS_B_PRICING`/`calc_price`). From the implementing
    class (`INTF~METH`) it returns the callers. Find out what the 135 hits from
    there are (calls or type uses), then make `references` on an interface
    method go through an implementation, or say so in a note.
- **Message long texts** (user, 2026-10-12): read and write a message's long text, and with it
  the "self-explanatory" flag, which adt+ leaves untouched until then (ADR-018). Not in adt+
  today: Eclipse ADT edits long texts only in the SAP GUI (SE91), ADT for VS Code 1.2 plans
  message classes without them, and AFF's `msag-v1` has no field for them. First find out whether
  any ADT REST endpoint serves them (on-prem and cloud), read-only on `onprem` and `cloud-erp`; then decide the
  shape (a key next to AFF's, an upstream proposal to AFF).
- **Format, follow-ups** (ADR-017, 2026-10-12; not asked for yet):
  - a format that writes back (an action, or `updateSource` with a format flag) is a write path
    under ADR-003 and needs its own decision;
  - `mirror format`: a mirror's files formatted locally, before a push (engine `abap-cleaner`, or
    `sap` through the REST pretty printer for ABAP). abaplint's `PrettyPrinter` would do it with
    nothing installed and no SAP call (1 ms; keyword case and statement indentation, ABAP only;
    continuation lines stay where they are, no alignment; a broken statement left as is), so an
    engine `abaplint` fits here, not as `navigate format`'s default (user asked, 2026-10-12);
  - abap-cleaner's daemon mode (`--daemonize`, a local port) instead of a process per call, if
    1.5 s per format turns out too slow;
  - class includes (local test classes) for the stored source: adt-ls formats the main file only.
- **Cap ABAP Unit risk level in `adtplus_test`** (user, 2026-09-24): default
  HARMLESS, with a caller option to allow DANGEROUS/CRITICAL. Waits for the SDK
  option (upstream item above); no `raw.lsp` stopgap. Verify live that a
  DANGEROUS test class is skipped. The client's max risk level stays the outer
  limit.
- **Not verified live:** a positive `transport assign` that moves a BDEF into a
  new request.
- **Trace the untraced SDK methods** (ADR-008): measure with ADT's traffic trace
  (`com.sap.adt.communication.trafficlog` at INFO, in adt-ls's work dir) over ATC, ABAP Unit, navigation, delete, the active-version read and
  the services calls, and give each its measured weight in `unitsOf`
  (`daemon/ratelimit.ts`); until then they weigh 3.
- **ABAP Unit locally through abaplint's transpiler** (mirror plan M6, optional; not agreed):
  `@abaplint/transpiler` with its runtime and an in-memory database, to run a mirror's unit tests
  without the system. Feasible for self-contained logic; RAP, CDS and SAP-delivered dependencies
  make it hard in general. AFF's CI shows the toolchain runs real ABAP.
- **abaplint with SAP dependency stubs** (user, 2026-10-04; mirror plan M6, "stage 2
  with dependency stubs"): try abaplint's `dependencies` config with the
  public repository of stubs for common SAP objects (abaplint's `deps`), so
  `check_syntax` knows SAP's interfaces and superclasses. Today it calls
  `if_oo_adt_classrun~main` and `cl_abap_behavior_handler` "not found", so it
  is off by default (ADR-012); with the stubs it might find mistyped calls
  and unknown methods before a push. Open: which repository and how current
  it is for the ABAP Cloud / 7.58 APIs; shipping or caching it, since `mirror
  check` runs offline; how many false findings remain on the M5 mirrors and
  `cloud-erp`'s `ZADTPLUS_DEMO_2508`. It would not have caught any of the M5 activation
  errors, which were all in TABL, BDEF, DCLS or DDLS.
- **Evaluate open-steamgate with the local-ABAP items above** (user, 2026-10-16): [oisee/open-steamgate](https://github.com/oisee/open-steamgate)
  is a local runtime for classic code-based SEGW services (`/IWBEP/` OData v2): it transpiles
  ABAP, runs Open SQL over SQLite and serves Fiori. Write-up by its author: "I only wanted to run
  a little ABAP" (Alice Vinogradova, LinkedIn Pulse). Look at it next to `@abaplint/transpiler`,
  open-abap and abaplint's `deps` stubs: what it reuses from them, how far its Open SQL and
  runtime go beyond self-contained logic, and whether it helps a mirror's local unit tests or
  checks without the system. Evaluation only; no decision yet.
- **Message class description changes** (2026-10-10, `tools/objects.md` "A message class's description
  change leaves a phantom object"). On `onprem` a REST
  PUT that changes the description records `LIMU MESS <class>` without a message number and leaves
  a phantom `R3TR MSAG <class minus its last three characters>` in the package; adt+ refuses the
  change (`updateMessageClass`, mirror push's `leftOut`). Open:
  (`cloud-erp` shows the same phantom, 2026-10-11.)
  1. what Eclipse ADT (same API) and SE91 record for a description change (`LIMU MSAD`?), and a
     REST call that records it right; then lift the refusal;
  2. whether the `LIMU MESS <class>` entries in `DEVK914405` matter before that request is
     deleted (an import would read them as message `<last three characters>`).
- **Change recording: checking it, and a request nobody needs** (user, 2026-10-11, message class
  writes on `cloud-erp`). Two open points:
  1. finding out whether a write needs a request costs a call per write (a class no request holds:
     +1 package read for `recordChanges`; `transport check` is another path). Find a cheaper way
     (cache per package for a session, or the lock's answer: `IS_LOCAL` `X` and an empty `CORRNR`
     on `cloud-erp`'s `ZADTPLUS_TEST`) and use one rule for every write path;
  2. a `transportRequestNumber` on a write in a package that records nothing (`cloud-erp`
     `ZADTPLUS_TEST`) is accepted and not recorded, silently. Undecided whether to refuse it (the
     caller expects a recording that doesn't happen) or to pass it and report it unused in the
     result; decide for all write paths, with an ADR if it changes a gate.
- **Translations, follow-ups** (ADR-019, built 2026-10-13: `object translations`, `TRPR` read,
  create, update incl. texts, delete; `docs/tools/objects.md`):
  - Probe whether the `LTO_*` types keep their texts in one record per language like data
    elements; only on a throwaway, which adt+ can't
    create so far.
  - Not offered, by decision: removing a text source or a language pair, a request picker
    (`getTransports`, below), mirror support for translations (ADR-007).
- **`getTransports` of the translation service behaves oddly** (user, 2026-10-12, translation
  probe): for the empty, transportable `ZADTPLUS_ADT_DIFF_SUB` it listed 16 modifiable requests,
  nearly all unrelated to the package ("Kochbuch", "Feature showcase", …). For the local
  `ZADTPLUS_TEST` it listed none. The answer names no owner and the filter rule is unknown
  (transport layer? target? only the user's requests?). Find out before adt+ shows or uses these
  requests anywhere: compare with a package of another software component and with a colleague's
  request.
- **A REST request that hung for minutes** (found 2026-10-12, translation probe): a message class
  read in DE (`readMessageClassDefinition` with `language`) got no answer while other calls on
  the same session answered. Cause unknown; the same call wasn't repeated. REST requests now give
  up after 120 s. Reproduce it on `cloud-erp` (same session, a
  read in another language after an OData write?) and find out whether SAP or the session is at
  fault.
- **One paging convention for the whole surface** (user, 2026-10-12): today `transport diff` pages
  by `cursor`/`nextCursor`, `dumps`/`gatewayErrors` move a `to` time window, `search`/`versions`/
  `list` only cap with `maxResults` and `truncated`, `read`/`diff` cap lines with `maxLines`, and
  `data` doesn't page (ADR-013). ADR-019 introduces the convention for the translation reads only:
  `maxResults` caps a page, `truncated` says it was cut, `nextCursor` → `cursor` fetches the next,
  and the cursor names the last entry rather than a position. Define it for every listing (a new
  decision amending ADR-018), decide per tool whether it pages, and move the others to it.
- **A read-only key is accepted when unchanged** (2026-10-12, from ADR-019): ADR-018 refuses
  read-only keys in `properties` (`formatVersion`, `header.originalLanguage`, DEVC's gate keys), so
  a read can't be sent back as it is. ADR-019 accepts them on TRPR when they equal the current
  value and refuses them when they differ. Apply the same to MSAG and DEVC (a write path:
  `/code-review high`).

## Session review follow-ups

- **Dev session review** (2026-10-07). Not started; the `git-remote` branch works on
  something else, so take these on a branch of their own. In order:
  1. partial-set activation: `mirror.activate`/`push` fail with SADL "Stack is empty" when only
     the pending objects are sent; activating the whole dependent set (including already-active
     peers) worked. Probe, then retry with the full set; correct `abap-mirror` §2 and add a
     `known-issues.md` entry (Opus: live failure);
  2. `navigate.syntax` reported 0 findings on drafts that failed activation with CDS compile
     errors: probe whether it checks the inactive draft;
  3. `mirror.check`: the behaviour-pool handler forms `FOR INSTANCE AUTHORIZATION`,
     `FOR GLOBAL AUTHORIZATION`, `FOR PRECHECK` come back as `parser_error` (ATC clean), so
     `ok` is always false; drop them per type (`tools/mirror.md`, "abaplint on AFF files") and
     consider a changed-files-only mode;
  4. `runAtc` with `name` + `objectType` answers `{"atcRunCheckResults":[]}`; give it the batch
     summary shape;
  5. outside this repo: review cadence in `abap-mirror` step 6 and `sap-reviewer` (17 runs in one
     session), confirm the system once per session, `ADTPLUS_LOG=1` in `mcp.json` for dev
     work.
- **Dev session review 2** (2026-10-09). Item 1 (assign on write, `transport find`'s
  `isCreation`), item 2 (`activate` with nothing inactive is an error), the first two parts
  of item 3 (`check` and deleted files; the empty push: the agent's parallel edit)
  and item 4 (message classes) done 2026-10-10;
  the rest not started. In order:
  3. mirror: read-only stub files make a plain `rm` prompt;
  4. message classes, leftovers: the user accepts ADR-014 (proposed); messages removed from a
     `.msag.json` stay reported (`leftOut`) until "Deletions in mirror mode" below decides; the
     empty throwaway package `ZADTPLUS_MSAG_MIR` on `onprem` refuses its delete ("still contains
     development objects", nothing listed); the git helper's fetch of a message class live (a
     clone, not run in the session that built it). The git helper's history can't show message
     changes per request: no version feed for message classes (404);
  5. outside this repo: agents write through `updateSource`/mirror, not `abap:` VFS patches
     (dirty editor holds the lock); use the workspace's single system instead of asking; move
     the user rules from Copilot's memory tool (i18n default bundle in English, develop in
     English, `sap-language=EN` when testing) into instructions or a Fiori/UI5 skill; one
     default docs route; trim the always-on file; update the work workspace's `AGENTS.md` and
     delete leftover mirrors; in `abap-mirror`, repeat the mirror tools' rule: never a mirror call in
     the same tool round as a file edit or `rm` (both item 3 incidents).
- **Smaller items from 2026-10-04** (batch checks, abaplint rules):
  - batch summaries list every copy of an identical finding (`onprem`'s SLIN
    time-zone info once per object, ~300 characters each); group identical
    check + message;
  - `quality abaplint` lints a class's main source only, not its includes
    (local handler classes in `.clas.implementations.abap`);
  - probe `workspace/diagnostic` (in adt-ls's method list) as a multi-object
    syntax route;
  - `no_inline_in_optional_branches` (ADR-012's likely-bug list; 12 of the 24
    findings on `ZADTPLUS_MB_REFAC`) — still state of the art and Clean ABAP
    compliant? (user) Clean ABAP's current section is "Do not use variables
    outside of the statement block they are declared in": an inline
    declaration inside `IF`/`LOOP` used only there is fine. The rule flags
    any inline declaration in such a block, like the guide's older "Don't
    declare inline in optional branches". Check the upstream guide and
    abaplint's rule docs (an option or a successor rule that checks use
    outside the block); otherwise drop it from the default;
  - `abap-mirror` agent skill: name the recurring RAP mistakes until the
    checks above exist (the batch-ATC line is in).

## Mirror and git remote helper

- **Domains and data elements in the mirror** (user, 2026-10-14: separately, after the object
  tools): pull a `.doma.json`/`.dtel.json` in AFF instead of the stub, push and create them through
  the REST fallback, as ADR-014 does for MSAG; needs its own ADR. Activation order in one push:
  domains, data elements, then tables.
- **Mirror mode, open from M5** (M0–M5 done; ADR-007, -011, -013, -014, -016, -017):
  - routing rule 2a's proposals in  "Proposals" (user to
    decide), among them `.clas.locals_*` errors in `mirror check` (no VS Code run on a stronger
    model: user, 2026-10-06);
  - agent skill fixes: the RAP mistakes in `abap-mirror` (also under "Smaller items from
    2026-10-04"); `sap-reviewer`'s model (item below).
- **RAP checks in `mirror check` — leftovers** (built 2026-10-05, ADR-012): run them over the
  M5 mirrors for false errors; DCLS grammar (`;` where `FALLBACK` was expected) once the error
  text is at hand; release-dependent rules (`@Semantics.currencyCode` refused on view entities)
  with the release's feature data (item below); whether SAP accepts a projection BDEF written
  `strict ( 2 ); projection;` (the check follows push's refusal).
- **From the M4 live run**:
  - `mirror check` could flag a comment in an SRVD, which fails its activation;
  - `object create` leaves a create without a request in a recording package to
    SAP (refused for some types, a generated request for others); it could
    refuse it like mirror push does.
- **Mirror M1b — pull beyond whole packages** (ADR-007 "Decided, not built yet",
  left out of M1 to keep it to the core loop; each adds to what M1 built):
  - `pull --objects <type:name,…>`: single objects outside the root packages,
    under the same package-prefix rule and ceiling;
  - `pull --where-used`: also the objects that use the pulled ones;
  - `pull --active`: active versions of source files through
    `source.read({version: 'active'})`, the other files as adt-ls serves them,
    the result saying which.
- **Deletions in mirror mode** (user, 2026-10-10: decide in general, in a session of its own).
  Today push sends no delete (ADR-007): a deleted file or object is `deletedLocally`, a deleted
  package folder too, the git helper refuses a commit that deletes files, and a message removed
  from a `.msag.json` is `leftOut` (ADR-014). Decide whether and how a push deletes: whole objects
  (through `deleteObject`, gate C's confirmation), parts of an object (a class include, a function
  module, a message), packages; what confirms it in the MCP tool, the CLI and a git push; the order
  against creates and activation (where-used first?); and the conflict rule for an object changed
  on the system since its base. Reverses ADR-007's "deletes aren't pushed", so it needs a new ADR.
- **Git handling for mirrors** (user, 2026-10-03; to discuss before building
  anything): the system stays the source of truth, so a mirror's git history is
  a local aid (fallback, diffs for review). Open: a mirror inside a project that
  is already a git repository — commit there, keep the mirror in a repository of
  its own, or gitignore it in the parent. Until settled, the `abap-mirror` agent skill
  commits only in the mirror's own repository and asks otherwise.
  In the M5 VS Code runs of 2026-10-04 the rule wasn't followed on an empty
  repository opened as the first folder: no commit without asking, or a
  question first, in all three refac runs.
- **Mirror default backend: git?** (user, 2026-10-13; evaluate, don't build yet). Today a
  mirror is AFF files on disk, and git is opt-in: the git remote helper needs
  `mirror.git.enabled` per system, and a mirror's own history is only a local aid (item above).
  Evaluate making git the default backend for mirrors: what the default stores (the mirror as a
  repository, the manifest, the shadow mirror under `$GIT_DIR`), how it treats a project that is
  already a repository (open point above), and what changes for the `abap-mirror` skill's commit
  rule. Start from ADR-007 and ADR-011; the result changes them (an edit, or a new ADR if it reverses one).
- **Git remote helper leftovers** (G0–G7 done, ADR-011):
  - **The open requests in a sync commit's body:** name the requests that hold its changes
    (plan, "from G6"). The holder is in each changed object's version feed (`00000`/`99999` name
    whoever holds the object now, P6): 1 feed read per changed source file, so only for objects
    the fetch re-read. Or, cheaper with many changed files and few open requests: adt-ls's
    modifiable-request search, then `transport read` (1 request each, any owner) and the
    entries matched to the changed objects; unprobed
    whether the search reaches other owners' requests.
  - **Runtime probes for `swc.packages`, `history.versions`, `history.released`** (ADR-002: every
    fallback has one; these report `nativeAvailable: null`, known-issues "REST fallbacks"). The
    history pair could share `changeStamps`' signal (a timeline or version-history tool in
    adt-ls's tool list); for software components no signal is known yet.
  - **ADR-009's hold for objects a clone holds** (ADR-011: not in v1): whether the MCP server's
    `update` hold also looks for `.git/adtplus/*/` shadows under the MCP roots. A direct
    write to a cloned object is caught by the next push's conflict check today. Changes ADR-009
    and ADR-011 ("Consequences").
  - **An agent skill for git clones**, if at all: how an agent works in a clone (fetch before
    work, push options, what an `error` means), next to `abap-mirror`. Only once clones are used
    by agents.
  - **Drop the shadow mirror** (an idea, not agreed): give pull and push an abstract file store
    (disk or git tree) so the helper works on git objects directly. Means reworking `push.ts`;
    left out of v1 (ADR-011).
- **A pool of adt-ls sessions for bulk reads** (user, 2026-10-07; after P7, ADR-008; parked until
  clones of large trees are frequent: the
  draft flag from `listInactive` took the 1,477-object clone from 27 to 23 min, the reads now
  bound it): adt-ls runs
  one call at a time per session (P7: cold reads 6.8/s with 1 in flight, 8.1/s with 3, 7.4/s
  with 5), while SAP scales (REST 13.5 → ~40 → ~66/s). A small pool of extra adt-ls sessions,
  used only for pulls and fetches, never for push (locks and caches are per session), opt-in per
  system (e.g. `mirror.readSessions: 3`). `cloud-erp` needs no extra SSO window: each session's logon is
  answered with a ticket minted from the one REST session (ADR-001). Costs a JVM per session and
  more SAP sessions in SM04. Its own ADR and a probe on `onprem` and `cloud-erp` first.
- **SSO window in the right browser profile** (user, 2026-10-13). `openBrowser` in
  `core/session.ts` runs `open <url>`, so the SSO logon (`cloud-erp`, any interactive system) opens in
  the default browser's last-used profile, not the one the user signs into SAP with. Pick the
  browser and profile per system (a `systems.json` setting, or the profile the system's SSO
  last used), and open the URL there. Probe first: which launch flags each browser takes for a
  profile on macOS, and whether adt-ls's `requestBrowserBasedLogon` can name the window or only
  the URL. Needs a config field under ADR-018 naming.
- **Adjust the adt+ connected page** (user, 2026-10-13). The SSO logon ends on the page that
  `core/reentrance.ts` serves at its localhost callback: a bare `<h3>adt+: connected. You can
  close this tab.</h3>`. It answers every request with that text, even one without a
  `reentrance-ticket`, so a stray hit reads as success before the logon has finished. Change the
  page itself (wording, layout, and what it shows on a missing ticket or a timeout), and keep
  tickets and system data off it (ADR-001). The exact change is not yet agreed with the user.
- **Catch tab indentation early** (user, 2026-10-16). Source with literal tabs got into SAP
  through the mirror or a write and showed as wrong indentation; the user had to ask for a
  formatting pass afterwards (37 of 123 sources changed). ABAP source indents with spaces, so
  `mirror push` (and `mirror check`) should refuse or at least warn on tabs in an object file,
  before anything is sent. Open: refuse or warn; tabs only in indentation or anywhere (string
  literals, comments); whether `object_write` gets the same check; and where the tabs came from
  in that session (the model's patches, the editor, or the pull), which the transcript doesn't
  show. Local check through abaplint's whitespace rules if one fits (ADR-012), not our own parser.
- **A cancelled call keeps its adt-ls slot, and everything behind it hangs** (user, 2026-10-16;
  from a session that became very slow). `quality atc` over 45 objects
  with quickfixes ran 6 minutes, VS Code cancelled it, and for the next 10 minutes every adt-ls
  call (object read, where-used, delete) ended `Canceled` while REST-fallback calls still took 2 s;
  restarting the daemon cleared it. Neither `mcp/server.ts` nor the daemon client passes
  cancellation on, and adt-ls runs one call at a time per session (ADR-008), so an abandoned call
  blocks the queue until it ends (ATC: up to `timeoutMs` per object). To decide: pass the abort
  from the MCP call to the daemon and stop the work (ATC polling, SDK call where it allows);
  a total time budget for `atc` that returns the objects done so far; a call that waits too long
  behind another says so (and what it waits for) instead of hanging; and the call log records
  calls that started and never finished (today only completed ones appear). Not yet proven that
  the ATC was still running; check `calls.jsonl` and the daemon for an in-flight entry first.

## Platform and operations

- **Windows and Linux support** (user, 2026-09-28). adt+ has been tested on macOS only so far.
  What ties it to macOS:
  - basic-auth passwords come from the macOS Keychain through `security`
    (`core/keychain.ts`); needs a store per platform: Windows Credential
    Manager (PowerShell, built-in) and Linux Secret Service (`secret-tool`, not
    always installed), or the `keytar`-style route if a dependency is accepted;
  - the project-config approval dialog is an NSAlert through JXA
    (`core/trust-dialog.ts`); elsewhere only the weaker terminal question
    exists. Windows: PowerShell + WinForms (built-in); Linux: `zenity` or
    `kdialog` when installed, else the terminal question;
  - the daemon listens on a Unix socket (`daemon/protocol.ts`
    `resolveSocketPath`); Windows needs a named pipe
    (`\\.\pipe\adtplus-<user>`);
  - check the adt-ls binary lookup (`core/adtls-version.ts` parses the
    `darwin-arm64` extension folder name) and the path handling in tests.
  Until then the README says it has been tested on macOS only. When it lands, add `windows-latest` to the CI
  matrix (`.github/workflows/ci.yml`).
- **CLI command to onboard a new system / customer** (user, 2026-10-01), e.g.
  `adtplus system add`. Adding a system today means hand-editing config files
  (`docs/configuration.md`, ADR-006 layered config). The command should write the
  system entry (host, client, auth kind, allowlisted packages) to the right
  config layer, store a basic-auth password through the Keychain (never from an
  argument, never on the command line), and offer `system connect` to check
  the logon. Design questions to settle first: which layer it writes to (user
  vs. project), whether a customer is a group of systems, and what it does about
  the project-config approval dialog.
- **Strip `ADTPLUS_DENY`/`ADTPLUS_READONLY` from the daemon's spawn env** and rely on
  the per-request stamp (known-issues → Operations). Latent until someone sets
  either in `mcp.json`.
- **One bounded-concurrency helper** (review of the transport diff, 2026-10-10): the same
  queue/`Promise.all` worker loop exists in `capabilities/transport-diff.ts`, `mirror/history.ts`,
  `mirror/component.ts` and `capabilities/quality.ts`, with different stop rules on the rate
  limit's refusal. One helper in `core/`.
- **A local test system: ABAP Cloud Developer Trial, SAP S/4HANA 2025 foundation** (user,
  2026-10-07): a system of our own for live tests and probes, so they no longer depend on `onprem` and
  `cloud-erp`.
  - Its setup, documented in `docs/testing.md`, and a `systems.json` entry.
  - Which live tests and probes move there.
  - Which of the live-test rules (throwaway objects in allowlisted packages) still apply on a
    system of our own: the user's call.
- **abapGit's integration-test repositories as fixtures** (user, 2026-10-07; to evaluate): real
  objects of many types for mirror and git-remote tests, imported into the local test system
  above. Pull, push and fetch would then run against content no one made for adt+. First check
  which repos fit, under which licence, and how they get into the system.
- **A generic fixture set and test suite per backend, with a backend test table** (user,
  2026-10-14; background in ): today only `onprem` (7.58) and
  `cloud-erp` (Cloud Public) are verified, the README says so ("Prerequisites"). One suite that runs
  against any configured system: it imports a fixed set of objects (the abapGit repositories
  above, where they fit), then exercises read, create, edit, activate and delete per type, the
  REST fallbacks and the local checks, and writes one row per system and release. The rows
  make a backend test table in the docs (release × feature, as `object-types.md` does per type),
  which the README's tested list links. Second dimension, namespaces (user, 2026-10-14): the
  same fixtures in a registered namespace (`/NSPC/`) besides `Z*`, since names with slashes run
  through every layer: refs and URIs, search, the write allowlist, mirror file names and
  `mirror.namespaces`, the git helper's addresses, abaplint (see "namespaced interface method"
  above). It needs a system with a namespace whose repair key adt+'s user may use. Open: where the suite lives (`test/live/`, `dev/`), how
  it finds a system's release (`SAP_BASIS`), and which systems beyond `onprem`, `cloud-erp` and the local
  test system above (8.16) it can run on.
- **Clean up the tests, second pass** (user, 2026-10-14). The first pass (public release) dropped
  the duplicates found mechanically: the shared form-object path tested once, one daemon table
  for domains and data elements, duplicate gate and happy-path cases, shared REST fakes in
  `test/helpers/`; coverage of `src/` unchanged (`npm run coverage`). Left: read the long files
  (`mirror/push`, `object-discovery`, `daemon/protocol`, `object`, `translation-update`) for cases
  that check the same behaviour twice; one branch in `git/history.ts` is covered in some runs and
  not in others (a timing-dependent test). Keep the rules of `docs/testing.md`.

## Agent side

- **Docs lookups for the target release** (user, 2026-10-04): in the M5
  Copilot sessions, fixes came from SAP docs for another release, e.g.
  `authorization master ( none )` as the answer to a `strict` error, which
  `onprem` (7.58) refuses. Agents should look up the keyword documentation of the
  system's release, and the RAP feature matrices there (which BDEF/CDS
  features a release supports). Open: how adt+ gives the release
  (`adtplus_status` could report `SAP_BASIS` per system), and whether the
  routing rule / `abap-mirror` skill tells agents to pass it to
  the docs search; whether the feature matrices can feed the release rules
  of `mirror check`.

## Deferred by the user

- **Animated git session in the README** (user, 2026-10-15; parked the same day). The README's
  "With git" section shows the session as a plain code block. A scripted animated SVG (JetBrains
  Mono outlines, light and dark, typed commands) works, but should wait until: its timing matches a
  real clone, fetch and push measured on a system; the session shows the change itself (`ls src/`,
  the file edited in vim) instead of only `git diff --stat`. The parked script and SVGs were never committed; rebuild them as `dev/git-demo.py` when picked up.
- **Claude Code, Codex and OpenCode as full clients** (target clients, user 2026-10-06; deferred
  the same day). `clients.md` gives the registration and approvals; the rest, in this order:
  1. ship the agent instructions in this repo (Copilot formats today, kept outside): the routing rules, the
     `abap-mirror` and `abap-object-access` skills, `sap-reviewer`. Claude Code takes skills plus
     `CLAUDE.md`, Codex `AGENTS.md` plus its skills, OpenCode `AGENTS.md` plus its agents;
  2. test Codex and OpenCode, which `clients.md` covers from their docs only: registration,
     approvals (Codex `prompt` + approved read tools, OpenCode's `adtplus_*` permission glob), the
     folder adt+ ends up in, and long calls (timeouts);
  3. routing runs on all three: a method of a class, a where-used, an edit, a greenfield task;
     check they reach `read`/`updateSource`, or a mirror where rule 2a says so.
- **Routing check after the ADT MCP Server's retirement** (skipped by the user, 2026-10-12): in
  Copilot, check that RAP-generator and quick-fix prompts reach `adtplus_object`/`adtplus_quality`
  now the server is off, and adjust the routing rules if not.
- **Mirror push: stale-manifest check** (ADR-007 "Decided, not built yet"; deferred
  from M3 by the user, 2026-10-02): after `git checkout <rev> -- .adtplus/`,
  every object changed since looks like a conflict. Push should say so when
  most conflicts' remote hashes match a later manifest in git history (a
  read-only `git log -p -- .adtplus/mirror.json` in the mirror root). Today it
  only notes "the manifest may be stale" when most planned objects conflict.
- **Mirror `check --remote`** (ADR-007 "Decided, not built yet"; deferred from M2 by the
  user, 2026-10-02): a syntax check of the local files before a push. adt-ls checks only the
  stored source (probed 2026-10-12); `navigate syntax` with `source` (REST check run) is the
  route: one check run per changed include.
- **Software component as an allowlist entry** (deferred by the user,
  2026-09-21): `{ "softwareComponent": "ZLOCAL" }` allows writes to any object
  whose package belongs to it; on `cloud-erp` that means "can never be transported". Costs
  one REST package read per package, cached per session; `package.ts` already
  parses `pak:softwareComponent`. A third entry kind in ADR-003's rule.

## Found in two days of real VS Code work (2026-10-16)

Findings from two long Copilot agent sessions on a `cloud-erp` system (484 adt+ calls, 35 errors),
ordered by the time they cost. Related open items: searches for released SAP views and custom
types (above, searchTypes subtypes), tab indentation, the cancelled call.

- **Translations of types without a visible package are refused** (2026-10-16). `object_write` on
  the texts of job catalog, job template and simple-type objects (`LTO_SAJC`, `LTO_SAJT`,
  `LTO_DRTY`): "ADT+ can't tell the package of this type, so it can't check the write allowlist".
  It blocked the work three times; each time the XLIFF file had to be uploaded by hand. The
  objects sit in an allowlisted package, adt+ cannot see it. Either read the package through the
  package tree (the translation project's record names it) or accept the write when the project
  itself is allowlisted. Open: which of the two keeps ADR-003's rule intact.
- **Job catalog and job template objects can't be read** (2026-10-16). `SAJC` and `SAJT`:
  "abapStat returned no version for …". The model could not check a parameter's settings and
  asked for it to be read in Eclipse; it later retried with a malformed `SAJC/` type. Read-only
  support is enough.
- **A failed release hides its findings** (2026-10-16). `transport_write releaseTransport`
  returns the task and "See ATC Problems view", not the findings; the model said it could not
  retrieve them and ran its own worklist, which is a fresh check, not the release's. Return the
  release check's findings, or say where they are.
- **Tool-schema drift after a config change** (2026-10-16). After the model added a system to the
  project config, the MCP tool's advertised `system` list stayed stale (VS Code caches tool
  schemas, `known-issues.md`) and the model went to the CLI for data preview. A note in the
  `adtplus config trust` output, or a `system` parameter that doesn't list handles.
- **Parameters the model gets wrong on the first call** (2026-10-16), each answered with a clear
  error and fixed on the second: `transport find` needs `package` (twice); `transport_write
  create` needs `isCreation`; `version` on a `DTEL`/`DOMA` read ("returns its properties, not
  version", 4 times, in both sessions); `atcVariants` needs a name and type (variants are
  system-wide); `quality` `include` without `syntax`. Ignoring `version` where it has no meaning
  would remove four of them.
- **Class create with `interfaces` fails in adt-ls** (2026-10-16): "Expected a string but was
  BEGIN_ARRAY at $.interfaces". The model dropped the parameter and added the interface
  afterwards. Our schema offers an array that adt-ls wants as a string.
- **"Another lock attempt is still in progress" on a DCL update** (2026-10-16); a retry after the
  previous call finished worked. Cause not visible in the transcript; look at it with the next
  lock failure (`object lockStatus`), maybe a retry like `retryLockBusy`.
- **No way to run a class** (2026-10-16). A one-off cleanup in a test client: the model wrote an
  `if_oo_adt_classrun` class and the user ran it by hand. Fine by the write rules; the one thing
  the sessions asked for that adt+ doesn't do.

## Proposed (review 2026-09-22) — not yet decided

- Copilot side (agent instructions): route everything but in-editor edits through adt+; infer the
  system for reads when exactly one ABAP mount is open.
- Publish to npm as `adtplus` (free on 2026-10-14) after the public GitHub release: drop
  `"private"`, add `files`, `publishConfig`, `repository`; decide on provenance and who publishes
  (CI on tag or by hand).
- Reconsider `confirm: true` (deferred 2026-09-23). Options weighed: a preview
  token (one extra call per protected action), echoing the target name as the
  confirm value (no extra call), or removing it.
