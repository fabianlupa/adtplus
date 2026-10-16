/**
 * The helper's stderr: plain lines, and git-style progress lines that end in `\r` so the next
 * one overwrites them. A plain line, or `end`, first ends an open progress line, so it never
 * lands on top of one.
 */
export function stderrLines(write: (text: string) => void): { line: (text: string) => void; progress: (text: string) => void; end: () => void } {
  let open = false;
  /** The open progress line's length: a shorter one after it is padded over its rest. */
  let shown = 0;
  const end = () => {
    if (open) write('\n');
    open = false;
    shown = 0;
  };
  return {
    line: (text) => {
      end();
      write(`${text}\n`);
    },
    progress: (text) => {
      open = true;
      write(`${text.padEnd(shown)}\r`);
      shown = text.length;
    },
    end,
  };
}

function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/**
 * Progress lines for one step of `total`: percent, done of total, units, and the time left at the
 * rate seen since the first call (work done before it, a resumed pull's, doesn't count).
 */
export function meter(show: (line: string) => void, label: string): (done: number, total: number, units?: number) => void {
  let first: { done: number; at: number } | undefined;
  return (done, total, units) => {
    if (total <= 0) return;
    const now = Date.now();
    first ??= { done, at: now };
    const rate = (done - first.done) / Math.max(1, now - first.at);
    const left = rate > 0 && done < total ? `, ~${duration((total - done) / rate)} left` : '';
    show(`adtplus: ${label}: ${Math.floor((100 * done) / total)}% (${done}/${total})${units !== undefined ? `, ${units} units` : ''}${left}`);
  };
}
