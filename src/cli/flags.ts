export interface Flags {
  [key: string]: string | undefined;
  confirm?: string;
  json?: string;
}

/** `--flag value` and `--flag=value` pairs plus bare boolean flags (`--confirm`, `--json`). */
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    // `--key=value` takes the value as written, even one starting with `--`.
    const eq = arg.indexOf('=');
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true';
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}
