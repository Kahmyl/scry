import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  createQualificationCampaignSchema,
  type CreateQualificationCampaignInput,
} from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { QualificationCampaignRepository } from "./repositories/qualification-campaign.repository.js";

@Controller("api")
export class QualificationCampaignController {
  constructor(
    @Inject(QualificationCampaignRepository)
    private readonly campaigns: QualificationCampaignRepository,
  ) {}

  @Post("projects/:projectId/qualification-campaigns")
  create(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createQualificationCampaignSchema))
    input: CreateQualificationCampaignInput,
  ) {
    return this.campaigns.create(principal, projectId, input);
  }

  @Get("qualification-campaigns/:campaignId")
  get(@Param("campaignId") campaignId: string, @CurrentPrincipal() principal: Principal) {
    return this.campaigns.get(principal, campaignId);
  }
}
