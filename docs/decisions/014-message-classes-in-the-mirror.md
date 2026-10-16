# ADR-014: Message classes in the mirror, pulled and pushed through REST

- Status: accepted 2026-10-10

## Context

adt-ls serves a message class as a `.msagn.jsonc` placeholder and refuses to write it, so a mirror
would hold a read-only stub and a review there would skip the texts. The object tools read and
write message classes through ADT's REST API (`capabilities/messageclass.ts`). AFF has a format
for them, `msag-v1`: a header (description, original language) and the messages (`number`, `text`
≤ 73). It has no self-explanatory flag and no long texts.

## Decision

1. **Pull.** A message class becomes `MSAG <name>` with one file, `<name>.msag.json` in `msag-v1`,
   rendered from the REST read in the class's master language (messages sorted by number). The
   file is writable and goes through the re-pull rule like any other.
2. **Push.** A changed `.msag.json` is parsed, checked (format, lengths, numbers, no line breaks)
   and compared with the system's rendering against its base (the conflict check). Each new or
   changed message is sent through the REST upsert. A changed message keeps its self-explanatory
   flag, a new one gets SAP's default; the original language isn't changed. A message class has
   no inactive version, so it is never activated. The new base is the read-back's rendering.
3. **Create.** A new `<name>.msag.json` in a package folder is created through REST (SAP's name
   check, a request where the package records changes), in the logon language; a file whose
   original language is another one is refused. `mirror new --type MSAG` writes the skeleton.
4. **Gates.** As for every write of a message class: the allowlist on the package the system names
   (never the manifest's), a request where the package records changes, and the deny list once the
   plan holds a message class. Each write is a call-log line.
5. **Messages removed locally** are reported (`leftOut`), not deleted: a push deletes nothing
   (ADR-007), and `adtplus_irreversible deleteMessages` (confirmed) deletes them. The push counts
   as incomplete.
6. **A changed description** is left out the same way, and an in-system update refuses it: SAP
   records the change as `LIMU MESS <class>` without a message number and leaves a phantom
   `R3TR MSAG` in the package (known-issues). A create's description is recorded right.

## Retirement

The REST path retires when adt-ls serves `MSAG` as a writable file (ADR-002; ADT for VS Code 1.2
plans "Create MSAG"). adt-ls's own file will be AFF too, so a mirror's `.msag.json` stays; its name
and formatting may differ, and the switch is a deliberate change after a live test.

## Consequences

- A mirror review sees the texts; an agent adds a message by editing a file.
- A pull reads each message class over REST: 1 request, 2 when the logon language isn't the
  master language.
- The git helper's history can't show message changes per request: message classes have no version
  feed.
- Open (backlog): whether a push may delete messages waits for the general decision on deletions
  in mirror mode; a description change has no safe path yet on either system.

## Changes

- 2026-10-15: restated as it holds today for the public release.
