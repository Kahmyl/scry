import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type {
  AdvanceAuthoringTurnCommand,
  CreateAuthoringRuntimeCommandInput,
} from "@scry/contracts";

import type { Principal } from "../auth/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";
import { AuthoringRuntimeCommandRepository } from "./repositories/authoring-runtime-command.repository.js";

@Injectable()
export class AuthoringRuntimeCommandService {
  constructor(
    @Inject(AuthoringRuntimeCommandRepository)
    private readonly commands: AuthoringRuntimeCommandRepository,
    @Inject(ReleaseAdmissionService)
    private readonly admission: ReleaseAdmissionService,
  ) {}

  async enqueue(
    principal: Principal,
    probeSessionId: string,
    input: CreateAuthoringRuntimeCommandInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    if (input.type !== "advance_turn") {
      process.stdout.write(
        `${JSON.stringify({
          event: "authoring.compatibility_command_used",
          commandType: input.type,
          probeSessionId,
        })}\n`,
      );
    }

    try {
      return await this.commands.enqueue({
        probeSessionId,
        missionId: input.missionId,
        agentSessionId: input.agentSessionId,
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "AUTHORING_RUNTIME_NOT_ACTIVE") {
          throw new ConflictException({
            code: "AUTHORING_RUNTIME_NOT_ACTIVE",
          });
        }

        if (error.message === "AUTHORING_COMMAND_IDEMPOTENCY_CONFLICT") {
          throw new ConflictException({
            code: "AUTHORING_COMMAND_IDEMPOTENCY_CONFLICT",
          });
        }
      }

      throw error;
    }
  }

  async advance(principal: Principal, probeSessionId: string, input: AdvanceAuthoringTurnCommand) {
    const command = await this.enqueue(principal, probeSessionId, {
      missionId: input.missionId,
      agentSessionId: input.agentSessionId,
      type: "advance_turn",
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
    });
    const deadline = Date.now() + input.payload.budgets.maxDurationMs + 15_000;
    while (Date.now() < deadline) {
      const result = await this.commands.result(command.id);
      if (!result) throw new ConflictException({ code: "AUTHORING_TURN_COMMAND_LOST" });
      if (result.state === "completed") return result.safeResult;
      if (result.state === "failed" || result.state === "cancelled") {
        throw new ConflictException(result.safeError ?? { code: "AUTHORING_TURN_FAILED" });
      }
      await delay(100);
    }
    throw new ConflictException({
      code: "AUTHORING_TURN_DEADLINE_EXCEEDED",
      commandId: command.id,
      safeActions: ["retry_same_idempotency_key"],
    });
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Write access required");
    }
  }
}

function delay(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
