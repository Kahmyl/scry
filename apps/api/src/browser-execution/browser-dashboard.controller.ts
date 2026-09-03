import { Controller, Get, Inject, Param } from "@nestjs/common";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/auth.types.js";
import { BrowserDashboardRepository } from "./browser-dashboard.repository.js";

@Controller("api/v2")
export class BrowserDashboardController {
  constructor(
    @Inject(BrowserDashboardRepository) private readonly dashboard: BrowserDashboardRepository,
  ) {}

  @Get("projects/:projectId/runs")
  listRuns(@Param("projectId") projectId: string, @CurrentPrincipal() principal: Principal) {
    return this.dashboard.listRuns(workspace(principal), projectId);
  }

  @Get("runs/:runId")
  getRun(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return this.dashboard.getRun(workspace(principal), runId);
  }

  @Get("projects/:projectId/reports")
  listReports(@Param("projectId") projectId: string, @CurrentPrincipal() principal: Principal) {
    return this.dashboard.listReports(workspace(principal), projectId);
  }

  @Get("reports/:reportId")
  getReport(@Param("reportId") reportId: string, @CurrentPrincipal() principal: Principal) {
    return this.dashboard.getReport(workspace(principal), reportId);
  }
}

function workspace(principal: Principal): string | undefined {
  return principal.kind === "user" ? principal.workspaceId : undefined;
}
