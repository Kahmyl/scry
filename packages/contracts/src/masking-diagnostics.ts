import { z } from "zod";
export const maskingDiagnosticSchema = z.strictObject({
  pageId: z.uuid(),
  at: z.number().int().nonnegative(),
  state: z.enum(["degraded", "recovered", "page_closed"]),
  reason: z.enum([
    "installation_pending",
    "installation_failed",
    "maintenance_timeout",
    "maintenance_failed",
    "dialog_refresh_deferred",
    "refresh_confirmed",
    "page_closed",
  ]),
});
export const maskingDiagnosticsSchema = z.strictObject({
  events: z.array(maskingDiagnosticSchema).max(256),
  truncated: z.boolean(),
});
export type MaskingDiagnostic = z.infer<typeof maskingDiagnosticSchema>;
