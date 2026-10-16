# ADR-007: Mirror mode — pull a package as AFF files, push it back

- Status: accepted 2026-10-02

## Context

Agents working object by object through MCP spend most of their turns on round trips: a
20-object refactoring took 210–220 tool calls and about 10 minutes, half of them reads and
per-object checks. Greenfield work spent its time in repair loops that only the server's
activation closes.

What adt-ls offers for files: AFF file names as served, about 1 s and 5–7 backend requests per
object for a cold read, no ETag or change time, blind writes (no `If-Match`), `writeFile` can't
create, and `lockFile` works but a dying session leaves its lock for 25+ minutes. What it serves
also differs from AFF's format rules: class sources come as CRLF, `.json` without a final newline,
CDS sources as the last editor wrote them. `.properties` writes are refused.

## Decision

### Scope

- Mirror mode is an **opt-in route** for two cases: a new object set (greenfield) and a change
  across many objects (refactoring). One-offs and reviews stay in the system. When to take the
  route is the agent instructions' call, not adt+'s.
- **Not covered:** deleting objects through a push, moving an object to another package, periodic
  or background sync, mirroring SAP-delivered code.

### Surface

| Tier | Tool | Actions |
|---|---|---|
| read (for the system) | `adtplus_mirror` | init, pull, status, check, new |
| write | `adtplus_mirror_write` | push, activate |

- `adtplus_mirror` reads from the system but writes local files, so it isn't annotated read-only.
  It stays registered under `ADTPLUS_READONLY`, because the system sees only reads.
- No `diff` action: `status` lists local changes against the manifest, and `git diff` shows the
  content.
- **Results are summaries:** counts, changed paths (capped), errors as `file:line`. Mirror results
  never carry source.

### Local layout

- A **mirror root** is a folder holding `.adtplus/mirror.json` (the manifest) and `src/`. One
  mirror root serves one system and can hold several root packages of it.
- `src/<package>/` holds the object files under the names adt-ls serves; adt-ls's category and
  type folders are flattened away. Subpackages become subfolders. Namespaces follow AFF's
  `(ns)name`.
- **Path safety:** the mirror root must resolve (after `realpath`) inside a workspace folder or the
  CLI's working folder, and so must every path adt+ writes, so a symlink or a `..` in the manifest
  can't move a write out of the mirror root.
- **Local files are LF with a final newline,** AFF's format; pull converts every text file it
  writes, and trailing whitespace is content. The mirror ships AFF's `.editorconfig`.
- **Files adt+ can't write back** (`.jsonc` stubs, `.properties`) are written `0444`, never sent;
  a local change is reported as "changed locally, not sent". Message classes are real files
  (ADR-014).

### Manifest

`.adtplus/mirror.json`, committed with the files, written with sorted keys so git diffs stay
small: the system, the root packages, the adt-ls version of the last pull, and per file its
object, base hash, draft flag and last read error.

- **The hash is over normalized content** (CRLF → LF, a final newline dropped, then SHA-256), so a
  file counts as changed only when its content changed, whatever an editor or git does to its line
  endings.
- **The adt-ls version of the last pull** is recorded: `check` and `push` warn when the running
  adt-ls differs, since a format change would make every file look changed.
- **The manifest is trusted for** which files belong to which object, and the base hashes for the
  conflict check. **Never for** the package an object lands in or its URI: both come from the
  system at push time. An agent that edits a base hash can defeat the conflict check on its own
  objects; it can't get past the write gate.

### Pull

- A root package must start with `Z`, `Y` or `$`, or with a namespace listed in the system's
  `mirror.namespaces`: adt+ can't tell a customer namespace from SAP's, so the operator names
  them. Pulling is a read; the package needn't be allowlisted.
- **Ceiling:** at most `mirror.maxObjects` objects per mirror root; more needs an explicit raise on
  the call. A pull never covers more than the named packages (ADR-005). It runs in the rate
  limit's bulk lane (ADR-008).
- **Resumable:** the manifest is saved as the pull goes; a pull that stops is completed by running
  it again.
- **Re-pull,** per file: a change on the system only is taken; a local change only is kept; both
  changed → the system's version goes to `<file>.remote`, reported as a conflict, base unchanged.
- Drafts: the logged-on user's version as ADT shows it, flagged per file.

