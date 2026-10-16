# Developing adt+

Agent working rules are in `AGENTS.md` (`CLAUDE.md` imports it). The docs in
[`docs/`](docs/README.md) cover architecture, capabilities, known issues,
testing, the backlog, and decisions.

## Run from source

```
npm install
npm run cli status                          # CLI via tsx
npm run cli status --system cloud-erp --connect
npm run mcp                                 # MCP server via tsx
```

`@arc-mcp/adt-ls` comes from npm, pinned to an exact version (`package.json`).

## Test

```
npm test            # vitest, mocked HTTP/LSP fixtures only — no live SAP calls
npm run typecheck
npm run smoke -- --system onprem   # build, then a read-only live check of one system
```

Live-test rules (throwaway objects, allowlisted packages only):
[docs/testing.md](docs/testing.md).

## Worktrees and parallel daemons

Each parallel session works in its own git worktree (agents: under
`.claude/worktrees/`, gitignored). A live test from a worktree needs a daemon
of its own, or it replaces the one on the shared socket:

```
env=$(dev/daemon-env.sh) && eval "$env" && node dist/cli/index.js status
dev/daemon-env.sh --stop
```

Details, and how to run two configs side by side:
[docs/testing.md](docs/testing.md#parallel-sessions-and-worktrees).

## `dev/` is development-only

`dev/` holds development scripts: `daemon-env.sh` for parallel daemons, `gate.sh` and `hooks/`
for the public-safety gate, `logo.py` for the README logo. None of it is shipped
([ADR-020](docs/decisions/020-evals-outside-the-repo.md)): it is not in `tsup.config.ts`'s entry
map and adds no MCP tool, daemon command or CLI subcommand. Evals of how agents use adt+ live
outside the repo, with the agent instructions they test.
