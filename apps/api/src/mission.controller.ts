import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import {
  acceptEvidenceSchema,attachFlowSchema,classifyRunSchema,createActivityRelationSchema,createMissionSchema,createObjectiveSchema,
  endAgentSessionSchema, missionTransitionSchema, publishMissionReportSchema, startAgentSessionSchema,
  updateMissionSchema,updateObjectiveSchema, updateResumePointerSchema,
  createExecutionPlanSchema,activateExecutionPlanSchema,orchestrationControlSchema,startReadyObjectivesSchema,grantMissionAuthorizationSchema,
  type AcceptEvidenceInput, type AttachFlowInput, type ClassifyRunInput, type CreateMissionInput,
  type CreateActivityRelationInput,type CreateObjectiveInput,type EndAgentSessionInput,type MissionTransitionInput,
  type PublishMissionReportInput, type StartAgentSessionInput,type UpdateMissionInput, type UpdateObjectiveInput, type UpdateResumePointerInput,
} from "@scry/contracts";
import type {CreateExecutionPlanInput,ActivateExecutionPlanInput,GrantMissionAuthorizationInput,OrchestrationControlInput,StartReadyObjectivesInput} from "@scry/contracts";

import type { Principal } from "./auth.types.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { MissionService } from "./mission.service.js";
import { OrchestrationService } from "./orchestration.service.js";
import { ZodValidationPipe } from "./validation.pipe.js";

@Controller("api")
export class MissionController {
  constructor(@Inject(MissionService) private readonly missions: MissionService,@Inject(OrchestrationService) private readonly orchestration:OrchestrationService) {}

  @Post("projects/:projectId/missions") create(@Param("projectId") projectId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(createMissionSchema)) input:CreateMissionInput){return this.missions.create(principal,projectId,input);}
  @Get("projects/:projectId/missions") list(@Param("projectId") projectId:string,@CurrentPrincipal() principal:Principal){return this.missions.list(principal,projectId);}
  @Get("missions/:missionId") get(@Param("missionId") missionId:string,@CurrentPrincipal() principal:Principal){return this.missions.get(principal,missionId);}
  @Patch("missions/:missionId") update(@Param("missionId") missionId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(updateMissionSchema)) input:UpdateMissionInput){return this.missions.update(principal,missionId,input);}
  @Get("missions/:missionId/activities") activities(@Param("missionId") missionId:string,@Query("technical") technical:string|undefined,@CurrentPrincipal() principal:Principal){return this.missions.activities(principal,missionId,technical==="true");}
  @Post("missions/:missionId/activity-relations") relation(@Param("missionId") missionId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(createActivityRelationSchema)) input:CreateActivityRelationInput){return this.missions.relateActivities(principal,missionId,input);}
  @Post("missions/:missionId/agent-sessions") startSession(@Param("missionId") missionId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(startAgentSessionSchema)) input:StartAgentSessionInput){return this.missions.startSession(principal,missionId,input);}
  @Post("agent-sessions/:sessionId/end") endSession(@Param("sessionId") sessionId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(endAgentSessionSchema)) input:EndAgentSessionInput){return this.missions.endSession(principal,sessionId,input);}
  @Post("missions/:missionId/objectives") objective(@Param("missionId") missionId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(createObjectiveSchema)) input:CreateObjectiveInput){return this.missions.createObjective(principal,missionId,input);}
  @Patch("objectives/:objectiveId") updateObjective(@Param("objectiveId") objectiveId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(updateObjectiveSchema)) input:UpdateObjectiveInput){return this.missions.updateObjective(principal,objectiveId,input);}
  @Post("missions/:missionId/flows") attachFlow(@Param("missionId") missionId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(attachFlowSchema)) input:AttachFlowInput){return this.missions.attachFlow(principal,missionId,input);}
  @Post("runs/:runId/classification") classify(@Param("runId") runId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(classifyRunSchema)) input:ClassifyRunInput){return this.missions.classifyRun(principal,runId,input);}
  @Post("objectives/:objectiveId/evidence") accept(@Param("objectiveId") objectiveId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(acceptEvidenceSchema)) input:AcceptEvidenceInput){return this.missions.acceptEvidence(principal,objectiveId,input);}
  @Patch("missions/:missionId/resume-pointer") pointer(@Param("missionId") missionId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(updateResumePointerSchema)) input:UpdateResumePointerInput){return this.missions.updateResumePointer(principal,missionId,input);}
  @Post("missions/:missionId/resume") resume(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(missionTransitionSchema)) i:MissionTransitionInput){return this.missions.transition(p,id,"resume",i);}
  @Post("missions/:missionId/cancel") cancel(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(missionTransitionSchema)) i:MissionTransitionInput){return this.orchestration.control(p,id,"cancel",{missionId:i.missionId,agentSessionId:i.agentSessionId,reason:i.explanation});}
  @Post("missions/:missionId/reopen") reopen(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(missionTransitionSchema)) i:MissionTransitionInput){return this.missions.transition(p,id,"reopen",i);}
  @Get("missions/:missionId/report-preview") preview(@Param("missionId") id:string,@CurrentPrincipal() p:Principal){return this.missions.previewReport(p,id);}
  @Post("missions/:missionId/reports") publish(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(publishMissionReportSchema)) i:PublishMissionReportInput){return this.missions.publishReport(p,id,i);}
  @Get("projects/:projectId/mission-reports") reports(@Param("projectId") id:string,@CurrentPrincipal() p:Principal){return this.missions.listReports(p,id);}
  @Get("mission-reports/:reportId") report(@Param("reportId") id:string,@CurrentPrincipal() p:Principal){return this.missions.getReport(p,id);}
  @Post("missions/:missionId/execution-plans") createPlan(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(createExecutionPlanSchema)) i:CreateExecutionPlanInput){return this.orchestration.createPlan(p,id,i);}
  @Post("missions/:missionId/execution-plans/activate") activatePlan(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(activateExecutionPlanSchema)) i:ActivateExecutionPlanInput){return this.orchestration.activate(p,id,i);}
  @Get("missions/:missionId/execution-plans/:revision/validate") validatePlan(@Param("missionId") id:string,@Param("revision") revision:string,@CurrentPrincipal() p:Principal){return this.orchestration.validate(p,id,Number(revision));}
  @Get("missions/:missionId/orchestration") orchestrationStatus(@Param("missionId") id:string,@CurrentPrincipal() p:Principal){return this.orchestration.status(p,id);}
  @Post("missions/:missionId/orchestration/start-ready") startReady(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(startReadyObjectivesSchema)) i:StartReadyObjectivesInput){return this.orchestration.startReady(p,id,i);}
  @Post("missions/:missionId/orchestration/pause") pause(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(orchestrationControlSchema)) i:OrchestrationControlInput){return this.orchestration.control(p,id,"pause",i);}
  @Post("missions/:missionId/orchestration/resume") resumeOrchestration(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(orchestrationControlSchema)) i:OrchestrationControlInput){return this.orchestration.control(p,id,"resume",i);}
  @Post("missions/:missionId/orchestration/cancel") cancelOrchestration(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(orchestrationControlSchema)) i:OrchestrationControlInput){return this.orchestration.control(p,id,"cancel",i);}
  @Post("missions/:missionId/authorizations") authorize(@Param("missionId") id:string,@CurrentPrincipal() p:Principal,@Body(new ZodValidationPipe(grantMissionAuthorizationSchema)) i:GrantMissionAuthorizationInput){return this.orchestration.grantAuthorization(p,id,i);}
}
