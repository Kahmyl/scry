import path from "node:path";
import ts from "typescript";

/** Veil owns message interpretation; this pinned, deterministic HTML parser
 * brings no Scry runtime/transport/storage authority into that boundary. */
export function unsupportedVeilDependencies(dependencies = {}) {
  return Object.entries(dependencies)
    .filter(
      ([name, version]) =>
        name !== "@scry/contracts" && !(name === "parse5" && version === "7.3.0"),
    )
    .map(([name]) => name);
}

/** Runtime tooling is explicit; adding the private TS custodian loader does not
 * permit another implementation owner or arbitrary new runtime dependencies. */
export function unsupportedPraxisDependencies(dependencies = {}) {
  const allowed = new Set([
    "@scry/contracts",
    "playwright",
    "rrweb",
    "tsx",
    "@playwright/mcp",
    "@modelcontextprotocol/sdk",
    "playwright-mcp-runtime",
    "proxy-chain",
    "ajv",
  ]);
  return Object.keys(dependencies).filter((name) => !allowed.has(name));
}

const protectionClasses = new Set([
  "SensitiveValueClassifier",
  "ProtectionAuthority",
  "ProtectedCaptureVault",
  "BrowserProtectedKeyring",
  "EvidenceCipher",
]);
const cryptographicOperations = new Set(["createCipheriv", "createDecipheriv", "hkdfSync"]);
const evidenceClasses = new Set([
  "AuthenticatedEvidenceStore",
  "ChronicleRecording",
  "ChronicleEvidenceSession",
  "ChronicleRepository",
]);

/** Checks the actual syntax, including aliased imports and dynamic imports. */
export function boundaryViolations(sourcePath, source) {
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const inVeil = sourcePath.startsWith("packages/veil/src/");
  const inChronicle = sourcePath.startsWith("packages/chronicle/src/");
  const inPraxis = sourcePath.startsWith("packages/praxis/src/");
  const inAssurance = /^packages\/assurance\/(?:src|test)\//u.test(sourcePath);
  const assuranceFixture = sourcePath.startsWith("packages/assurance/test/");
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
    if (!inChronicle && ts.isClassDeclaration(node) && evidenceClasses.has(node.name?.text))
      violations.push("evidence custody is reimplemented outside Chronicle");
    if (
      !inChronicle &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:browser_evidence_streams|browser_effect_events|browser_captures)\b/iu.test(
        node.text,
      )
    )
      violations.push("evidence custody SQL is implemented outside Chronicle");
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const specifier of specifiers) {
    if (inPraxis && /^(?:@scry\/(?!contracts$)|pg$|@nestjs\/)/u.test(specifier))
      violations.push("browser mechanics depend on another boundary implementation");
    if (
      !inPraxis &&
      !assuranceFixture &&
      /^(?:playwright|playwright-mcp-runtime|@playwright\/mcp|rrweb)(?:\/|$)/u.test(specifier)
    )
      violations.push("browser driver is imported outside Praxis");
    if (specifier.startsWith("@scry/praxis/"))
      violations.push("consumer imports a Praxis internal module");
    if (
      !inAssurance &&
      (specifier === "@scry/assurance" || specifier.startsWith("@scry/assurance/"))
    )
      violations.push("production source depends on Assurance");
    if (
      inAssurance &&
      /^(?:@scry\/(?!contracts$|praxis$|veil$|chronicle$)|pg$|@nestjs\/)/u.test(specifier)
    )
      violations.push(
        "Assurance reaches an application, database driver, or private boundary module",
      );
    if (inAssurance && !assuranceFixture && /^@scry\/(?!contracts$)/u.test(specifier))
      violations.push("diagnostic analysis depends on a runtime implementation");
    if (specifier.startsWith("@scry/veil/"))
      violations.push("consumer imports a Veil internal module");
    if (specifier.startsWith(".")) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(sourcePath), specifier),
      );
      if (!inAssurance && resolved.startsWith("packages/assurance/"))
        violations.push("production reaches Assurance through a relative path");
      if (inAssurance && !resolved.startsWith("packages/assurance/"))
        violations.push("Assurance reaches outside public package entry points");
      if (!inVeil && resolved.startsWith("packages/veil/"))
        violations.push("consumer reaches Veil through a relative internal path");
      if (inVeil && !resolved.startsWith("packages/veil/src/"))
        violations.push("Veil reaches outside its package through a relative path");
      if (inChronicle && !resolved.startsWith("packages/chronicle/src/"))
        violations.push("Chronicle reaches outside its package through a relative path");
      if (!inChronicle && resolved.startsWith("packages/chronicle/"))
        violations.push("consumer reaches Chronicle through a relative internal path");
      if (inPraxis && !resolved.startsWith("packages/praxis/src/"))
        violations.push("Praxis reaches outside its package through a relative path");
      if (!inPraxis && resolved.startsWith("packages/praxis/"))
        violations.push("consumer reaches Praxis through a relative internal path");
    }
    if (specifier.startsWith("@scry/chronicle/"))
      violations.push("consumer imports a Chronicle internal module");
    if (
      inChronicle &&
      /^(?:@scry\/(?!contracts$)|playwright(?:\/|$)|rrweb(?:\/|$)|pg$|@nestjs\/)/u.test(specifier)
    )
      violations.push(
        "Chronicle depends on protection, browser, application, or database-driver implementation",
      );
    if (inVeil && /^(?:@scry\/(?!contracts$)|playwright(?:\/|$)|@nestjs\/)/u.test(specifier))
      violations.push(
        "Veil depends on browser, application, evidence, or diagnostic implementation",
      );
  }
  return [...new Set(violations)];
}
