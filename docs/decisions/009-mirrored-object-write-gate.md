# ADR-009: A session's in-system write is refused on an object it mirrors

- Status: accepted 2026-10-05

## Context

An agent on the mirror route once sent an in-system source update with the text `"x"` to a
behavior definition it had mirrored, "trying to inspect stored BDEF source". adt+ accepted it: the
package was allowlisted and an update takes no `confirm`. The mirror's conflict check caught it on
the next pull and a push restored it, but nothing in adt+ held the agent to one route per object.

How mirrors are used: a mirror is a **throwaway** for one task, with a git repository of its own.
A later session works in the system directly unless it takes the mirror up again; a session that
uses a mirror must not write around it.

What the parts can see: the daemon serves every client, outlives sessions and knows no workspace.
An MCP server process is one client session (VS Code: one per window) and knows every mirror call
it makes. Mirror push writes through the SDK itself and never dispatches the object commands.

## Decision

### Refuse, not `confirm`

A write that changes what a mirror file holds is **refused** when the object is held by a mirror
**the same session used**: `object.update` (source or AFF properties), `object.deleteMessages`,
and `object.applyQuickfixes` for every object of its worklist. The refusal names the mirror root
and the object's files, and says to edit them and push. No `confirm` overrides it.

- `confirm` is a speed bump the model sets itself (ADR-003); an error that names it as the fix gets
  retried with it. A refusal that names the file to edit turns the error into the right next step.
- Nothing is lost: the mirror route writes the same object, with the conflict check an in-system
  write lacks. Deleting the mirror folder at the end of the task ends the refusal.
- It is not a security boundary: the CLI is exempt, and an agent with a shell can edit or delete
  the manifest. It holds the route for an agent that uses the tools as given.

### The session's mirrors

- The **MCP server** keeps, for its process lifetime, the root of every mirror call it sent (any
  action, success or not). It sends them with its workspace folders on the covered commands; the
  model supplies neither.
- Nothing about the session is kept in the daemon, so a daemon restart changes nothing, and a new
  session starts with no mirrors.

### When an object is held

- The daemon reads the manifest of each root that lies (after `realpath`) inside one of the
  request's workspace folders.
- The manifest holds the object when its system is the request's and it lists the object with at
  least one file that isn't read-only. An object of stubs only can't be pushed, so it isn't held.
- **No manifest** at a root: that root holds nothing. **A manifest that doesn't parse** refuses
  the write (ADR-003: fail closed), naming the file.
- A read of a held object isn't refused; it carries a note that the mirror's files may be newer.

### Not covered

- **Create**: an object a manifest holds already exists. **Delete**: a push can't delete, so this
  is the only route, and it needs `confirm`. **Activate**: changes no source. Transport and publish
  actions change no mirrored file.
- **Exempt:** mirror push (it never dispatches these commands), the CLI (the user's route, no
  session), and another session until it runs a mirror action on that root itself.
- For `update` and `deleteMessages` the check runs after read-only mode and the deny list, before
  the rate limit and any SAP call: a refused write costs no backend request and no budget. A quick
  fix's objects are known only once its worklist is read, so `applyQuickfixes` checks them then,
  before it applies anything.

## Consequences

- An agent on the mirror route can't overwrite a mirrored object in the system through MCP; the
  refusal tells it which file to edit. A fresh session can write the same object directly.
- In VS Code a new chat in the same window still holds the mirrors an earlier chat used, until the
  folder is deleted or the window reloads.
- Not covered: the same system configured under two system ids; edits through ADT for VS Code's
  `abap://` file system, which adt+ doesn't see; a git clone (ADR-011), which no session owns.

## Changes

- 2026-10-15: restated as it holds today for the public release.
