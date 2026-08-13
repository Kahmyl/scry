import { z } from "zod";

export const externalResourcePresentationAuthoritySchema = z
  .object({
    provider: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
    resourceKind: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
    resourceScope: z.string().trim().min(1).max(500),
    resourceCollection: z.string().trim().min(1).max(500),
    semanticField: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/),
    classification: z.literal("internal_non_secret"),
    permittedPurpose: z.literal("browser_presentation_identity"),
    browserBoundaryKind: z.enum(["dialog", "form", "section", "field_group", "table", "row", "region"]),
    contractVersion: z.number().int().min(1).max(1_000),
    revision: z.number().int().min(1).max(1_000_000),
    status: z.enum(["active", "revoked"]),
  })
  .strict();

export const executionPolicySchema = z
  .object({
    allowedOrigins: z
      .array(
        z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return ["http:", "https:"].includes(url.protocol) && value === url.origin;
          }, "allowed origins must be canonical HTTP(S) origins without a trailing slash"),
      )
      .min(1)
      .max(20),
    trustedScriptOrigins: z
      .array(
        z.string().url().transform((value, context) => {
          const url = new URL(value);
          if (!["http:", "https:"].includes(url.protocol) || value !== url.origin) {
            context.addIssue({ code: "custom", message: "trusted script origins must be canonical HTTP(S) origins" });
            return z.NEVER;
          }
          return value;
        }),
      )
      .max(20)
      .optional(),
    allowPrivateNetwork: z.boolean().default(false),
    allowDownloads: z.literal(false).default(false),
    allowPopups: z.literal(false).default(false),
    maxActions: z.number().int().min(1).max(500).default(100),
    maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(120_000),
    maxNavigations: z.number().int().min(1).max(50).default(10),
    externalResourcePresentationAuthorities: z
      .array(externalResourcePresentationAuthoritySchema)
      .max(50)
      .optional()
      .superRefine((authorities, context) => {
        const keys = new Set<string>();
        for (const [index, authority] of (authorities ?? []).entries()) {
          const key = [authority.provider, authority.resourceKind, authority.resourceScope,
            authority.contractVersion, authority.revision].join("\u0000");
          if (keys.has(key)) context.addIssue({
            code: "custom", path: [index], message: "presentation authority revisions must be unique",
          });
          keys.add(key);
        }
      }),
  })
  .strict();

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
