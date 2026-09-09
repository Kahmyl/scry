import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  createBrowserFlowSchema,
  bindBrowserProtectedInputsSchema,
  createBrowserEnvironmentSchema,
  createBrowserProtectedInputSchema,
  createBrowserObjectiveSchema,
  finalizeBrowserRunSchema,
  publishBrowserMissionReportSchema,
  startBrowserMissionSchema,
  startBrowserRunSchema,
  submitBrowserCommandSchema,
  type CreateBrowserFlowInput,
  type BindBrowserProtectedInputsInput,
  type CreateBrowserEnvironmentInput,
  type CreateBrowserProtectedInputInput,
  type CreateBrowserObjectiveInput,
  type FinalizeBrowserRunInput,
  type PublishBrowserMissionReportInput,
  type StartBrowserMissionInput,
  type StartBrowserRunInput,
  type SubmitBrowserCommandInput,
} from "@scry/contracts";

import { CurrentPrincipal } from "../../auth/current-principal.decorator.js";
import { Public } from "../../auth/auth.guard.js";
import type { Principal } from "../../auth/auth.types.js";
import { ZodValidationPipe } from "../../common/validation.pipe.js";
import { BrowserExecutionRepository } from "../repositories/browser-execution.repository.js";
import { BrowserLifecycleRepository } from "../repositories/browser-lifecycle.repository.js";
import { BrowserCommandRepository } from "../repositories/browser-command.repository.js";
import { BrowserExecutionQueueService } from "../browser-execution-queue.service.js";
import { BROWSER_RUNTIME_CAPABILITY_ID } from "../browser-runtime-capability.js";

@Controller("api")
export class BrowserLifecycleController {
  constructor(
    @Inject(BrowserLifecycleRepository) private readonly lifecycle: BrowserLifecycleRepository,
    @Inject(BrowserExecutionRepository) private readonly execution: BrowserExecutionRepository,
    @Inject(BrowserCommandRepository) private readonly commands: BrowserCommandRepository,
    @Inject(BrowserExecutionQueueService) private readonly queue: BrowserExecutionQueueService,
  ) {}

  @Get("health")
  @Public()
  async health() {
    this.enabled();
    await this.execution.assertCompatibleBaseline();
    return { ready: true, capabilityId: BROWSER_RUNTIME_CAPABILITY_ID };
  }

