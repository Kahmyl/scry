import { z } from "zod";
import { playwrightToolDefinitions } from "./playwright-tool-definitions.js";
import { nativeCapabilitySchemas } from "./native-capabilities.js";

export { playwrightToolDefinitions };
export const nativeBrowserTools = new Set(playwrightToolDefinitions.map((t) => t.name));
/** Scry intent, layered on native input. No application-specific strategy table. */
export const editBrowserTextSchema = z.strictObject({
  target: z
    .string()
    .regex(/^(f\d+)?e\d+$/)
    .describe("Current element reference from browser_snapshot or browser_find."),
  text: z.string().max(20_000),
  intent: z.enum(["replace", "insert"]),
  method: z
    .enum(["paste", "keyboard"])
    .describe(
      "Paste preserves exact multiline text in most editors; keyboard exercises key handlers. No automatic fallback is performed.",
    ),
});
export const screenshotPresentationSchema = z.object({
  evidenceTitle: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
    .optional()
    .describe("Plain-English title describing the state this screenshot proves."),
  evidenceDescription: z
    .string()
    .trim()
    .max(2000)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/)
    .optional()
    .describe(
      "What the reviewer should notice; do not include access secrets or financial details.",
    ),
});
export const browserToolCommandSchema = z.object({
  kind: z.literal("browser_tool"),
  tool: z
    .string()
    .refine(
      (name) =>
        nativeBrowserTools.has(name as never) ||
        [
          "browser_type_secret",
          "browser_navigate_secret",
          "browser_edit_text",
          "browser_sequence",
          ...Object.keys(nativeCapabilitySchemas),
        ].includes(name),
    ),
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
  "browser_list_downloads",
  "browser_verify_download",
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

/** One validated public schema for the native adapter and Scry additions. */
export function nativeBrowserToolSchema(name: string): z.ZodObject {
  if (Object.hasOwn(nativeCapabilitySchemas, name))
    return nativeCapabilitySchemas[name as keyof typeof nativeCapabilitySchemas];
  if (name === "browser_sequence") return browserSequenceInputSchema;
  if (name === "browser_edit_text") return editBrowserTextSchema;
  const definition = playwrightToolDefinitions.find((d) => d.name === name);
  if (!definition) throw Error("SCRY_BROWSER_TOOL_SCHEMA_UNSUPPORTED");
  const schema = nativeToolInputSchema(definition.inputSchema) as z.ZodObject;
  return name === "browser_take_screenshot"
    ? schema.extend(screenshotPresentationSchema.shape)
    : schema;
}

const currentTarget = z
  .string()
  .regex(/^(f\d+)?e\d+$/)
  .max(64);
const knownStep = (tool: string) =>
  z.strictObject({
    tool: z.literal(tool),
    actionId: z.string().min(8).max(128),
    args: nativeBrowserToolSchema(tool).extend({ target: currentTarget }),
  });
export const browserSequenceStepSchema = z.union([
  knownStep("browser_type"),
  knownStep("browser_select_option"),
  knownStep("browser_click"),
  z.strictObject({
    tool: z.literal("browser_type_secret"),
    actionId: z.string().min(8).max(128),
    args: z.strictObject({ target: currentTarget, protectedValueId: z.string().uuid() }),
  }),
  z.strictObject({
    tool: z.literal("browser_press_key"),
    actionId: z.string().min(8).max(128),
    args: z.strictObject({
      target: currentTarget,
      key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"]),
    }),
  }),
]);
export const browserSequenceInputSchema = z
  .strictObject({
    contractVersion: z.literal(1).default(1),
    planId: z.string().min(8).max(128),
    observationId: z
      .string()
      .uuid()
      .describe("Worker-issued observationId from the current snapshot result."),
    steps: z.array(browserSequenceStepSchema).min(1).max(8),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.steps.forEach((s, i) => {
      if (ids.has(s.actionId))
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "actionId"],
          message: "Action identities must be distinct",
        });
      ids.add(s.actionId);
      if (
        i < value.steps.length - 1 &&
        (s.tool === "browser_click" ||
          s.tool === "browser_press_key" ||
          ("submit" in s.args && s.args.submit === true))
      )
        ctx.addIssue({
          code: "custom",
          path: ["steps", i],
          message: "Clicks, keys and submission must end the plan",
        });
    });
    if (new TextEncoder().encode(JSON.stringify(value)).length > 16_384)
      ctx.addIssue({ code: "custom", message: "Plan exceeds the byte limit" });
  });
export type BrowserSequenceInput = z.infer<typeof browserSequenceInputSchema>;
