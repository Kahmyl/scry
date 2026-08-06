import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type {
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

        if (
          error.message ===
          "AUTHORING_COMMAND_IDEMPOTENCY_CONFLICT"
        ) {
          throw new ConflictException({
            code: "AUTHORING_COMMAND_IDEMPOTENCY_CONFLICT",
          });
        }
      }

      throw error;
    }
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Write access required");
    }
  }
}
