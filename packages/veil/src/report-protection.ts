import type { VeilReportSanitizer, VeilReportSanitizerInput } from "@scry/contracts";
import { VeilReportProtectionPort } from "@scry/contracts";
import { ProtectionAuthority } from "./protection-authority.js";

export class VeilReportProtection extends VeilReportProtectionPort {
  createReportSanitizer(input: VeilReportSanitizerInput): VeilReportSanitizer {
    const authority = new ProtectionAuthority({
      scope: input.scope,
      protectedValues: { ...input.protectedValues },
      restoredPublicValues: input.restoredPublicValues.map((item) => ({
        value: item.value,
        allowedSinks: [...item.allowedSinks],
      })),
    });
    return {
      sanitizeText: (value, sink) => authority.sanitize(value, sink),
      sanitizeValue: (value, sink) => authority.sanitizeValue(value, "", sink),
    };
  }
}