  @Post("missions")
  startMission(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(startBrowserMissionSchema)) input: StartBrowserMissionInput,
  ) {
    this.enabled();
    return this.lifecycle.startMission(workspace(principal), input);
  }

  @Post("projects/:projectId/environments")
  createEnvironment(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(
      new ZodValidationPipe(
        createBrowserEnvironmentSchema.omit({
          projectId: true,
        }),
      ),
    )
    input: Omit<CreateBrowserEnvironmentInput, "projectId">,
  ) {
    this.enabled();
    if (principal.kind === "user" && principal.role === "viewer")
      throw new ForbiddenException("SCRY_BROWSER_ENVIRONMENT_POLICY_FORBIDDEN");
    return this.lifecycle.createEnvironment(workspace(principal), { ...input, projectId });
  }

  @Get("projects/:projectId/environments")
  listEnvironments(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    this.enabled();
    return this.lifecycle.listEnvironments(workspace(principal), projectId);
  }

  @Post("projects/:projectId/protected-inputs")
  createProtectedInput(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createBrowserProtectedInputSchema.omit({ projectId: true })))
    input: Omit<CreateBrowserProtectedInputInput, "projectId">,
  ) {
    this.enabled();
    return this.commands.createProtectedInput(workspace(principal), { ...input, projectId });
  }

  @Get("projects/:projectId/protected-inputs")
  listProtectedInputs(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    this.enabled();
    return this.commands.listProtectedInputs(workspace(principal), projectId);
  }

  @Post("runs/:runId/protected-inputs")
  bindProtectedInputs(
    @Param("runId") runId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(bindBrowserProtectedInputsSchema))
    input: BindBrowserProtectedInputsInput,
  ) {
    this.enabled();
    return this.commands.bindProtectedInputs(workspace(principal), runId, input.protectedInputIds);
  }

  @Post("browser-sessions/:sessionId/commands")
  async submitCommand(
    @Param("sessionId") sessionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(submitBrowserCommandSchema)) input: SubmitBrowserCommandInput,
  ) {
    this.enabled();
    await this.commands.assertSessionAccess(sessionId, workspace(principal));
    const result = await this.commands.submit(sessionId, input);
    await this.queue.dispatchPendingCommands();
    return result;
  }

  @Get("browser-commands/:commandId")
  async getCommand(
    @Param("commandId") commandId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    this.enabled();
    const result = (await this.commands.observe(commandId)) as unknown as { sessionId: string };
    await this.commands.assertSessionAccess(result.sessionId, workspace(principal));
    return result;
  }

  @Get("missions/:missionId")
  getMission(@Param("missionId") missionId: string, @CurrentPrincipal() principal: Principal) {
    this.enabled();
    return this.lifecycle.observeMission(workspace(principal), missionId);
  }

  @Get("projects/:projectId/missions")
  listMissions(@Param("projectId") projectId: string, @CurrentPrincipal() principal: Principal) {
    this.enabled();
    return this.lifecycle.listMissions(workspace(principal), projectId);
  }

  @Post("missions/:missionId/objectives")
  createObjective(
    @Param("missionId") missionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createBrowserObjectiveSchema))
    input: CreateBrowserObjectiveInput,
  ) {
    this.enabled();
    return this.lifecycle.createObjective(workspace(principal), missionId, input);
  }

  @Post("missions/:missionId/flows")
  createFlow(
    @Param("missionId") missionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createBrowserFlowSchema)) input: CreateBrowserFlowInput,
  ) {
    this.enabled();
    return this.lifecycle.createFlow(workspace(principal), missionId, input);
  }

  @Post("runs")
  startRun(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(startBrowserRunSchema)) input: StartBrowserRunInput,
  ) {
    this.enabled();
    return this.lifecycle.startRun(workspace(principal), input);
  }

  @Post("runs/:runId/finalize")
  async finalizeRun(
    @Param("runId") runId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(finalizeBrowserRunSchema)) input: FinalizeBrowserRunInput,
  ) {
    this.enabled();
    const session = await this.lifecycle.executionSessionForRun(workspace(principal), runId);
    const failureFinalization = input.outcome !== "passed";
    if (!(await this.commands.evidenceComplete(session.id))) {
      const submitted = await this.commands.submit(session.id, {
        idempotencyKey: `finalize-close-${randomUUID()}`,
        command: { kind: failureFinalization ? "close_for_failure" : "close" },
      });
      await this.queue.dispatchPendingCommands();
      const closed = await waitForCommand(this.commands, submitted.commandId, 30_000);
      if (!closed || closed.state !== "completed") {
        throw new ConflictException({
          code: closed?.errorCode ?? "SCRY_BROWSER_FINALIZATION_CLOSE_TIMEOUT",
          status: 409,
          safeActions: ["Resolve the reported pending effect or capture, then retry finalization."],
        });
      }
    }
    try {
      if (failureFinalization)
        await this.execution.finalizeFailedSession(session.id, input.ownerGeneration);
      else await this.execution.finalizeSession(session.id, input.ownerGeneration);
    } catch (error) {
      const code = safeBrowserCode(error);
      throw new ConflictException({ code, status: 409, safeActions: [] });
    }
    return this.lifecycle.markRunTerminal(
      workspace(principal),
      runId,
      input.outcome,
      input.conclusion,
    );
  }

  @Post("missions/:missionId/report")
  publishReport(
    @Param("missionId") missionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(publishBrowserMissionReportSchema))
    input: PublishBrowserMissionReportInput,
  ) {
    this.enabled();
    return this.lifecycle.publishReport(workspace(principal), missionId, input);
  }

  private enabled(): void {
    if (process.env.SCRY_BROWSER_ENABLED !== "true")
      throw new ServiceUnavailableException("SCRY_BROWSER_DISABLED");
  }
}

function workspace(principal: Principal): string | undefined {
  return principal.kind === "user" ? principal.workspaceId : undefined;
}

async function waitForCommand(
  commands: BrowserCommandRepository,
  commandId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const command = (await commands.observe(commandId)) as {
      state: string;
      errorCode?: string | null;
    };
    if (command.state === "completed" || command.state === "failed") return command;
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return undefined;
}

function safeBrowserCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return /^SCRY_BROWSER_[A-Z0-9_]+(?::[A-Za-z0-9,_-]+)?$/u.test(raw)
    ? raw
    : "SCRY_BROWSER_FINALIZATION_FAILED";
}
