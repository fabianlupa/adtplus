# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/fabianlupa/adtplus/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and which version or commit
you ran. You'll get an answer within a week.

Of particular interest: a way around the write gates (`writeAllowlist`, `confirm`, the
mirrored-object gate, read-only mode; [ADR-003](docs/decisions/003-write-gates.md)), a way for
a project config to widen what the user's own config allows (ADR-006), and credentials or
session data reaching logs, the call log or another process.

## Scope

adt+ runs locally with the user's own SAP credentials and talks to SAP systems through SAP's
adt-ls. Vulnerabilities in SAP software, adt-ls or ADT for VS Code go to SAP; adt+ reports
issues it finds there upstream.
