import { z } from "zod";
import { playwrightToolDefinitions } from "./playwright-tool-definitions.js";

export { playwrightToolDefinitions };
export const nativeBrowserTools = new Set(playwrightToolDefinitions.map((t) => t.name));
export const browserToolCommandSchema = z.object({
  kind: z.literal("browser_tool"),
  tool: z
    .string()
    .refine((name) => nativeBrowserTools.has(name as never) || name === "browser_type_secret"),
  args: z
    .record(z.string(), z.unknown())
    .refine(
      (value) =>
        JSON.stringify(value).length <= 64_000 &&
        !["filename", "code", "function"].some((k) => k in value),
    ),
});
/** Only observation tools are safe to classify as not dispatching an app change. */
export const nativeObservationTools = new Set([
  "browser_snapshot",
  "browser_find",
  "browser_wait_for",
  "browser_take_screenshot",
]);

type Schema = {
  type?: string;
  enum?: readonly string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
};
/** The pinned supported surface has plain JSON types only. Fail on schema drift,
 * never translate an unknown upstream schema into a permissive public tool. */
export function nativeToolInputSchema(schema: Schema): z.ZodType {
  let value: z.ZodType;
  if (schema.enum) value = z.enum(schema.enum as [string, ...string[]]);
  else if (schema.type === "string") value = z.string().max(20_000);
  else if (schema.type === "number")
    value = z
      .number()
      .min(schema.minimum ?? -Number.MAX_SAFE_INTEGER)
      .max(schema.maximum ?? Number.MAX_SAFE_INTEGER);
  else if (schema.type === "boolean") value = z.boolean();
  else if (schema.type === "array" && schema.items)
    value = z.array(nativeToolInputSchema(schema.items)).max(1000);
  else if (schema.type === "object") {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const field = nativeToolInputSchema(child);
      shape[key] = (schema.required ?? []).includes(key) ? field : field.optional();
    }
    value = z.strictObject(shape);
  } else throw new Error("SCRY_BROWSER_TOOL_SCHEMA_UNSUPPORTED");
  if (schema.default !== undefined) value = value.default(schema.default);
  return schema.description ? value.describe(schema.description) : value;
}
