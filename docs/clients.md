# Clients

A starting point for registering adt+ in each agent client. The server is the same everywhere:
stdio, `node <repo>/dist/mcp/server.js`. Check each client's own docs for the details.

- Editors may start MCP servers with a minimal `PATH`: use the absolute path of `node`, or a
  small launcher script.
- A system with a certificate from a private CA: list the PEM in `extraCaCerts` (configuration.md).
  adt+ adds it to Node's trust store itself on Node 22.15 or later; an older Node needs
  `NODE_EXTRA_CA_CERTS` in the server's environment instead.

- Mirror calls (`adtplus_mirror`, `adtplus_mirror_write`) read the files on disk when they run.
  An agent that sends a file edit or `rm` and a mirror call in the same parallel tool round can
  have the call run first: a `push` that plans nothing, or a `check` that loses a file (seen in
  VS Code Copilot). Both tool descriptions
  say so; a client's own agent instructions should repeat it.

Whatever a client's approvals say, adt+ enforces the write allowlist, `ADTPLUS_DENY` and
`ADTPLUS_READONLY` itself (configuration.md). Client approvals only decide whether the agent asks
first.

## Approval per tool

Each tool holds one risk tier (ADR-018), so approving a tool grants exactly one kind of risk:

| Tools | Approval |
|---|---|
| `adtplus_system`, `_transport`, `_object`, `_navigate`, `_quality`, `_mirror`, `_data`, `_runtime` | allow |
| `adtplus_transport_write`, `_object_write`, `_mirror_write`, `_test`, `_run` | ask |
| `adtplus_irreversible` | ask, never "always allow" |

Only the read tools carry `readOnlyHint: true`, and clients treat the other annotations
differently, so set approvals per tool rather than relying on defaults.

## VS Code (GitHub Copilot)

`mcp.json` (workspace `.vscode/mcp.json` or the user profile), under `servers` with
`"type": "stdio"`. VS Code honours `readOnlyHint`, so the read tools run without a prompt; the
rest ask until approved. adt+ reads the workspace folders through MCP roots. Agent instructions and
skills that route work through adt+ are not part of this repo yet (backlog, "Claude Code, Codex
and OpenCode as full clients").

## GitHub Copilot CLI

`~/.copilot/mcp-config.json`, under `mcpServers` with `"type": "local"` and `"tools": ["*"]`.
Approvals per tool with `--allow-tool 'adtplus(<tool>)'` / `--deny-tool`; the CLI ignores
annotations (ADR-018).

## Claude Code

```sh
claude mcp add --scope user adtplus -- node <repo>/dist/mcp/server.js
```

Approvals in `settings.json` as `mcp__adtplus__<tool>` under `permissions.allow` / `ask`; `ask`
wins over `allow`. Claude Code ignores annotations, so a tool in no rule asks every time. It
reports the folder it was started in as the MCP root.

## Codex

`~/.codex/config.toml`, a `[mcp_servers.adtplus]` table with `command` and `args`. Set
`default_tools_approval_mode = "prompt"` and approve the read tools under
`[mcp_servers.adtplus.tools.<tool>]`: the default mode (`auto`) asks only for tools marked
destructive or open-world, which `adtplus_transport_write` is not. Raise `tool_timeout_sec`; the
60 s default is shorter than an ATC run or a `publish`. Codex offers no MCP roots, so start
it in the project folder or set `ADTPLUS_PROJECT`.

## OpenCode

OpenCode 2 (these settings follow its [v2 docs](https://opencode.ai/v2/docs/config)):
`opencode.json` (project or `~/.config/opencode/`), the server under `mcp.servers.adtplus` with
`"type": "local"` and `command` as an array (`["node", "<repo>/dist/mcp/server.js"]`); a server is
connected unless `"disabled": true`. Its `timeout` is an object in milliseconds
(`{ "execution": … }`, default 12 hours, `startup` and `catalog` 30 s), so the defaults already
cover an ATC run or a `publish`.

OpenCode allows every tool by default, so add `permissions`, an ordered list where the **last
matching rule wins**: first `{ "action": "adtplus_*", "resource": "*", "effect": "ask" }`, then an
`allow` rule per read tool. An MCP tool's action is `<server>_<tool>`, so with the server named
`adtplus` a tool is `adtplus_adtplus_object` (the resource is always `*`). Code Mode is the default
in v2: a server's tools are called from code and grouped by server; set `"codemode": false` on the
server to keep them on the provider's native tool list. Whether the permission rules also apply
under Code Mode as expected is untested.

OpenCode 1 differs: servers directly under `mcp` with `enabled`, a `permission` object keyed by
tool name with `"ask"`/`"allow"` values, and a single `timeout` number.

## Tested

- VS Code and the Copilot CLI: routing and write flows measured (capabilities.md).
- Claude Code: registration and MCP roots checked; routing not measured yet.
- Codex and OpenCode (checked against the v2 docs on 2026-10-15): not tested (backlog). Their sections follow their own docs.
