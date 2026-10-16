# Git remote helper

> **Experimental.** Less live-tested than the other areas; it shares the mirror's engine, which is experimental too.

`git-remote-adtplus` (ADR-011), the second `bin`: git runs it for
`adtplus::<system>/package/<PKG>` (optional `?no-subpackages`) and `adtplus::<system>/swc/<SWC>`,
on systems with `mirror.git.enabled` only (refused before any SAP call otherwise). No MCP tool.
Install: [README](../../README.md#get-started); settings:
[configuration.md](../configuration.md#mirror). It works on a shadow mirror in
`$GIT_DIR/adtplus/<remote>/` and reuses the [mirror](mirror.md)'s pull and push.

With `adtplus.history=transports` each released transport request becomes a commit:

```console
$ git clone -c adtplus.history=transports adtplus::S4H/package/ZADTPLUS_TEST
Cloning into 'ZADTPLUS_TEST'...
reading versions: 100% (44/44), done.
reading objects: 100% (38/38), 412 units, done.
$ cd ZADTPLUS_TEST && git log --oneline
3f9c2e1 (HEAD -> main, origin/main) S4H: ZADTPLUS_TEST at 2026-10-15T09:12:00Z
a81d07b S4HK900214: Flight booking: discount for early birds
5c0e9fa S4HK900198: Flight booking: first version
$ git diff --stat
 src/zadtplus_test/zcl_adtplus_booking.clas.abap             | 6 +++---
 src/zadtplus_test/zcl_adtplus_booking.clas.testclasses.abap | 2 +-
 2 files changed, 4 insertions(+), 4 deletions(-)
$ git commit -qam "Rename get_total to calculate_total"
$ git push -o transport=S4HK900231
writing objects: 100% (2/2), 31 units, done.
activating 2 object(s)…
To adtplus::S4H/package/ZADTPLUS_TEST
   3f9c2e1..7d41b2a  main -> main
```

| Operation | Backend | Gate |
|---|---|---|
| [Software-component addresses](#software-component-addresses) | REST (`swc.packages`) | — |
| [clone / fetch](#clone--fetch) | local + mirror pull (adt-ls); change stamps REST | — |
| [push](#push) | adt-ls | A per object, as `mirror push` |
| [Transport history](#transport-history) | REST (`history.versions`, `history.released`) | — |

## Software-component addresses

The component's root packages, each mirrored with its subpackages, resolved again on every fetch.

- A structure package of the component's name (ABAP Cloud: `cloud-erp`'s `ZLOCAL`, `ZPARTNER`) is its own
  root: 1 request.
- Otherwise (on-premise): one info-system search `comp=<SWC>` bounded by the object ceiling (×4 +
  100 results), its hits' packages (a package hit counts itself, so packages without objects too),
  one package read each, and the super packages up to the top.
- **A root** is a mirrorable package of the component with no mirrorable package of the component
  above it, a foreign package in between included. A top package outside the root-package rule
  (`Z`/`Y`/`$`/`mirror.namespaces`) is left out with a warning and its mirrorable subpackages are
  the roots.
- A package of the component that doesn't read fails the lookup.
- Above the ceiling a clone is refused before any package read, naming the count reached (`onprem`
  `HOME`: the whole system's non-SAP code).
- **On a later fetch:** a package new in the component joins; a root now inside another root stops
  being one; one that left the component stays in the clone with a warning (a pull keeps objects
  that still exist); a lookup that fails only warns, and the clone fetches the roots it has.
- The shadow records its address (`address.json`) once it holds a manifest: a remote switched to
  another address is refused; a first fetch whose package wasn't found leaves no shadow.

## clone / fetch

The shadow mirror is brought up to date, then (with [transport history](#transport-history)) the
transport commits and one sync commit on `refs/adtplus/<remote>/heads/main`.

**The sync commit.**

- Made when the shadow's `src/` differs from that ref's tip, or from the tree the transport commits
  left. A clone without transport commits always gets one, so even an empty package has a `main`.
  An unchanged system makes no commit.
- Author `<SYSTEM> <adtplus@<system>.invalid>`, the fetch time, subject
  `<SYSTEM>: <PKG or SWC> at <time>`, body the objects new, changed and gone (50 listed each; a
  clone's first commit counts objects and files).
- Only `src/` is touched; files outside it stay.
- Read errors go to stderr and don't stop the fetch; a stopped fetch resumes like a pull.
  `adtplus.maxObjects` (git config) raises the ceiling.

**Incremental fetch.** Each fetch first reads a change stamp per object (`mirror.changes`):

- one info-system search per root package, then one metadata GET per hit with every
  `adtcore:changedAt`, a class's includes too, plus the hit's package (a package hit needs no GET);
- a function group adds its own includes (from its `objectstructure`, which lists SAP's it uses
  too; then one GET per include: the group's own date doesn't move when one changes);
- a class, program or function group adds its text elements' etags (one GET: a text-only edit moves
  no date at all).

These parts come from the system, so a clone's first stamps are complete. Then:

- Only the objects whose stamp moved since the last complete pull are re-read (`mirror.pull` with
  `objects`: resolve by name, list the folder, read its files; no walk). A folder that doesn't list
  the file the search named is taken for a stale index, nothing in it deleted.
- A hit that is part of a mirrored object counts for its owner (a function module for its group, a
  CDS entity for its view, an enhancement's part for the enhancement).
- An object without a stamp is re-read every time, best effort. One adt-ls can't find by name (`onprem`:
  `CUS0IMG`, `TRANT`, Gateway objects, …) is skipped with one warning and left out until the next
  full fetch, as is one whose path names no package.
- **A full pull instead:** on the first fetch; after a stopped pull; when the search shows an object
  new or gone; when a changed hit is no mirrored object (a function group's include); when a
  re-read finds an object moved (its stamp's package changed, or the re-read finds it elsewhere);
  over the ceiling; after an adt-ls upgrade (also with nothing changed); when the stamps can't be
  read (as before G5); or with `adtplus.fullFetch`.
- Stamps are kept only for what the pull read: a file that failed clears its object's stamp; an
  unlisted folder or a collision drops them all.

**Measured (`onprem`).**

| Package | Unchanged fetch | Full read |
|---|---|---|
| `ZADTPLUS_MB_REFAC` (20 objects) | 22 units, 2 s | 296 units, 28 s |
| `ZADTPLUS_TEST` (1,477 objects, 1,759 hits, ADR-008's bulk lane) | ~2,600 units, 58 s | clone: ~14,800 units, 27 min |

The first fetch after that clone took ~4.5 min: 114 objects without a stamp that adt-ls can't find
by name are tried once, ~1.6 s each.

## Large packages

G5b.

- A full pull saves its manifest every 25 objects or 3 s instead of after each object, and records
  its progress there (objects to read, read, units).
- With git's `progress` (a terminal, or `--progress`) the helper polls it and shows
  `reading objects: 45% (230/512), 1580 units, ~3 min left`; the stamp check before it,
  `checking stamps: 30% (528/1760), 610 units, ~4 min left`.
- A clone or fetch stopped by a cooldown, Ctrl-C, or SAP no longer answering (no REST request
  answered for two `restTimeout` waits in a row; one hanging object alone costs only that object,
  as any read error does) makes no commit. The next one resumes where the
  pull stopped, and reads again what the stopped pull read but whose stamp moved since it began
  (against `pending` in `stamps.json`, else the last complete fetch's stamps, as for a pull a push
  started; everything, when there are none or a change can't be pinned to an object).

## push

**Refused** (before any SAP call where it applies):

- a pushed commit that doesn't contain the fetched tip (git refuses a non-fast-forward itself from
  `list for-push`; a force push, `+`, is refused by the helper); any ref but `main`;
- shadow bases that aren't that tip's state (`state.json` in the shadow): a fetch whose commit never
  reached git, or a push that re-read files, makes the next push answer `fetch first`;
- a deleted file under `src/` (a move is a delete, ADR-007), a changed `.jsonc`/`.properties`,
  anything but a regular file.

**What it does.**

- The changes since the tip go into the shadow, and `mirror push` runs on it unchanged (conflict
  check, creation, one activation) with `takeSystemVersion` (ADR-011): a written file takes the
  system's read-back in the shadow.
- Objects an earlier push left inactive are activated by the next push (`mirror activate`), also
  one with nothing under `src/` to write.
- Several local commits go to the system as one change; commits touching nothing under `src/` push
  without a SAP call.
- Options: `-o transport=<request>` (or `adtplus.transport`), `-o no-activate`, `--dry-run`.

**Result.**

- `ok` only when the push is complete and sent everything; otherwise `error` with the counts
  (`1 conflict, 1 blocked`), every issue and activation error on stderr. Counts from push's capped
  lists read `50+`.
- The shadow is put back to its base either way (unsent files restored or removed; a written file
  whose read-back failed is re-read by a pull right after).
- With git's `progress`: `writing objects: 40% (2/5), 31 units, ~1 min left`, then
  `activating 5 object(s)…`.

## Transport history

Opt-in per clone, `adtplus.history=transports`, from `adtplus.since` (default one year back). One
commit per released request before the sync commit, oldest first.

**Commits.**

- Dated by the release: the request's own time less the system clock's offset, measured by the
  daemon ([known-issues.md](../known-issues.md#system-clock)); the versions' feed times, corrected
  the same way, when a request's own doesn't read.
- Author the SAP user of its versions (`<user> <<user>@<system>.invalid>`), subject
  `<request>: <description>`, trailers `Transport:` and `Owner:` (one read of the request; without
  when it doesn't read).
- The files are the numbered versions (`00001…`) of the request in each source file's version feed
  (class includes, interface, program, function-group main program, includes and modules, DDLS,
  DCLS, DDLX, BDEF, SRVD, TABL), as a pull writes them. `00000`/`99999` never (they name whoever
  holds the object now); `.json`/`.properties` and everything not released come with the sync
  commit.
- **Rebuilt class sources:** the version store keeps a class's main source as SAP rebuilds it from
  its parts (upper-case name, blank lines after `IMPLEMENTATION`). A file's newest release whose
  pulled file (read without error, not the user's draft) differs from it only in case and blank
  lines, and whose `00000` equals it (1 more unit, only then), is the active state, so its commit
  takes the source the pull read; older releases keep the rebuilt text, the only one left.
- An object a newly released request names, gone from the system, loses its files in the commit of
  the request that marks the deletion (`obj_func="D"`), else of the latest one naming it (an object
  moved to another package counts the same).

**Reads.**

- A clone reads every source file's feed (1 unit each), each version since `since` (1 unit each)
  and the system clock once an hour (2 units); resumable per object (an index from another clock
  offset starts over),
  `reading versions: 40% (44/110)` with progress.
- A later fetch reads the released-in-two-weeks list (1 unit) and only the feeds of the clone's
  objects in requests git doesn't hold yet (by `Transport:` trailer; a method, a class include
  (`ZCL_X====CCAU`), a function-group include or module counts for its class or function group).
  More than 13 days after the last check it reads every feed again.
- A stopped read resumes; one that resumes with requests released in between starts over.
- An object whose version list or a version fails to read (anything but a 404, which means no
  history) is read again at once, then on every fetch until it reads, with a warning; its requests'
  commits are appended then, after newer ones.
- History switched on after the clone starts with that fetch.

## Not yet

[Backlog](../backlog.md): the open requests that hold a sync commit's changes, ADR-009's hold for
objects a clone holds.

## Known issues

The helper's REST fallbacks and their retirement conditions:
[known-issues.md](../known-issues.md#rest-fallbacks).

- **The version store keeps a class's main source as SAP rebuilds it**, not as written in source
  form: upper-case class name, blank lines after `IMPLEMENTATION` (`onprem`, G6 live check; Eclipse's
  history shows the same text). A file's newest release that differs from the pulled file only in
  case and blank lines, while `00000` equals it, takes the pulled file (`layoutFree`,
  `mirror/history.ts`); older releases keep the rebuilt text, the only one left. Goes when the
  store keeps the written text.
- **Times from the other side of a daylight-saving change** can be an hour off
  ([known-issues.md](../known-issues.md#system-clock)). If one request's own release time doesn't
  read, all of that fetch's commits take the versions' feed times (never a mix, which could
  reorder them).
- **A request that only deletes has no version**: dated by its release like any other; when that
  doesn't read, like the transport commit before it in the same fetch, else by the fetch time
  (`buildCommits`, `git/history.ts`).
- **The released-request list covers two weeks** (`history.released`). A fetch more than 13 days
  after the last check reads every version feed again (`RELEASED_DAYS`, `git/history.ts`); a date
  range over REST needs a PUT on the user's stored search config (P3). Goes when adt-ls lists
  released requests by date.
- **Some objects have no change stamp** (`onprem`, G5b): metadata reads of `ENHO`/`ENHS` answer HTTP 500
  with an HTML page; `DCLS`, `DDLX`, `IWPR`, `SRVB`, `SUSH`, `TOBJ` answer 404. Such an object is
  re-read on every fetch, best effort (`mirror/changes.ts`, `git/incremental.ts`).
- **adt-ls can't find some objects by name** (`onprem`: `CUS0IMG`, `TRANT`, Gateway `IW*`, `SICFTYP`,
  `SHMASH`, `G4BA`), so an incremental fetch can't re-read them. Without a stamp they are skipped
  with one warning and recorded as `unreachable` in the shadow's `stamps.json` until the next full
  fetch (`git -c adtplus.fullFetch=true fetch`). Goes when adt-ls resolves them by name.
