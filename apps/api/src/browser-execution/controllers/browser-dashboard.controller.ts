import {
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  StreamableFile,
  Header,
} from "@nestjs/common";

import { CurrentPrincipal } from "../../auth/current-principal.decorator.js";
import type { Principal } from "../../auth/auth.types.js";
import { BrowserDashboardRepository } from "../repositories/browser-dashboard.repository.js";

@Controller("api")
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
