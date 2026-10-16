import { ABAPObject, Comment, Config, MemoryFile, Registry, Statements, type IRegistry, type Issue } from '@abaplint/core';

const RULE = 'no_comments_between_methods';

/**
 * `no_comments_between_methods` also flags a comment on an `ENDMETHOD.` line, which SAP stores in
 * the method's include (`onprem`): such a finding is wrong.
 */
export function isEndMethodLineComment(registry: IRegistry, issue: Issue): boolean {
  if (issue.getKey() !== RULE) return false;
  const raw = registry.getFileByName(issue.getFilename());
  const obj = raw && registry.findObjectForFile(raw);
  const file = obj && ABAPObject.is(obj) ? obj.getABAPFileByName(issue.getFilename()) : undefined;
  const row = issue.getStart().getRow();
  return !!file?.getStatements().some((s) => s.get() instanceof Statements.EndMethod && s.getEnd().getRow() === row);
}

/**
 * A class's main source is put together from its includes: the sections (CU/CO/CI) and one
 * include per method; the rest is the class pool's frame. A comment in the frame (`onprem`) is refused by SAP on a line of its own
 * between definition and implementation or between methods, and goes into the active source with
 * no inactive version and no activation after the last ENDCLASS or on a line with the definition's
 * ENDCLASS, `CLASS … IMPLEMENTATION` or the last ENDCLASS. A comment before `CLASS … DEFINITION`
 * (public section) or on an ENDMETHOD line (the method's include) is stored as usual.
 *
 * abaplint's `no_comments_between_methods` (also run by `mirror check`) finds the comments inside
 * the implementation; this adds the ones between definition and implementation and after the last
 * ENDCLASS, which it doesn't look at (to be proposed upstream, backlog). Statements there are left
 * to SAP and abaplint's parser. Returns why the source can't be stored as written, or undefined;
 * with `current`, the system's text, a comment it already has in the same place is let through
 * (`onprem` keeps one after the last ENDCLASS, so a class read and written back may carry one).
 */
export function classRegionProblem(source: string, current?: string): string | undefined {
  const comments = frameComments(source);
  if (comments.length === 0) return undefined;
  // A comment the system's version already has in the same place is SAP's own, not a change.
  const known = current === undefined ? [] : frameComments(current).map(key);
  const first = comments.find((c) => {
    const at = known.indexOf(key(c));
    if (at < 0) return true;
    known.splice(at, 1);
    return false;
  });
  if (!first) return undefined;
  return (
    `line ${first.row}: a comment ${first.where} (${JSON.stringify(first.text.slice(0, 60))}). ` +
    'A class is stored as its sections and one include per method, and a comment in between has no include to go to: ' +
    'SAP refuses it, or takes it into the active source without an activation. ' +
    'Move it into a method or a section, or remove it.'
  );
}

export interface FrameComment {
  row: number;
  /** The comment itself, from its first character: the code before it on the line may be reformatted. */
  text: string;
  where: string;
  /** abaplint's `no_comments_between_methods` finds it; the others are this module's stopgap. */
  byRule: boolean;
}

const key = (c: FrameComment) => `${c.where}\0${c.text}`;

/** abaplint's configuration with only `no_comments_between_methods` on, built once. */
let ruleOnly: Config | undefined;

/** The comments in a class main source's frame, by line. */
export function frameComments(source: string): FrameComment[] {
  if (!ruleOnly) {
    const raw = Config.getDefault().get();
    for (const rule of Object.keys(raw.rules)) if (rule !== RULE) raw.rules[rule] = false;
    ruleOnly = new Config(JSON.stringify(raw));
  }
  const registry = new Registry(ruleOnly).addFile(new MemoryFile('zcl_region_check.clas.abap', source));
  registry.parse();
  const obj = registry.getFirstObject();
  const file = obj && ABAPObject.is(obj) ? obj.getMainABAPFile() : undefined;
  if (!obj || !file) return [];
  const lines = source.split(/\r?\n/);
  const at = (row: number, col: number) => (lines[row - 1] ?? '').slice(col - 1).trim();

  const found: FrameComment[] = [];
  for (const issue of registry.findIssuesObject(obj)) {
    if (issue.getKey() !== RULE || isEndMethodLineComment(registry, issue)) continue;
    const { row, col } = { row: issue.getStart().getRow(), col: issue.getStart().getCol() };
    found.push({ row, text: at(row, col), where: 'in the implementation outside a METHOD … ENDMETHOD', byRule: true });
  }
  // The frame around the implementation: from the definition's ENDCLASS to CLASS … IMPLEMENTATION, and from the last ENDCLASS on.
  const statements = file.getStatements();
  const definition = statements.findIndex((s) => s.get() instanceof Statements.ClassDefinition);
  const definitionEnd = definition < 0 ? -1 : statements.findIndex((s, i) => i > definition && s.get() instanceof Statements.EndClass);
  const implementation = statements.findIndex((s) => s.get() instanceof Statements.ClassImplementation);
  const lastEnd = statements.map((s) => s.get() instanceof Statements.EndClass).lastIndexOf(true);
  statements.forEach((s, i) => {
    if (!(s.get() instanceof Comment)) return;
    const { row, col } = { row: s.getStart().getRow(), col: s.getStart().getCol() };
    // A comment on the definition's ENDCLASS line comes after it; one on the CLASS … IMPLEMENTATION line is the rule's.
    const between = definitionEnd >= 0 && implementation > definitionEnd && i > definitionEnd && i < implementation;
    const after = implementation >= 0 && lastEnd > implementation && i > lastEnd;
    if (between) found.push({ row, text: at(row, col), where: 'between the definition and the implementation', byRule: false });
    else if (after) found.push({ row, text: at(row, col), where: 'after the last ENDCLASS', byRule: false });
  });
  return found.sort((a, b) => a.row - b.row);
}
