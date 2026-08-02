import { z } from "zod";

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
    allowPrivateNetwork: z.boolean().default(false),
    allowDownloads: z.literal(false).default(false),
    allowPopups: z.literal(false).default(false),
    maxActions: z.number().int().min(1).max(500).default(100),
    maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(120_000),
    maxNavigations: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
