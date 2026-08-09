import { z } from "zod";

const uuid = z.string().uuid();
const timeout = z.number().int().min(100).max(60_000).optional();
const text = z.string().trim().min(1).max(500);

export const directLocatorSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.enum(["button", "checkbox", "combobox", "definition", "dialog", "heading", "link", "listbox", "menuitem", "option", "radio", "tab", "textbox"]), name: text.optional(), exact: z.boolean().default(true), scope: z.enum(["page", "dialog"]).optional() }).strict(),
  z.object({ strategy: z.literal("label"), value: text, exact: z.boolean().default(true), scope: z.enum(["page", "dialog"]).optional() }).strict(),
  z.object({ strategy: z.literal("placeholder"), value: text, exact: z.boolean().default(true), scope: z.enum(["page", "dialog"]).optional() }).strict(),
  z.object({ strategy: z.literal("text"), value: text, exact: z.boolean().default(true), scope: z.enum(["page", "dialog"]).optional() }).strict(),
  z.object({ strategy: z.literal("testId"), value: text, scope: z.enum(["page", "dialog"]).optional() }).strict(),
  z.object({ strategy: z.literal("rowAction"), rowText: text, role: z.enum(["button", "link"]), name: text, exact: z.boolean().default(true) }).strict(),
  z.object({ strategy: z.literal("credentialField"), value: z.enum(["client-id", "client-secret"]) }).strict(),
  z.object({ strategy: z.literal("sectionRole"), sectionHeading: text, role: z.enum(["button", "checkbox", "combobox", "link", "option", "radio", "tab", "textbox"]), name: text.optional(), exact: z.boolean().default(true) }).strict(),
  z.object({ strategy: z.literal("sectionLabel"), sectionHeading: text, value: text, exact: z.boolean().default(true) }).strict(),
  z.object({ strategy: z.literal("sectionLiveRegion"), sectionHeading: text }).strict(),
  z.object({ strategy: z.literal("sectionResponse"), sectionHeading: text }).strict(),
]);

const targeted = { target: directLocatorSchema, timeoutMs: timeout };
export const directActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url(), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("click"), ...targeted }).strict(),
  z.object({ type: z.literal("fillPublic"), ...targeted, value: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal("fillCredential"), ...targeted, credentialId: uuid }).strict(),
  z.object({ type: z.literal("clickAndCaptureCredential"), target: directLocatorSchema, captureTarget: directLocatorSchema, credentialName: z.string().trim().min(1).max(120), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("select"), ...targeted, value: text }).strict(),
  z.object({ type: z.literal("check"), ...targeted, checked: z.boolean() }).strict(),
  z.object({ type: z.literal("press"), target: directLocatorSchema.optional(), key: z.enum(["Enter", "Escape", "Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("waitForElement"), ...targeted, state: z.enum(["visible", "hidden", "attached", "detached"]) }).strict(),
  z.object({ type: z.literal("waitForUrl"), value: z.string().trim().min(1).max(2_048), match: z.enum(["exact", "path", "contains"]).default("path"), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("inspectSection"), heading: text, maxCharacters: z.number().int().min(100).max(8_000).default(4_000) }).strict(),
  z.object({ type: z.literal("waitForText"), ...targeted, value: text, match: z.enum(["exact", "contains"]).default("contains") }).strict(),
  z.object({ type: z.literal("inspectTarget"), target: directLocatorSchema, maxCharacters: z.number().int().min(100).max(8_000).default(4_000) }).strict(),
]);

export const startDirectSessionSchema = z.object({
  projectId: uuid,
  environmentId: uuid,
  startUrl: z.string().url().optional(),
  additionalOrigins: z.array(z.string().url()).max(5).default([]),
}).strict();

export const executeDirectTurnSchema = z.object({
  actions: z.array(directActionSchema).min(1).max(10),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(60_000),
}).strict();

export type DirectLocator = z.infer<typeof directLocatorSchema>;
export type DirectAction = z.infer<typeof directActionSchema>;
export type StartDirectSessionInput = z.infer<typeof startDirectSessionSchema>;
export type ExecuteDirectTurnInput = z.infer<typeof executeDirectTurnSchema>;
