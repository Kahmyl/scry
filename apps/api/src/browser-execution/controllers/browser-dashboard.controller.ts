import {
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  StreamableFile,
  Header,
  ForbiddenException,
} from "@nestjs/common";

import { CurrentPrincipal } from "../../auth/current-principal.decorator.js";
import type { Principal } from "../../auth/auth.types.js";
import { BrowserDashboardRepository } from "../repositories/browser-dashboard.repository.js";
import { BrowserLifecycleRepository } from "../repositories/browser-lifecycle.repository.js";
import { customerMission, customerReport, customerRun } from "../customer-reporting.js";

@Controller("api")
export class BrowserDashboardController {
  constructor(
    @Inject(BrowserDashboardRepository) private readonly dashboard: BrowserDashboardRepository,
    @Inject(BrowserLifecycleRepository) private readonly lifecycle: BrowserLifecycleRepository,
  ) {}

  @Get("projects/:projectId/runs")
  async listRuns(@Param("projectId") projectId: string, @CurrentPrincipal() principal: Principal) {
    return (await this.dashboard.listRuns(workspace(principal), projectId)).map(customerRun);
  }

  @Get("runs/:runId")
  async getRun(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return customerRun(await this.dashboard.getRun(workspace(principal), runId));
  }

  @Get("dashboard/missions/:missionId")
  async getCustomerMission(
    @Param("missionId") missionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return customerMission(await this.lifecycle.observeMission(workspace(principal), missionId));
  }

  @Get("runs/:runId/media")
  @Header("Cache-Control", "private, no-store")
  listMedia(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return this.dashboard.listMedia(workspace(principal), runId);
  }

  @Get("runs/:runId/media/:index")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  async getMedia(
    @Param("runId") runId: string,
    @Param("index", ParseIntPipe) index: number,
    @CurrentPrincipal() principal: Principal,
  ) {
    const media = await this.dashboard.getMedia(workspace(principal), runId, index);
    return new StreamableFile(media.bytes, { type: media.type, disposition: "inline" });
  }

  @Get("projects/:projectId/reports")
  async listReports(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return (await this.dashboard.listReports(workspace(principal), projectId)).map(customerReport);
  }

  @Get("reports/:reportId")
  async getReport(@Param("reportId") reportId: string, @CurrentPrincipal() principal: Principal) {
    return customerReport(await this.dashboard.getReport(workspace(principal), reportId));
  }

  @Get("operator/reports/:reportId")
  @Header("Cache-Control", "private, no-store")
  getOperatorReport(@Param("reportId") reportId: string, @CurrentPrincipal() principal: Principal) {
    requireOperator(principal);
    return this.dashboard.getReport(undefined, reportId);
  }

  @Get("operator/runs/:runId")
  @Header("Cache-Control", "private, no-store")
  getOperatorRun(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    requireOperator(principal);
    return this.dashboard.getRun(undefined, runId);
  }
}

function requireOperator(principal: Principal) {
  // Customer workspace owners/admins and customer MCP tokens are not Scry operators.
  if (principal.kind !== "service") throw new ForbiddenException("Operator access required");
}

function workspace(principal: Principal): string | undefined {
  return principal.kind === "user" ? principal.workspaceId : undefined;
}
