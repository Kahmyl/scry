import path from "node:path";
import ts from "typescript";

const protectionClasses = new Set([
  "SensitiveValueClassifier",
  "ProtectionAuthority",
  "ProtectedCaptureVault",
  "BrowserProtectedKeyring",
  "EvidenceCipher",
]);
const cryptographicOperations = new Set(["createCipheriv", "createDecipheriv", "hkdfSync"]);

/** Checks the actual syntax, including aliased imports and dynamic imports. */
export function boundaryViolations(sourcePath, source) {
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const inVeil = sourcePath.startsWith("packages/veil/src/");
  const violations = [];
  const cryptoAliases = new Set(cryptographicOperations);
  const specifiers = [];
  const addSpecifier = (node) => {
    if (node && ts.isStringLiteral(node)) specifiers.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier.text === "node:crypto" &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const binding of node.importClause.namedBindings.elements) {
          if (cryptographicOperations.has(binding.propertyName?.text ?? binding.name.text))
            cryptoAliases.add(binding.name.text);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addSpecifier(node.arguments[0]);
      const operation = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (!inVeil && operation && cryptoAliases.has(operation))
        violations.push("cryptographic protection is implemented outside Veil");
    }
    if (!inVeil && ts.isClassDeclaration(node) && protectionClasses.has(node.name?.text))
      violations.push("protection authority is reimplemented outside Veil");
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const specifier of specifiers) {
    if (specifier === "@scry/assurance" || specifier.startsWith("@scry/assurance/"))
      violations.push("production source depends on Assurance");
    if (specifier.startsWith("@scry/veil/"))
      violations.push("consumer imports a Veil internal module");
    if (specifier.startsWith(".")) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(sourcePath), specifier),
      );
      if (!inVeil && resolved.startsWith("packages/veil/"))
        violations.push("consumer reaches Veil through a relative internal path");
      if (inVeil && !resolved.startsWith("packages/veil/src/"))
        violations.push("Veil reaches outside its package through a relative path");
    }
    if (inVeil && /^(?:@scry\/(?!contracts$)|playwright(?:\/|$)|@nestjs\/)/u.test(specifier))
      violations.push(
        "Veil depends on browser, application, evidence, or diagnostic implementation",
      );
  }
  return [...new Set(violations)];
}
