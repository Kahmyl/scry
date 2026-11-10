import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Compatibility fixture for the public Codex model-exposure contract:
// openai/codex, core/src/mcp_tool_exposure.rs, blob b939752aae86c1a2c45ce318103b30a4bb06a974.
// Also follows tools/src/{mcp_tool,responses_api,json_schema/types}.rs.
// Output schemas are not charged. Namespace instructions ARE charged per tool.
// This covers Scry's emitted schema shapes; native import remains a separate gate.
type Schema = Record<string, any>;
const fields = [
  "$ref",
  "type",
  "description",
  "encrypted",
  "enum",
  "items",
  "minItems",
  "properties",
  "required",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "$defs",
  "definitions",
];
function normalize(value: any): any {
  if (typeof value === "boolean") return { type: "string" };
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const source = { ...value };
  if ("const" in source) source.enum = [source.const];
  if (!source.type && !source.$ref && !source.anyOf && !source.oneOf && !source.allOf) {
    if (source.properties || source.required || "additionalProperties" in source)
      source.type = "object";
    else if (source.items || source.prefixItems) source.type = "array";
    else if (source.enum || source.format) source.type = "string";
    else return {};
  }
  const types = Array.isArray(source.type) ? source.type : [source.type];
  if (types.includes("object") && !source.properties) source.properties = {};
  if (types.includes("array") && !source.items) source.items = { type: "string" };
  const result: Schema = {};
  for (const key of fields) {
    if (!(key in source)) continue;
    if (["properties", "$defs", "definitions"].includes(key)) {
      result[key] = Object.fromEntries(
        Object.entries(source[key]).map(([name, schema]) => [name, normalize(schema)]),
      );
    } else if (
      ["items", "anyOf", "oneOf", "allOf"].includes(key) ||
      (key === "additionalProperties" && typeof source[key] === "object")
    ) {
      result[key] = normalize(source[key]);
    } else result[key] = source[key];
  }
  return result;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export function utf8Prefix(value: string, maxBytes: number): string {
  let result = "",
    used = 0;
  for (const character of value) {
    const count = Buffer.byteLength(character);
    if (used + count > maxBytes) break;
    result += character;
    used += count;
  }
  return result;
}
export function codexPluginBudget(tools: Tool[], instructions: string, namespace = "scry_beta") {
  let usedBytes = 0;
  const visible: string[] = [],
    hidden: string[] = [],
    sizes: number[] = [];
  for (const tool of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const description = (tool.description ?? "").trim();
    const provenance = `${description}${/[.!?]$/.test(description) ? " " : ". "}This tool is part of plugin \`Scry\`.`;
    const fn = {
      type: "function",
      name: tool.name,
      description: utf8Prefix(provenance, 1000),
      strict: false,
      parameters: normalize(tool.inputSchema),
    };
    if (bytes(fn) > 8000)
      fn.parameters = { type: "object", properties: {}, additionalProperties: true };
    const size = bytes({
      type: "namespace",
      name: namespace,
      description: utf8Prefix(instructions, 1000).trim(),
      tools: [fn],
    });
    sizes.push(size);
    if (size <= 8000 && usedBytes + size <= 64000) {
      visible.push(tool.name);
      usedBytes += size;
    } else hidden.push(tool.name);
  }
  return {
    visible,
    hidden,
    usedBytes,
    totalBytes: sizes.reduce((a, b) => a + b, 0),
    maxToolBytes: Math.max(...sizes),
  };
}
