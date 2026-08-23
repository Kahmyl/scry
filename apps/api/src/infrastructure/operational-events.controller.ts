import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  Body,
} from "@nestjs/common";
import {
  operationalCausalLookupSchema,
  operationalEventQuerySchema,
  operationalEventSchema,
  operationalExportQuerySchema,
  operationalSummaryQuerySchema,
  parseOperationalEvent,
  type OperationalEvent,
  type OperationalEventQuery,
} from "@scry/observability";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/auth.types.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { OperationalEventStore } from "./operational-event-store.js";
import { OperationalEvents } from "./operational-events.js";

@Controller("api/operations")
export class OperationalEventsController {
  constructor(
    @Inject(OperationalEvents) private readonly events: OperationalEvents,
    @Inject(OperationalEventStore) private readonly store: OperationalEventStore,
  ) {}

  @Post("events/ingest")
  async ingest(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(operationalEventSchema)) event: OperationalEvent,
  ) {
    requireService(principal);
    try {
      await this.events.ingest(parseOperationalEvent(event));
    } catch (error) {
      throw new BadRequestException({
        code: "OPERATIONAL_EVENT_INGESTION_REJECTED",
        message: error instanceof Error ? error.message : "Operational event is invalid",
      });
    }
    return { accepted: true };
  }

  @Get("events/export")
  async export(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(operationalExportQuerySchema))
    input: {
      format: "json" | "jsonl";
      limit: number;
    } & Omit<OperationalEventQuery, "cursor" | "limit">,
    @Res({ passthrough: true }) response: { header(name: string, value: string): void },
  ) {
    const scope = operatorScope(principal, input.projectId);
    const page = await this.store.query(scope, input as OperationalEventQuery);
    const body =
      input.format === "jsonl"
        ? `${page.items.map((event) => JSON.stringify(event)).join("\n")}\n`
        : `${JSON.stringify({ exportedAt: new Date().toISOString(), events: page.items }, null, 2)}\n`;
    response.header(
      "Content-Type",
      input.format === "jsonl" ? "application/x-ndjson" : "application/json",
    );
    response.header(
      "Content-Disposition",
      `attachment; filename="scry-operational-events.${input.format}"`,
    );
    return new StreamableFile(Buffer.from(body, "utf8"));
  }

  @Get("events")
  query(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(operationalEventQuerySchema)) input: OperationalEventQuery,
  ) {
    return this.store.query(operatorScope(principal, input.projectId), input);
  }

  @Get("causal/:dimension/:id")
  causal(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(operationalCausalLookupSchema))
    params: {
      dimension: "correlation" | "mission" | "run" | "praxis" | "protected_operation";
      id: string;
    },
    @Query(new ZodValidationPipe(operationalEventQuerySchema)) input: OperationalEventQuery,
  ) {
    const filter = causalFilter(params.dimension, params.id);
    return this.store.query(operatorScope(principal, input.projectId), { ...input, ...filter });
  }

  @Get("summary")
  summary(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(operationalSummaryQuerySchema))
    input: { projectId?: string; windowHours: number },
  ) {
    return this.store.summary(operatorScope(principal, input.projectId), {
      windowHours: input.windowHours,
      reconciliationThresholdMs: configuredThreshold(),
    });
  }
}

function requireService(principal: Principal) {
  if (principal.kind !== "service")
    throw new ForbiddenException("Operational event ingestion requires service authentication");
}

function operatorScope(principal: Principal, projectId?: string) {
  if (principal.kind === "service") return { ...(projectId ? { projectId } : {}) };
  if (principal.role !== "owner" && principal.role !== "admin")
    throw new ForbiddenException("Operational diagnostics require an owner or admin");
  return { workspaceId: principal.workspaceId, ...(projectId ? { projectId } : {}) };
}

function causalFilter(dimension: string, id: string): Partial<OperationalEventQuery> {
  const keys = {
    correlation: "correlationId",
    mission: "missionId",
    run: "runId",
    praxis: "praxisSessionId",
    protected_operation: "protectedOperationId",
  } as const;
  return { [keys[dimension as keyof typeof keys]]: id };
}

function configuredThreshold() {
  const value = Number(process.env.SCRY_RECONCILIATION_ALERT_MS ?? 5 * 60 * 1_000);
  return Number.isSafeInteger(value) && value >= 1_000 ? value : 5 * 60 * 1_000;
}
