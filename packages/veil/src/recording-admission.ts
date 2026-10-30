import type { RecordingProtectionPort } from "@scry/contracts";
import { SensitiveValueClassifier } from "./classifier.js";
import { ProtectionAuthority } from "./protection-authority.js";
import { sanitizeReplayValue } from "./sanitizer.js";

export function createRecordingProtection(options: {
  classifier?: SensitiveValueClassifier;
  authority?: ProtectionAuthority;
}): RecordingProtectionPort {
  const classifier = options.classifier ?? new SensitiveValueClassifier();
  return {
    snapshot() {
      const forceQuarantine = options.authority?.hasActiveBarrier ?? false;
      return (value) =>
        sanitizeReplayValue(value, {
          sanitize: (input) =>
            options.authority
              ? options.authority.sanitize(input, "recording", forceQuarantine)
              : classifier.sanitize(input),
        });
    },
  };
}
