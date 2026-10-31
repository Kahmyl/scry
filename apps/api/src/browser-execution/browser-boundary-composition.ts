import { Injectable } from "@nestjs/common";
import type {
  BrowserCommand,
  PraxisCommandOptions,
  PraxisRuntimeOptions,
  PraxisSessionScope,
} from "@scry/contracts";
import { PraxisExecutionPort } from "@scry/contracts";
import { VeilReportProtection, VeilBrowserProtection } from "@scry/veil";
import { BrowserReplayRenderer, PraxisBrowserEngine, PraxisMcpBrowserEngine } from "@scry/praxis";
import { ChronicleEvidenceService } from "@scry/chronicle";

import { BrowserCommandRepository } from "./repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "./repositories/browser-execution.repository.js";
import { commandExecutionBudgetMs } from "./command-budget.js";

class BrowserWorkerPraxisAdapter extends PraxisExecutionPort {
  constructor(
    private readonly engine: PraxisBrowserEngine,
    private readonly native: PraxisMcpBrowserEngine,
    private readonly commands: BrowserCommandRepository,
  ) {
    super();
  }

  private async selected(sessionId: string) {
    return (await this.commands.sessionContext(sessionId)).runtimeAdapter === "playwright_mcp"
      ? this.native
      : this.engine;
  }

  async openSession(sessionId: string) {
    return (await this.selected(sessionId)).open(sessionId);
  }

  async executeCommand(sessionId: string, command: BrowserCommand, options?: PraxisCommandOptions) {
    return (await this.selected(sessionId)).execute(sessionId, command, options);
  }

  async shutdown() {
    await Promise.all([this.engine.closeAll(), this.native.closeAll()]);
  }
}

export function composePraxisExecutionPort(
  commands: BrowserCommandRepository,
  effects: BrowserExecutionRepository,
  runtimeOptions: PraxisRuntimeOptions = {},
): PraxisExecutionPort {
  return new BrowserWorkerPraxisAdapter(
    new PraxisBrowserEngine(
      commands,
      effects,
      new ChronicleEvidenceService(new BrowserReplayRenderer()),
      new VeilBrowserProtection(),
      commandExecutionBudgetMs,
      runtimeOptions,
    ),
    new PraxisMcpBrowserEngine(
      commands,
      effects,
      new ChronicleEvidenceService(new BrowserReplayRenderer()),
      new VeilBrowserProtection(),
      new URL("./native-browser-adapter-worker.ts", import.meta.url).href,
      runtimeOptions,
    ),
    commands,
  );
}

@Injectable()
export class BrowserRuntimeVeilReportProtection extends VeilReportProtection {}

export function readBrowserEvidenceProtection(
  scope: Pick<PraxisSessionScope, "runId" | "sessionId" | "protectionKeyId">,
) {
  return new VeilBrowserProtection().readEvidence(scope);
}