### Push

1. **Plan** from local hashes against the manifest. A dry run calls nothing. Local deletes and
   files moved to another package folder are reported, never sent.
2. **Refuse the whole push before any write** when the system is read-only, when `ADTPLUS_DENY`
   matches any command the push would use (not only `mirror.push`), or when the plan exceeds the
   ceiling.
3. **Gate per object (ADR-003)** on the package the system names; a new object on the package its
   folder names. An object outside the allowlist is refused and the push goes on with the others.
4. **New objects** are created in any order (no dependency tiers: no create needs another object
   active or present), with the description and fields the files carry. A behavior definition
   must carry its root entity's name, since SAP names it after that entity whatever is asked
   for.
5. **Conflict check, then write**, per object: a fresh read of every changed file must match its
   base hash, or the object is a conflict and nothing of it is written. **A `<file>.remote` next to
   a changed file is the expected system state instead:** when the fresh read matches it, the local
   file (the merge) is written and the `.remote` deleted; when the local file already equals it,
   only the base moves. No `lockFile`: the moment between the read and adt-ls's own lock is
   accepted, an orphaned lock is worse. Locks and other users' drafts are reported as blocked.
6. **Write in the system's style:** the file's majority line ending and final newline, taken from
   that fresh read; new files per file kind. The new base is a fresh read-back, not the bytes sent.
7. **One activation for everything the push wrote or created**, including what an earlier push
   left inactive; diagnostics map to the local `file:line`.
8. **Report** written, created, conflicts, blocked, refused, not activated, activation errors;
   anything left undone makes the push incomplete (CLI exit 1).

The manifest is saved after every file, so a push that stops is completed by running it again.

### Local checks

`check` runs abaplint and the RAP file rules (ADR-012), validates `.json` files against AFF's
schemas (with one exception: a service binding's empty `serviceBuildVersion`, which adt-ls serves
and the schema refuses), and applies the `.editorconfig` rules. It reports and never fixes. The server's
activation stays the last word.

### Git and the call log

adt+ never commits; git is the user's or the agent's tool (the git remote helper, ADR-011, is the
exception that does). Each mirror command is one call-log entry with its counts, and every write a
push makes gets its own entry, so writes stay attributable one by one (ADR-005).

### Decided, not built yet

Tracked in the backlog:

- `pull --objects <type:name,…>`: single objects outside the root packages, under the same
  root-package rule.
- `pull --active`: active versions of source files instead of the user's drafts.
- `check --remote`: a syntax check of the changed objects on the system before a push; it costs
  requests and is never the default.
- **Stale manifest:** after `git checkout <rev> -- .adtplus/`, every object changed since looks
  like a conflict. Push says so when most conflicts' system hashes match a later manifest in git
  history; going back to an older state means checking out `src/` only.

## Why

- **Normalized hashes and LF files:** CRLF files on a Mac get in the way of the local tools mirror
  mode exists for (`grep`/`sed` anchors, edit tools writing LF into CRLF files, `^M` in diffs), and
  a raw-byte hash would call every line-ending change a conflict.
- **Content hashes, not change dates:** adt-ls passes on no change date or ETag (none of its LSP
  methods returns one, and `fileSystem/stat`'s `mtime` is the fetch time). A fresh read before a
  write is mostly a 304 inside adt-ls. Reconsider when adt-ls offers change dates; the git
  helper's incremental fetch reads them over REST meanwhile (ADR-011).
- **The `.remote` file as expected state** ends a conflict in pull → merge → push. Comparing with
  the old base alone reported the same conflict on every push after a hand merge. The guard
  doesn't weaken: the push writes only while the system still holds exactly the `.remote`'s
  content.
- **One activation:** one mass activation of a whole RAP stack works on both systems in any order.

## Consequences

- A local file is no longer byte for byte what the system holds. A file the system holds with
  mixed line endings goes back in its majority style on its next push: the one case where a push
  changes bytes nobody touched, and only line endings.
- A mirror command runs for minutes; a client that times out first re-runs it, and the resumable
  pull and push complete the work.
- A pull reads objects the task never touches, so it costs more backend requests than the task's
  own reads.
- Behaviour in detail, and what isn't built yet: [mirror.md](../tools/mirror.md).

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADRs it absorbed merged in.
