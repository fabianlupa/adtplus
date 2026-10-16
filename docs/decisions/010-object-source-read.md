# ADR-010: `adtplus_object read`, source by name through adt-ls

- Status: accepted 2026-10-06

## Context

In VS Code, Copilot reads source through ADT for VS Code's `abap://` file system. Terminal agents
(Claude Code, Codex, OpenCode, Copilot CLI) don't have it, so without a read in adt+ they couldn't
do a refactoring at all, and only mirror mode (ADR-007), which is meant for larger work, filled
the gap. The file system also serves only the draft, and agents mixed up draft and active
versions.

adt-ls reads source per file: the SDK's `source.read({include, version})`, with `version:
'active'` switching the object to its active version for the read.

## Decision

- **A `read` action on `adtplus_object`** (read tier), daemon command `object.read`, CLI
  `adtplus object read`. Through adt-ls; only reads of released versions by number go through
  REST (the version feed, a fallback under ADR-002), and form-based objects read as their AFF
  JSON (ADR-018).
- **Addressing as `update`:** `name` + `objectType`, `include` for classes only (AFF's names:
  `definitions`, `implementations`, `macros`, `testclasses`). A read can be edited and written back
  unchanged.
- **The result says which version it is.**
  - By default, what adt-ls serves: the user's own draft if there is one, else the active version;
    `served` says which, with a note on a draft.
  - `active` reads the activated version under the daemon's **exclusive** hold on the object, since
    the SDK switches the object's version for the read. An object adt-ls won't switch, such as a
    draft never activated, answers "has no active version".
- **Whole text by default, verbatim.** Narrowing is cut locally from the text read, never another
  SAP call: `method` (`METHOD … ENDMETHOD.` blocks with line numbers; a name without `~` also finds
  `intf~name`), `grep` (regex with context), or a line range, at most one of them. `maxLines` caps
  any answer, with no default; `truncated` says it cut.
- **A class's whole main source read lists its includes** that exist. SAP creates all four with a
  template comment, so listed doesn't mean used.
- **Mirrors (ADR-009):** a read of an object a mirror of the same MCP session holds is not refused;
  it carries a note that the mirror's files may be newer.

## Consequences

- Terminal agents can read, edit (`update`) and check objects in the system without a mirror.
- In VS Code, Copilot can read either way; the tool description names `read` next to the `abap:`
  URIs.
- Line endings stay as the system stores them (CRLF), so a read round-trips through `update`.

## Changes

- 2026-10-15: restated as it holds today for the public release.
