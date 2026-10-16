# Transports

List, find, check, read, diff, create, assign and release transport requests. Tools:
`adtplus_transport` (read), `adtplus_transport_write` (write), `adtplus_irreversible`
(`releaseTransport`). Backend and gate letters: [capabilities.md](../capabilities.md#legend).

| Action | Backend | Gate | Verified |
|---|---|---|---|
| [list](#list) | adt-ls | — | both |
| [find](#find) | adt-ls (federated tool) | — | `onprem` |
| [check](#check) | adt-ls | — | both |
| [read](#read) | REST | — | `onprem` |
| [diff](#diff) | adt-ls (+ REST) | — | `onprem` |
| [create](#create) | adt-ls | A | `onprem` |
| [assign](#assign) | adt-ls (+ raw) | A | `onprem` |
| [releaseTransport](#releasetransport) | REST | C | both |

## list

- Own modifiable requests only.

## find

- A bare-string SDK answer is an error; `isCreation` defaults to false.

## check

- The lock oracle.

## read

ADR-002 fallback; 1 request.

- A request or task of any owner, open or released.
- Header: type, status, target, description, `lastChanged`: a released request's release, UTC
  by the measured system clock ([known-issues.md](../known-issues.md#system-clock)); when that
  didn't measure, the system's local `YYYYMMDDhhmmss` and a note.
- Tasks with their entries; every entry once (`R3TR`/`LIMU`/`LANG`, `wbtype`, `deleted` for
  `obj_func="D"`); a task names its `request`. A `LANG` entry is an object's translations, e.g.
  written by a translation project's publish into the project's request.

## diff

`transport.getDiff`, one page per call (≤ 40 objects, `nextCursor`): unified diffs, an open
request's draft against the newest release.

- **Supplement** (first page only, REST fallback): diffs from the version feeds, headed by AFF file
  names, of what getDiff leaves out ([below](#known-issues)):
  - a whole class's other includes;
  - a function group's other parts (listed from its folder);
  - objects that no longer exist (`gone`: their versions, or for one deleted in an open request
    its last release against nothing).
- Includes that are only SAP's template are counted (`templates`), not shown.
- `notCovered` names what neither reaches (a `LIMU FUNC`, a `LANG` entry, a deleted function
  group's parts) and objects whose reads failed (the rate limit's refusal leaves the rest unread).
- A failed read of the request itself gives `supplementError`, never a failed page.
- Versions are picked by the request's status (a task's: its request's): `D`/`L` open, `R`/`N`
  released, others either.
- The supplement runs beside getDiff. Cost: 1 feed per source object, plus 4 per class and 1 per
  function-group part, plus 2 contents per changed file (~230 requests for 138 objects).

## create

- A bare object type gets its subtype (`CLAS` → `CLAS/OC`, the types `mirror new` knows); another
  bare type is refused.

## assign

- **An object already in a request:** succeeds only if the SDK's lock read-back names the request
  (`lockedIn`).
- **An object in no open request:** `assignTransportToObject` without read-back on each file adt+
  writes (adt-ls keeps an assignment per file; the object's `<name>.<type>.*` files, not
  `.properties`; files adt-ls refuses are listed in `unassigned`). Answers
  `assigned: "onNextWrite"`; recorded by its next write of any of them through adt+ (a transport
  check in between cancels it). Details: known-issues "An object in no open request".
- **An object whose package records no changes** (local, `$TMP`; the check says so and shows no
  lock): refused, no transport needed.

## releaseTransport

REST fallback.

- Owner and status from the organizer read of the number (1 request), and the logon user from
  `core/http/systeminformation` (1 request, beside the read; the configured basic-auth user if that
  fails, the rate limit's refusal passed on).
- **A request:** own, modifiable (`D`/`L`), workbench (`K`) or customizing (`W`), its unreleased
  tasks first. A task with objects whose release fails stops it before the request, with that
  task's messages (a task holding only `LANG` entries has objects); an empty task's failure is
  left to the request release.
- **A task:** own, modifiable, also in someone else's request, which stays open (`request` in the
  result).

## Known issues

- **adt-ls's `transport.getDiff` diffs one source file per entry and leaves deleted objects out**
  (`onprem`, 2026-10-10). An `R3TR CLAS` entry shows the class's
  main source only (a new class's test classes, local types and macros are missing), `R3TR FUGR`
  the main program only; a `LIMU` class include (`CCIMP`, `CCDEF`, …) is diffed itself. An object
  deleted since, in this request or a later one, is left out without a word. `transport diff` adds
  these from the version feeds (`supplement`). Otherwise it is accurate: an open request's draft
  (`99999`, another user's too) against the newest release, unchanged objects left out, each object
  once. Its units are untraced: the default 3 per page, though one page reads up to 40 objects'
  feeds and contents inside adt-ls (~12–17 s a page).

Cross-cutting: "An object in no open request can't be confirmed in a request before its next
write" in [known-issues.md](../known-issues.md).
