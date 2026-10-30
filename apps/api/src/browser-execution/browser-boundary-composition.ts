import { Injectable } from "@nestjs/common";
import type { BrowserCommand } from "@scry/contracts";
import { PraxisExecutionPort } from "@scry/contracts";
import { VeilReportProtection } from "@scry/veil";
import { BrowserReplayRenderer } from "@scry/browser-runtime";
import { ChronicleEvidenceService } from "@scry/chronicle";

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
  return new BrowserWorkerPraxisAdapter(
    new BrowserWorkerEngine(
      commands,
      effects,
      new ChronicleEvidenceService(new BrowserReplayRenderer()),
    ),
  );
}

@Injectable()
export class BrowserRuntimeVeilReportProtection extends VeilReportProtection {}
