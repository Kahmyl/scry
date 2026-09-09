import { z } from "zod";

import type { BrowserCommand } from "./browser-command.js";
import type { BrowserProtectionSink } from "./browser-execution.js";

export const praxisSessionReceiptSchema = z.object({
  sessionId: z.string().uuid(),
  ownerGeneration: z.number().int().positive(),
});

export type PraxisSessionReceipt = z.infer<typeof praxisSessionReceiptSchema>;

/** Application-facing browser execution capability. */
export abstract class PraxisExecutionPort {
  abstract openSession(sessionId: string): Promise<PraxisSessionReceipt>;
  abstract executeCommand(
    sessionId: string,
    command: BrowserCommand,
  ): Promise<Record<string, unknown>>;
  abstract shutdown(): Promise<void>;
}

export interface VeilReportSanitizer {
  sanitizeText(value: string, sink: BrowserProtectionSink): string;
  sanitizeValue(value: unknown, sink: BrowserProtectionSink): unknown;
}

export interface VeilReportSanitizerInput {
  scope: {
    projectId: string;
    missionId: string;
    runId: string;
    sessionId: string;
    origin: string;
  };
  protectedValues: Readonly<Record<string, string>>;
  restoredPublicValues: readonly {
    value: string;
    allowedSinks: readonly BrowserProtectionSink[];
  }[];
}

/** Report-specific protection capability used by application composition. */
export abstract class VeilReportProtectionPort {
  abstract createReportSanitizer(input: VeilReportSanitizerInput): VeilReportSanitizer;
}
