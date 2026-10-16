import { ABAPObject, Config, Expressions, MemoryFile, Registry, Statements, Unknown, type Nodes } from '@abaplint/core';

type Token = ReturnType<Nodes.StatementNode['getFirstToken']>;

/** Parsing needs no rule configuration: built once, not per source. */
const config = Config.getDefault();

/**
 * abaplint's statements of an ABAP source, comments as statements of their own. adt+ reads ABAP
 * only through these, never its own regex over the text (ADR-012). Parsed as a program, which
 * takes any statement: a class include or a function module's source parses the same way.
 */
export function abapStatements(source: string): readonly Nodes.StatementNode[] {
  const registry = new Registry(config).addFile(new MemoryFile('zadtplus_source.prog.abap', source));
  registry.parse();
  const obj = registry.getFirstObject();
  const file = obj && ABAPObject.is(obj) ? obj.getABAPFiles()[0] : undefined;
  return file?.getStatements() ?? [];
}

/**
 * The method name token of a `METHOD <name>` statement, else undefined. Stopgap (ADR-012, backlog
 * "Upstream to abaplint: namespaced interface method"): abaplint parses `METHOD zif_x~/ns/m.` as
 * an unknown statement, so one starting with METHOD gives its next token.
 */
export function implementedMethod(statement: Nodes.StatementNode): Token | undefined {
  if (statement.get() instanceof Statements.MethodImplementation) {
    return statement.findFirstExpression(Expressions.MethodName)?.getFirstToken();
  }
  const [keyword, name] = statement.getTokens();
  return statement.get() instanceof Unknown && keyword?.getStr().toUpperCase() === 'METHOD' ? name : undefined;
}

/** The method name token of a `METHODS` or `CLASS-METHODS` statement, else undefined. */
export function declaredMethod(statement: Nodes.StatementNode): Token | undefined {
  return statement.get() instanceof Statements.MethodDef ? statement.findFirstExpression(Expressions.MethodName)?.getFirstToken() : undefined;
}
