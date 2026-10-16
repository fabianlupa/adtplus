import path from 'node:path';
import { sendCommand } from '../daemon/client.js';
import type { DaemonProgress, DaemonRequest } from '../daemon/protocol.js';
import { checkRemoteName, parseAddress } from './address.js';
import { importStream } from './fastimport.js';
import { fetchStream } from './fetch.js';
import { stderrLines } from './output.js';
import { pushRef } from './push.js';
import { realGit } from './git.js';
import { MAIN, privateRef, serve } from './protocol.js';

/**
 * `git-remote-adtplus <remote> <address>`: git runs it for `adtplus::<address>`
 * URLs (docs/decisions/011-git-remote-helper.md). A daemon client like the CLI,
 * with client kind `git`.
 */
async function main(): Promise<void> {
  const [remoteArg, addressArg] = process.argv.slice(2);
  if (remoteArg === undefined || addressArg === undefined || process.env.GIT_DIR === undefined) {
    throw new Error('git-remote-adtplus is run by git: git clone adtplus::<system>/package/<PKG>');
  }
  const remote = checkRemoteName(remoteArg);
  const address = parseAddress(addressArg);
  // Absolute on clone, else relative to the folder git started the helper in (P1).
  const gitDir = path.resolve(process.cwd(), process.env.GIT_DIR);
  const git = realGit();
  const send = (req: DaemonRequest, onProgress?: (p: DaemonProgress) => void) =>
    sendCommand(req, { client: 'git', ...(onProgress ? { onProgress } : {}) });
  let verbosity = 1;
  let progress = false;
  let dryRun = false;
  const pushOptions: string[] = [];
  const stderr = stderrLines((text) => void process.stderr.write(text));
  const warn = stderr.line;
  const say = (line: string) => {
    if (verbosity > 0) warn(line);
  };
  const shownProgress = () => (progress && verbosity > 0 ? stderr.progress : undefined);

  await serve(process.stdin, process.stdout, {
    remote,
    tip: () => git.revParse(`${privateRef(remote)}^0`),
    async importRefs(refs) {
      if (!refs.includes(MAIN)) return importStream(undefined);
      const shown = shownProgress();
      try {
        return await fetchStream({ send, git, gitDir, remote, address, say, warn, ...(shown ? { progress: shown } : {}) });
      } finally {
        stderr.end();
      }
    },
    async pushRefs(specs) {
      const shown = shownProgress();
      const answers: string[] = [];
      try {
        for (const spec of specs) {
          answers.push(await pushRef({ send, git, gitDir, remote, address, say, warn, ...(shown ? { progress: shown } : {}) }, spec, { dryRun, pushOptions }));
        }
      } finally {
        stderr.end();
      }
      return answers;
    },
    option(name, value) {
      if (name === 'verbosity' && /^\d+$/.test(value)) {
        verbosity = Number(value);
        return true;
      }
      if (name === 'dry-run' && (value === 'true' || value === 'false')) {
        dryRun = value === 'true';
        return true;
      }
      if (name === 'push-option') {
        pushOptions.push(value);
        return true;
      }
      if (name === 'progress' && (value === 'true' || value === 'false')) {
        progress = value === 'true';
        return true;
      }
      return false;
    },
  });
}

main().catch((err) => {
  process.stderr.write(`adtplus: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
