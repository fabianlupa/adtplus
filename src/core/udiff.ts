/**
 * A unified diff of two texts by line (Myers' O(ND) algorithm), for the transport diff's own
 * diffs next to adt-ls's (`capabilities/transport-diff.ts`). Headers follow adt-ls's
 * `transport.getDiff`: `--- <label> (old)` / `+++ <label> (new)`.
 */

type Op = { kind: ' ' | '-' | '+'; line: string };

function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.replace(/\r\n/g, '\n').split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Edit steps past which the script is given up for one replacement of the whole middle: the
 * trace keeps 2d+1 entries per step, ~36 MB at this many.
 */
const MAX_EDITS = 3000;

/** The shortest edit script from `a` to `b`, as kept, removed and added lines in order. */
function editScript(a: string[], b: string[]): Op[] {
  // Lines both share at the start and the end are kept as they are.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post += 1;
  const keep = (lines: string[]): Op[] => lines.map((line) => ({ kind: ' ', line }));
  const midA = a.slice(pre, a.length - post);
  const midB = b.slice(pre, b.length - post);
  const mid = middleScript(midA, midB) ?? [
    ...midA.map((line): Op => ({ kind: '-', line })),
    ...midB.map((line): Op => ({ kind: '+', line })),
  ];
  return [...keep(a.slice(0, pre)), ...mid, ...keep(a.slice(a.length - post))];
}

/** Myers' script for `a` → `b`; undefined past `MAX_EDITS` steps. */
function middleScript(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Per step d, the entries k = -d … d of `v` before it (index k + d).
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d += 1) {
    if (d > MAX_EDITS) return undefined;
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk the trace back from (n, m).
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d]!;
    const at = (k: number) => vd[k + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', line: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ kind: '+', line: b[y - 1]! });
    else ops.push({ kind: '-', line: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** `old` → `new` as a unified diff with `context` lines around each change; `''` when they're equal. */
export function unifiedDiff(label: string, oldText: string, newText: string, context = 3): string {
  const a = lines(oldText);
  const b = lines(newText);
  const ops = editScript(a, b);
  if (!ops.some((o) => o.kind !== ' ')) return '';

  const out = [`--- ${label} (old)`, `+++ ${label} (new)`];
  let i = 0;
  // Line numbers (0-based) in a and b at ops[i].
  const posA: number[] = [];
  const posB: number[] = [];
  for (let ia = 0, ib = 0, j = 0; j < ops.length; j += 1) {
    posA.push(ia);
    posB.push(ib);
    if (ops[j]!.kind !== '+') ia += 1;
    if (ops[j]!.kind !== '-') ib += 1;
  }
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.kind === ' ') i += 1;
    if (i >= ops.length) break;
    const start = Math.max(0, i - context);
    // Extend while the next change is within 2 × context kept lines.
    let end = i;
    let kept = 0;
    for (let j = i; j < ops.length; j += 1) {
      if (ops[j]!.kind === ' ') {
        kept += 1;
        if (kept > 2 * context) break;
      } else {
        kept = 0;
        end = j;
      }
    }
    const stop = Math.min(ops.length, end + 1 + context);
    const hunk = ops.slice(start, stop);
    const countA = hunk.filter((o) => o.kind !== '+').length;
    const countB = hunk.filter((o) => o.kind !== '-').length;
    const fromA = countA === 0 ? posA[start]! : posA[start]! + 1;
    const fromB = countB === 0 ? posB[start]! : posB[start]! + 1;
    out.push(`@@ -${fromA},${countA} +${fromB},${countB} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.line}`);
    i = stop;
  }
  return `${out.join('\n')}\n`;
}
