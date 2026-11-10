import { z } from "zod";

export const createTestResourceSchema = z.strictObject({
  kind: z.enum(["mailbox", "webhook"]),
  name: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().min(8).max(200),
  expiresInSeconds: z.number().int().min(300).max(604800).default(86400),
});
export const refreshTestResourceSchema = z.strictObject({
  refresh: z
    .boolean()
    .optional()
    .describe(
      "False reads captured observations immediately without a provider request. Omit or true to look for new receipts.",
    ),
  waitSeconds: z.number().int().min(0).max(15).default(0),
  afterEventId: z.string().uuid().optional(),
});
export const useTestSecretSchema = z.strictObject({
  runId: z.string().uuid(),
  protectedValueId: z.string().uuid(),
});
export type CreateTestResourceInput = z.infer<typeof createTestResourceSchema>;
export const connectTestMailboxSchema = createTestResourceSchema.omit({ kind: true }).extend({
  address: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  passwordCredentialId: z.uuid(),
});
export type ConnectTestMailboxInput = z.infer<typeof connectTestMailboxSchema>;
export type RefreshTestResourceInput = z.infer<typeof refreshTestResourceSchema>;

export interface TestResource {
  id: string;
  missionId: string;
  kind: "mailbox" | "webhook";
  provider: "mail_tm" | "hookdeck";
  ownership: "scry" | "customer";
  connection?: { address: string; passwordCredentialId: string };
  name: string;
  idempotencyKey: string;
  expiresInSeconds: number;
  state: "pending" | "ready" | "closing" | "closed";
  address: string | null;
  createdAt: string;
  expiresAt: string;
}
export interface TestEvent {
  id: string;
  resourceId: string;
  receivedAt: string;
  title: string;
  content: unknown;
  secrets: Array<{ kind: "code" | "link"; protectedValueId: string }>;
}
