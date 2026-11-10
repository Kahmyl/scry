import { z } from "zod";

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/)
  .refine(
    (s) =>
      !/^(?:host|connection|content-length|transfer-encoding|upgrade|proxy-.+|forwarded|x-forwarded-.+|origin|referer)$/i.test(
        s,
      ),
  );
const sensitiveKey =
  /(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|card[-_]?number|cvv)/i;
const publicBody = z.record(z.string(), z.unknown()).superRefine((body, ctx) => {
  const stack: Array<[unknown, number]> = [[body, 0]],
    seen = new Set<object>();
  let count = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (
      ++count > 1024 ||
      depth > 12 ||
      ["undefined", "function", "symbol", "bigint"].includes(typeof v) ||
      (typeof v === "number" && !Number.isFinite(v))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Body must be bounded public JSON; secrets use references",
      });
      return;
    }
    if (v && typeof v === "object") {
      if (seen.has(v)) {
        ctx.addIssue({ code: "custom", message: "Body must not contain cycles" });
        return;
      }
      seen.add(v);
      for (const [key, value] of Object.entries(v)) {
        if (sensitiveKey.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
          ctx.addIssue({
            code: "custom",
            message: "Sensitive body fields require protected bindings",
          });
          return;
        }
        stack.push([value, depth + 1]);
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(body)).length > 32768)
    ctx.addIssue({ code: "custom", message: "Body exceeds limit" });
});
export const scopedRequestSchema = z
  .strictObject({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.url().max(4000),
    headers: z
      .record(
        headerName,
        z
          .string()
          .max(2000)
          .regex(/^[^\r\n\u0000]*$/),
      )
      .default({})
      .refine(
        (h) =>
          !Object.keys(h).some((k) => sensitiveKey.test(k)) &&
          Object.keys(h).length <= 32 &&
          new TextEncoder().encode(JSON.stringify(h)).length <= 8192 &&
          new Set(Object.keys(h).map((k) => k.toLowerCase())).size === Object.keys(h).length,
      ),
    body: publicBody.optional(),
    credentials: z
      .array(
        z.strictObject({
          protectedValueId: z.uuid(),
          header: headerName,
          format: z.enum(["raw", "bearer", "basic"]).default("raw"),
        }),
      )
      .max(8)
      .default([]),
    bodyBindings: z
      .array(
        z.strictObject({
          protectedValueId: z.uuid(),
          path: z
            .array(
              z
                .string()
                .min(1)
                .max(80)
                .refine((k) => !["__proto__", "prototype", "constructor"].includes(k)),
            )
            .min(1)
            .max(6),
        }),
      )
      .max(8)
      .default([]),
    timeoutMs: z.number().int().min(100).max(15000).default(10000),
    maxResponseBytes: z.number().int().min(1).max(65536).default(32768),
  })
  .superRefine((v, ctx) => {
    if (["GET", "HEAD"].includes(v.method) && (v.body || v.bodyBindings.length))
      ctx.addIssue({ code: "custom", message: "GET and HEAD cannot carry a body" });
    const keys = [...Object.keys(v.headers), ...v.credentials.map((c) => c.header)].map((k) =>
      k.toLowerCase(),
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Headers must be unique" });
    const paths = v.bodyBindings.map((b) => JSON.stringify(b.path));
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({ code: "custom", message: "Body bindings must be unique" });
  });
export const listDownloadsSchema = z.strictObject({});
export const verifyDownloadSchema = z.strictObject({
  downloadId: z.uuid(),
  waitSeconds: z.number().int().min(0).max(15).default(2),
  expected: z
    .strictObject({
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      minBytes: z.number().int().nonnegative().default(1),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024)
        .default(16 * 1024 * 1024),
      fileName: z.string().min(1).max(200).optional(),
      format: z.enum(["any", "json", "pdf", "png", "zip"]).default("any"),
    })
    .default({ minBytes: 1, maxBytes: 16 * 1024 * 1024, format: "any" }),
});
export const viewportProfiles = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 720 },
  mobile_landscape: { width: 720, height: 390 },
  tablet: { width: 768, height: 720 },
} as const;
export const setViewportSchema = z.strictObject({
  profile: z.enum(["desktop", "mobile", "mobile_landscape", "tablet"]),
});
export const nativeCapabilitySchemas = {
  browser_scoped_request: scopedRequestSchema,
  browser_list_downloads: listDownloadsSchema,
  browser_verify_download: verifyDownloadSchema,
  browser_set_viewport: setViewportSchema,
};
export type ScopedRequest = z.infer<typeof scopedRequestSchema>;
