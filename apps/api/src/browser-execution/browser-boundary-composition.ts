import { Injectable } from "@nestjs/common";
import type {
  BrowserCommand,
  BrowserProtectionSink,
  VeilReportSanitizer,
  VeilReportSanitizerInput,
} from "@scry/contracts";
import { PraxisExecutionPort, VeilReportProtectionPort } from "@scry/contracts";
import { ProtectionAuthority } from "@scry/browser-runtime";

import { BrowserWorkerEngine } from "./browser-worker-engine.js";
import { BrowserCommandRepository } from "./repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "./repositories/browser-execution.repository.js";

class BrowserWorkerPraxisAdapter extends PraxisExecutionPort {
  constructor(private readonly engine: BrowserWorkerEngine) {
    super();
  }

  openSession(sessionId: string) {
    return this.engine.open(sessionId);
  }

  executeCommand(sessionId: string, command: BrowserCommand) {
    return this.engine.execute(sessionId, command);
  }

  shutdown() {
    return this.engine.closeAll();
  }
}

export function composePraxisExecutionPort(
  commands: BrowserCommandRepository,
  effects: BrowserExecutionRepository,
): PraxisExecutionPort {
  return new BrowserWorkerPraxisAdapter(new BrowserWorkerEngine(commands, effects));
}

@Injectable()
export class BrowserRuntimeVeilReportProtection extends VeilReportProtectionPort {
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
      sanitizeText(value: string, sink: BrowserProtectionSink) {
        return authority.sanitize(value, sink);
      },
      sanitizeValue(value: unknown, sink: BrowserProtectionSink) {
        return authority.sanitizeValue(value, "", sink);
      },
    };
  }
}
