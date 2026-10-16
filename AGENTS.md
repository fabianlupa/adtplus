# adt+

ABAP development from your AI assistant, terminal and git: a stdio MCP server, a CLI and a git
remote, built on `@arc-mcp/adt-ls`. Docs live in [`docs/`](docs/README.md):

- `docs/architecture.md`, `docs/capabilities.md` (index; details per area in
  `docs/tools/`), `docs/configuration.md`, `docs/known-issues.md`, `docs/testing.md`
  — current state; read the relevant one before changing code
- `docs/backlog.md` — open work
- `docs/decisions/` — accepted decisions (ADR-001 auth/session … ADR-020 evals
  outside the repo), each as it holds today; binding

## Keeping the docs true

- A change that alters current state updates the matching current-state doc in
  the same commit (new tool/action → a line in `capabilities.md` and a section
  in its `docs/tools/<area>.md`; an SDK workaround or REST fallback added or
  retired → `known-issues.md`; a quirk of one area → that area's file). How to
  write them: `docs/README.md`, "Writing current-state docs".
- What a session built, measured or found goes into the doc it changes, the commit message and
  the PR text; there is no journal. A finding with no doc to live in is a backlog item.
- An ADR states what holds today. A refinement edits it in the same commit as the code and adds
  a dated line under its `## Changes` section; a reversed or replaced decision is a new ADR, the
  old file a stub naming its successor (`docs/README.md`, "Decisions").
- A plan for a larger piece of work lives in its PR or issue, not in `docs/`. The backlog,
  current-state docs and ADRs state what they need themselves; a plan is never the only place
  an open point lives.
- Delete a backlog item when it's done.

## Public repository

This repository is public. Docs, code comments, test data, commit messages and PR text never
name real systems (SIDs, hosts, tenant IDs, clients), customers, employers, people or other
people's objects; use the names in `docs/README.md` ("Names"): the system handles `onprem` and
`cloud-erp`, SID `DEV`, package `ZADTPLUS_TEST`, objects `ZADTPLUS_*`/`ZCL_ADTPLUS_*`, host
`my-s4.example.com`. Real hosts and credentials stay in the gitignored config. Raw probe output
(responses, logs, traces) goes to the gitignored `scratch/`; only findings move into docs, an
ADR or the PR text. A maintainer may run `npm run gate` against a local denylist; it is
optional and skips without one (`docs/testing.md`, "Public-safety gate").

## Model choice

Use Opus for probing undocumented adt-ls/ADT behaviour, for changes to the
write gates (`docs/decisions/003-write-gates.md`), and for diagnosing live
failures (locks, SSO/session issues). Any model otherwise.

## Working rules

- When resuming work, or before saying what's next, look beyond `main`: `git worktree list`,
  `git branch -vv` and `git log main..<branch>` for every branch that looks related. Parallel
  sessions (e.g. agents in `.claude/worktrees/<name>`) work on their own branches, often unpushed; the backlog
  on `main` doesn't show them. Objects the docs say exist but are gone point the same
  way (`/tmp/adtplus-*/calls.jsonl` names the worktree daemon that touched them).
- Implement only what `docs/capabilities.md` or `docs/backlog.md` lists.
- Treat `docs/decisions/` as binding.
- Run destructive live tests only on throwaway objects in allowlisted
  packages. A test that expects a refusal (allowlist, gates) targets a custom Z
  name outside the allowlist, best one that doesn't exist; never an SAP standard
  object (a change to one like `XFELD` would cascade activations through the
  system) and never anyone's real object (`docs/testing.md`, "Live").
- Live-test from a worktree only on its own daemon: prefix each command with
  `env=$(dev/daemon-env.sh) && eval "$env" &&`, run the worktree's `dist/`, and stop it
  with `dev/daemon-env.sh --stop` (`docs/testing.md`, "Parallel sessions and
  worktrees"). The default socket belongs to the daemon of your normal session.
- Any new surface (MCP tool or action, daemon command, CLI subcommand, parameter, config switch)
  follows ADR-018 (`docs/decisions/018-names-and-grouping.md`): SAP's term, one name through
  every layer, grouped by concept rather than backend, an existing tool first. Its ADR or plan
  says where it goes and why.
- Escalate to the user, not around the problem, when a probe result
  contradicts `docs/capabilities.md`.
- Review any significant change before opening its PR: in Claude Code, run
  `/code-review` on the branch (`/code-review high` for the write gates,
  auth/session or the daemon protocol), fix what holds up, and say in the PR
  what the review found. Docs-only or one-line changes don't need it.
- Never parse ABAP ourselves: a local ABAP check uses abaplint (a rule, or its
  parsed statements); what abaplint lacks is proposed upstream and logged in
  `docs/backlog.md` (`docs/decisions/012-local-abap-checks-through-abaplint.md`).

## `dev/` is development-only

`dev/` (`daemon-env.sh` for parallel daemons, `gate.sh` and `hooks/` for the public-safety gate,
`logo.py` for the README logo) must stay off the shipped surface: never add it to
`tsup.config.ts`, never expose it as an MCP tool, daemon command or CLI subcommand. Evals of
agent routing live outside the repo, and nothing in the repo writes to a system on its own
(`docs/decisions/020-evals-outside-the-repo.md`).
