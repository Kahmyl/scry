import { Inject, Injectable } from "@nestjs/common";
import type { MissionAuthoringIntent, StartAdaptiveSessionInput } from "@scry/contracts";
import type { Principal } from "../auth/index.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";
import { MissionFlowAuthoringService } from "./mission-flow-authoring.service.js";

/** Production-owned high-level composition for protected Mission qualification. */
@Injectable()
export class MissionProtectedQualificationRunner {
  constructor(
    @Inject(MissionFlowAuthoringService) private readonly authoring: MissionFlowAuthoringService,
    @Inject(AdaptiveSessionRepository) private readonly sessions: AdaptiveSessionRepository,
  ) {}

  async execute(input: {
    principal: Principal;
    session: StartAdaptiveSessionInput;
    preparation: MissionAuthoringIntent[];
    operation: MissionAuthoringIntent;
    disposition: "qualification_only" | "execute";
  }) {
    const started = await this.authoring.start(input.principal, input.session);
    if (input.disposition === "qualification_only")
      await this.sessions.authorizeQualificationOnlySession(started.id);
    const preparation = await this.authoring.advance(input.principal, started.id, {
      kind: "intents", intents: input.preparation,
      budgets: { maxOperations: input.preparation.length, maxDurationMs: 60_000 },
      idempotencyKey: `${input.session.idempotencyKey}:preparation`,
    });
    if (preparation.state !== "completed") return { sessionId: started.id, stage: "preparation", result: preparation };
    const key = `${input.session.idempotencyKey}:protected`;
    let result = await this.authoring.advance(input.principal, started.id, {
      kind: "intents", intents: [input.operation], budgets: { maxOperations: 1, maxDurationMs: 60_000 }, idempotencyKey: key,
    });
    for (let attempt = 0; result.state === "pending" && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await this.authoring.advance(input.principal, started.id, {
        kind: "continue", turnId: result.turnId,
        budgets: { maxOperations: 1, maxDurationMs: 60_000 },
        idempotencyKey: `${key}:continue:${attempt + 1}`,
      });
    }
    return { sessionId: started.id, stage: "protected", result };
  }
}
