import path from "node:path";
import ts from "typescript";

/** Syntax-aware reachability, including type imports, re-exports, lazy imports,
 * CommonJS references, and process fixtures addressed relative to import.meta.url.
 * Computed module loads are explicit unknowns, never proof of non-reachability. */
export function moduleReferences(filename, source) {
  const references = new Set();
  let computed = false;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  const add = (node) => {
    if (literal(node)) references.add(node.text);
    else computed = true;
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0]);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      node.arguments[1].getText(file) === "import.meta.url" &&
      literal(node.arguments[0]) &&
      /\.[cm]?[jt]sx?$/u.test(node.arguments[0].text)
    )
      references.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { references: [...references], computed };
}

export function resolveReference(from, specifier, files, entries) {
  let base;
  if (specifier.startsWith("."))
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  else if (specifier.startsWith("@scry/")) base = entries.get(specifier);
  else return null; // External packages are checked against owner manifests separately.
  if (!base) return undefined;
  const candidates = [
    base,
    base.replace(/\.[cm]?jsx?$/u, ".ts"),
    base.replace(/\.jsx?$/u, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => files.has(candidate));
}

export function traceSourceGraph({ roots, files, entries, read }) {
  const reachable = new Set();
  const missing = [];
  const computed = [];
  const visit = (filename) => {
    if (reachable.has(filename)) return;
    if (!files.has(filename)) {
      missing.push({ from: filename, specifier: filename });
      return;
    }
    reachable.add(filename);
    if (!/\.[cm]?[jt]sx?$/u.test(filename)) return;
    const parsed = moduleReferences(filename, read(filename));
    if (parsed.computed) computed.push(filename);
    for (const specifier of parsed.references) {
      const target = resolveReference(filename, specifier, files, entries);
      if (target === undefined) missing.push({ from: filename, specifier });
      else if (target !== null) visit(target);
    }
  };
  roots.forEach(visit);
  return { reachable, missing, computed };
}
