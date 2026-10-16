import { ALL_CMDS } from './protocol.js';

/**
 * Per-command deny list (docs/decisions/003-write-gates.md), for when a client auto-approves every
 * tool call — VS Code's Allow all and Autopilot ignore
 * `chat.tools.eligibleForAutoApproval` (M7.0 step 2), so a command that must
 * never run has to be refused here.
 *
 * `ADTPLUS_DENY` is a comma-separated list of daemon command names, each
 * optionally ending in `*`: `object.delete,transport.release,run.*`. Like
 * ADTPLUS_READONLY it works two ways, and both apply: the daemon's own
 * environment, and the client's, stamped onto each request by `sendCommand`.
 *
 * A pattern that matches no command is an error, not a no-op: a typo must not
 * leave the command it meant to deny running.
 */
export function parseDenyList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function matches(pattern: string, cmd: string): boolean {
  return pattern.endsWith('*') ? cmd.startsWith(pattern.slice(0, -1)) : cmd === pattern;
}

/** Patterns that match no daemon command. */
export function unknownDenyPatterns(patterns: string[]): string[] {
  return patterns.filter((p) => !ALL_CMDS.some((cmd) => matches(p, cmd)));
}

export function isDenied(cmd: string, patterns: string[]): boolean {
  return patterns.some((p) => matches(p, cmd));
}

/** The refusal text when `cmd` may not run under `patterns`, else undefined. */
export function denyRefusal(cmd: string, patterns: string[]): string | undefined {
  const unknown = unknownDenyPatterns(patterns);
  if (unknown.length > 0) {
    return `ADTPLUS_DENY names no known command (${unknown.join(', ')}); refusing "${cmd}" until it is fixed`;
  }
  return isDenied(cmd, patterns) ? `adt+ refuses "${cmd}" (ADTPLUS_DENY)` : undefined;
}
