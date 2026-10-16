# ADR-011: A git remote helper (`git clone adtplus::…`) on the mirror engine

- Status: accepted 2026-10-07

## Context

Many teams use neither gCTS nor abapGit, and gCTS doesn't exist on SAP Cloud ERP. An agent or a
developer should work on a package with real git: clone once, then `log`, `blame`, `diff`,
branches and worktrees locally, `fetch` for the system's changes, `push` through adt+'s gates, and
transports in `git log`. Mirror mode (ADR-007) already pulls a package as AFF and pushes it back;
it has no history and no git protocol.

What the system offers: git accepts a helper that offers `import` for fetch and `push` for push;
the version feed holds each source's released versions with their request, release time and
author; the released-requests list names newly released requests with their objects in one GET;
`adtcore:changedAt` per object detects changes at about 1 unit per object against 5–9 for a
re-read. adt-ls has none of this: no released-request search, no version history, no change dates.

## Decision

### What it is

- An executable **`git-remote-adtplus`** (the package's second `bin`, code in `src/git/`), which
  git runs for `adtplus::<system>/package/<PKG>` (optional `?no-subpackages`) and
  `adtplus::<system>/swc/<SWC>` (a software component's root packages, each with its
  subpackages).
- **A daemon client** like the CLI (client kind `git` in the call log): the session, the rate
  limit and every gate stay in the daemon. **No MCP tool**; mirror mode and its tools stay as they
  are.
- **Files are AFF exactly as a mirror pull writes them**, under `src/`; files outside `src/`
  (README, `.gitignore`, agent instructions) are the user's and never touched.

### Opt-in

Per system, off by default: `"allowGitRemote": true`, a gate like the other `allow*` switches (ADR-003). Without it the helper is
refused before any SAP call. The root-package rule and `mirror.maxObjects` apply as in mirror
mode; `adtplus.maxObjects` in git config raises the ceiling without an upper bound.

### Engine: a shadow mirror in `$GIT_DIR`

The helper keeps an ordinary mirror root in `$GIT_DIR/adtplus/<remote>/` and runs mirror pull and
push on it. The shadow's files always equal their base; the working tree carries no manifest.

- **Push takes the system's version** (`takeSystemVersion`, set only by the helper): every written
  file whose read-back differs from what was sent takes the read-back in the shadow, at no extra
  SAP call, so shadow, base and system agree after a push. Mirror mode doesn't set it.

### Fetch

Only the objects whose change stamp moved are read again (a full pull on the first fetch, after a
stopped one, or when objects appear or vanish); then one **sync commit** when the shadow's `src/`
differs from the remote-tracking tip (author `<SYSTEM> <adtplus@<system>.invalid>`). Nothing is
committed before the shadow is complete, so a stopped clone or fetch resumes.

### Push: same gates, the terminal's approval

`git push` runs mirror push in the daemon, so the allowlist per object, `ADTPLUS_DENY`, the
conflict check, creation and the one activation all apply unchanged. The approval is whatever the
terminal gave, not a tool prompt, as with the CLI.

- The pushed commit must contain the remote-tracking tip; a force push is refused. Several local
  commits go to the system as one change.
- **A deleted file under `src/` refuses the whole push** before any SAP call (ADR-007: no
  deletes); a move between package folders is a delete.
- **`ok` only when the push is complete.** Anything left undone is `error` with the counts. What
  was written is on the system either way and comes back in the next sync commit.

### History: from released versions only, off by default

- `adtplus.history=transports` at the clone adds **one commit per released request**, oldest
  first, from `adtplus.since` (default one year back). History is fixed at the clone: prepending
  later would change every SHA.
- Built from the **numbered versions only**: dated by the release (corrected by the system clock,
  ADR-016), authored by the version's author, message `<request>: <description>` with `Transport:`
  and `Owner:` trailers. `00000`/`99999` name whoever holds the object now, so they never date or
  attribute history; drafts and unreleased changes go into the sync commit.
- Each fetch appends the requests released since the last one.
- Packages that record no changes have no released versions: everything works, the history stays
  empty, and push needs no transport.

### Fallbacks

The reads adt-ls lacks are REST fallbacks under ADR-002, each with its retirement condition in
[known-issues.md](../known-issues.md#rest-fallbacks): change stamps, the software component's
packages, the version feed and the released-requests list. Single requests that are heavy for the
backend but weigh 1 unit stay out of fetch and clone (the all-owners open-request list, an
unbounded component search); a component's search is checked against the object ceiling first.

## Consequences

- Two clones of the same package have different SHAs after their first own push; people share
  commits through an ordinary git remote next to `adtplus::…`. The system holds states, not
  commits.
- ADR-009 doesn't cover clones: a direct write to a cloned object is caught by the next push's
  conflict check.
- Message classes have no version feed, so the history can't show their changes per request.
- Behaviour in detail: [git-remote-helper.md](../tools/git-remote-helper.md).

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADR it absorbed merged in.
- 2026-10-16: the opt-in is `allowGitRemote`, no longer `mirror.git.enabled`: a gate is a flat `allow*` switch, and a project config turns it off with one field.
