import { Injectable } from "@nestjs/common";
import type { BrowserCommand, PraxisCommandOptions } from "@scry/contracts";
import { PraxisExecutionPort } from "@scry/contracts";
import { VeilReportProtection, VeilBrowserProtection } from "@scry/veil";
import { BrowserReplayRenderer, PraxisBrowserEngine } from "@scry/praxis";
import { ChronicleEvidenceService } from "@scry/chronicle";

import { BrowserCommandRepository } from "./repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "./repositories/browser-execution.repository.js";
import { commandExecutionBudgetMs } from "./command-budget.js";

class BrowserWorkerPraxisAdapter extends PraxisExecutionPort {
  constructor(private readonly engine: PraxisBrowserEngine) {
    super();
  }

  openSession(sessionId: string) {
    return this.engine.open(sessionId);
  }

  executeCommand(sessionId: string, command: BrowserCommand, options?: PraxisCommandOptions) {
    return this.engine.execute(sessionId, command, options);
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
    new PraxisBrowserEngine(
      commands,
      effects,
      new ChronicleEvidenceService(new BrowserReplayRenderer()),
      new VeilBrowserProtection(),
      commandExecutionBudgetMs,
    ),
  );
}

@Injectable()
export class BrowserRuntimeVeilReportProtection extends VeilReportProtection {}
