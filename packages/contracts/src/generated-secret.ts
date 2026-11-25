import { z } from "zod";
export const generatedSecretUseSchema = z.enum([
  "browser_fill",
  "scoped_request",
  "hmac_verification",
]);
export type GeneratedSecretUse = z.infer<typeof generatedSecretUseSchema>;
export const captureGeneratedSecretSchema = z.strictObject({
  sourceOrigin: z
    .url()
    .max(4000)
    .refine((value) => /^https?:\/\//.test(value) && new URL(value).origin === value),
  target: z.union([
    z.strictObject({
      ref: z
        .string()
        .regex(/^(f\d+)?e\d+$/)
        .max(64),
    }),
    z.strictObject({ selector: z.string().min(1).max(500) }),
  ]),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\u0000-\u001f\u007f]*$/),
  permittedUses: z
    .array(generatedSecretUseSchema)
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length),
  expiresInSeconds: z.number().int().min(60).max(86400).default(3600),
  trimWhitespace: z.boolean().default(false),
  userConfirmed: z.literal(true),
});
export type CaptureGeneratedSecret = z.infer<typeof captureGeneratedSecretSchema>;
export type NativeSecretCaptureRequest = Readonly<{
  publicKey: string;
  context: string;
  expiresAt: number;
}>;
export const sealedNativeSecretSchema = z.strictObject({
  version: z.literal(1),
  publicKey: z.string().max(100),
  nonce: z.string().max(24),
  tag: z.string().max(32),
  ciphertext: z.string().min(1).max(12000),
});
export type SealedNativeSecret = z.infer<typeof sealedNativeSecretSchema>;
export type GeneratedSecretMetadata = {
  protectedValueId: string;
  displayName: string;
  state: "active" | "revoked" | "expired" | "compromised" | "deleted";
  sourceOrigin: string;
  sourceRunId: string;
  sourceCommandId: string;
  environmentId: string;
  sourceOwnerGeneration: number;
  permittedUses: GeneratedSecretUse[];
  expiresAt: string;
};
export type AdmittedGeneratedSecret = {
  metadata: GeneratedSecretMetadata;
  encrypted: {
    ciphertext: Buffer;
    nonce: Buffer;
    authenticationTag: Buffer;
    valueDigest: string;
    keyId: string;
  };
};
export interface NativeSecretCaptureAdmission {
  readonly request: NativeSecretCaptureRequest;
  accept(value: unknown): AdmittedGeneratedSecret;
  dispose(): void;
}
export const verifyTestWebhookSignatureSchema = z.strictObject({
  idempotencyKey: z.string().min(8).max(200),
  eventId: z.uuid(),
  runId: z.uuid(),
  protectedValueId: z.uuid(),
  signatureHeader: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  encoding: z.enum(["hex", "base64"]).default("hex"),
  prefix: z.enum(["", "sha256="]).default(""),
  timestampHeader: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,100}$/)
    .optional(),
  userConfirmed: z.literal(true),
});
