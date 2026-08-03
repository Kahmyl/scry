import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const inventoryPath = resolve(root, "docs/architecture/praxis-interaction-inventory.json");
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const sourceRoot = resolve(root, inventory.scope);
const files = (await readdir(sourceRoot)).filter((file) => file.endsWith(".ts"));
const lowLevel = /\.(?:click|dblclick|fill|press|focus|setChecked|selectOption|inputValue|textContent|waitFor|hover|tap|type|check|uncheck|dispatchEvent|evaluate|isChecked|isEnabled|isVisible|goto|reload|close|newPage|newContext)\s*\(|(?:keyboard|mouse)\.(?:press|insertText|type|click|move|down|up)\s*\(|navigator\.clipboard/;
const discovered = [];
for (const file of files) {
  const source = `packages/executor/src/${file}`;
  const text = await readFile(resolve(sourceRoot, file), "utf8");
  if (lowLevel.test(text)) discovered.push(source);
}
const entries = new Map(inventory.entries.map((entry) => [entry.source, entry]));
const dispositions = new Set(inventory.dispositions);
const failures = [];
if (inventory.cutoff !== true) failures.push("Praxis cutoff inventory must declare cutoff=true");
for (const source of discovered) if (!entries.has(source)) failures.push(`unclassified low-level browser operations: ${source}`);
for (const [source, entry] of entries) {
  if (!files.includes(source.split("/").at(-1))) failures.push(`inventory source does not exist: ${source}`);
  if (!dispositions.has(entry.disposition)) failures.push(`invalid disposition for ${source}: ${entry.disposition}`);
  if (entry.disposition === "temporary_bypass") failures.push(`temporary bypass remains after cutoff: ${source}`);
  for (const field of ["consumer", "grounding", "privacy", "mutationRisk", "retry", "projection", "targetMilestone"]) if (entry[field] === undefined) failures.push(`missing ${field}: ${source}`);
}
const forbiddenCutoffPatterns = [
  ["SCRY_PRAXIS_LEGACY_CONSUMERS", "legacy consumer rollback flag"],
  ["LegacyPraxisAdapter", "legacy Praxis adapter"],
  ["praxis-legacy-adapter", "legacy Praxis adapter module"],
  ["extractProtectedValue", "legacy protected acquisition alias"],
  ["clickGroundedTarget(", "direct grounded click helper"],
  ["fillGroundedTarget(", "direct grounded fill helper"],
  ["selectGroundedTarget(", "direct grounded select helper"],
  ["checkGroundedTarget(", "direct grounded check helper"],
];
for (const file of files) {
  const text = await readFile(resolve(sourceRoot, file), "utf8");
  const disposition = entries.get(`packages/executor/src/${file}`)?.disposition;
  for (const [pattern, reason] of forbiddenCutoffPatterns) if (disposition !== "privacy_exception" && text.includes(pattern)) failures.push(`${reason} remains in packages/executor/src/${file}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Praxis inventory covers ${discovered.length} modules with low-level browser operations; ${entries.size} modules are classified.\n`);
