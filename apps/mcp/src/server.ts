import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  flowRevisionContentSchema,
  currentPlanSchema,
  executionPolicySchema,
  requestCalibrationSchema,
  flowPurposeSchema,
  flowVisibilitySchema,
  runRoleSchema,
  missionResumePointerSchema,
  executionBindingSchema,
  authorizationKindSchema,
  protectedRecoveryCommandSchema,
  veilPreferenceUpdateSchema,
} from "@scry/contracts";
import { z } from "zod";

import { ScryApiClient } from "./api-client.js";

const uuid = z.string().uuid();
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const missionContext = { missionId: uuid, agentSessionId: uuid } as const;
const objectiveContext = { ...missionContext, objectiveId: uuid } as const;

export function createScryMcpServer(client = new ScryApiClient()) {
  const server = new McpServer(
    { name: "scry", version: "1.0.0" },
    { instructions: "Runs execute validated knowledge; Probe Sessions create it. Author capability-grounded intents in a mutable Flow draft, inspect every unresolved target and readiness transition in one Probe Session, compile the complete draft, and publish only an execution-ready immutable revision. Never create or revise immutable Flows directly. Never start a Run without the exact compiledContractId returned at publication. Read get_run.praxis for typed provenance, retry disposition, mutation outcome, safe actions, findings, and artifacts. Never retry an unknown mutation or infer safety from prose. Structural or intent failures return to revision or calibration; policy, privacy, environment, and infrastructure failures follow their typed safe actions. Describe behavior, evidence, scope, prohibited states, risk, and effects—never selectors, test IDs, pixels, or arbitrary coordinates. Mission readiness, authorization, privacy, protected acquisition, and evidence acceptance remain authoritative. Check capabilities before authoring." },
  );

  server.registerTool("get_capabilities", {
    title: "Get Scry capabilities", description: "Verify the exact Scry release and available current-contract actions.", inputSchema: {}, annotations: readOnly,
  }, async () => result({ capabilities: await client.requireCurrentRelease() }, "Scry release and schema agree."));

  server.registerTool("list_projects", {
    title: "List projects", description: "List available Scry projects.", inputSchema: {}, annotations: readOnly,
  }, async () => {
    const projects = await client.get<unknown[]>("/projects");
    return result({ projects }, `Found ${projects.length} projects.`);
  });

  server.registerTool("start_mission", {
    title:"Start Mission",description:"Create a durable work item only after listing Missions and confirming no related non-terminal Mission should be resumed or edited.",annotations:writes,
    inputSchema:{projectId:uuid,title:z.string().trim().min(1).max(200),originalInstruction:z.string().trim().min(1).max(20_000),instructionSnapshot:z.string().trim().min(1).max(20_000),provider:z.enum(["codex","claude","scry_agent","human"]).default("codex"),connectionId:z.string().trim().min(1).max(500).optional(),idempotencyKey:z.string().trim().min(8).max(200).optional(),distinctReason:z.string().trim().min(1).max(2000).optional()},
  },async({projectId,idempotencyKey,...body})=>result(await client.post(`/projects/${projectId}/missions`,{...body,idempotencyKey:idempotencyKey??stableKey("mission",{projectId,...body})}),"Mission and agent session started. Pass both IDs to every later write."));

  server.registerTool("resume_mission", {
    title:"Resume Mission",description:"Start a new agent session for an existing Mission and load its durable continuation context.",annotations:writes,
    inputSchema:{missionId:uuid,instructionSnapshot:z.string().trim().min(1).max(20_000),provider:z.enum(["codex","claude","scry_agent","human"]).default("codex"),connectionId:z.string().trim().min(1).max(500).optional(),idempotencyKey:z.string().trim().min(8).max(200).optional()},
  },async({missionId,idempotencyKey,...body})=>{const session=await client.post(`/missions/${missionId}/agent-sessions`,{...body,idempotencyKey:idempotencyKey??stableKey("mission-session",{missionId,...body})});const mission=await client.get(`/missions/${missionId}`);return result({session,mission},"Mission resumed. Follow its persisted resume pointer.");});

  server.registerTool("attach_to_mission", {
    title:"Attach to Mission",description:"Alias for resuming an existing Mission from another agent connection.",annotations:writes,
    inputSchema:{missionId:uuid,instructionSnapshot:z.string().trim().min(1).max(20_000),provider:z.enum(["codex","claude","scry_agent","human"]).default("codex"),connectionId:z.string().trim().min(1).max(500).optional(),idempotencyKey:z.string().trim().min(8).max(200).optional()},
  },async({missionId,idempotencyKey,...body})=>{const session=await client.post(`/missions/${missionId}/agent-sessions`,{...body,idempotencyKey:idempotencyKey??stableKey("mission-attach",{missionId,...body})});const mission=await client.get(`/missions/${missionId}`);return result({session,mission},"Attached to Mission. Follow its persisted resume pointer.");});

  server.registerTool("get_mission",{title:"Get Mission context",description:"Read objectives, supporting Flows, classified Runs, accepted evidence, reports, and resume pointer.",inputSchema:{missionId:uuid},annotations:readOnly},async({missionId})=>result({mission:await client.get(`/missions/${missionId}`)},"Mission context loaded."));
  server.registerTool("list_missions",{title:"List project Missions",description:"List newest-created Missions before starting work so related non-terminal work can be resumed or edited.",inputSchema:{projectId:uuid},annotations:readOnly},async({projectId})=>{const missions=await client.get<unknown[]>(`/projects/${projectId}/missions`);return result({missions},`Found ${missions.length} Missions, newest-created first.`);});
  server.registerTool("update_mission",{title:"Update Mission",description:"Correct the existing Mission title or original instruction instead of creating replacement work.",inputSchema:{...missionContext,title:z.string().trim().min(1).max(200).optional(),originalInstruction:z.string().trim().min(1).max(20_000).optional()},annotations:writes},async({missionId,...body})=>result({mission:await client.patch(`/missions/${missionId}`,{missionId,...body})},"Mission definition updated."));
  server.registerTool("end_agent_session",{title:"End agent session",description:"Close an agent session after persisting the Mission resume pointer or terminal decision.",inputSchema:{agentSessionId:uuid,status:z.enum(["completed","interrupted","failed"])},annotations:writes},async({agentSessionId,status})=>result({session:await client.post(`/agent-sessions/${agentSessionId}/end`,{status})},"Agent session ended."));
  server.registerTool("get_mission_activity",{title:"Get Mission activity",description:"Read the meaningful journey, optionally including technical supporting work.",inputSchema:{missionId:uuid,includeTechnical:z.boolean().default(false)},annotations:readOnly},async({missionId,includeTechnical})=>result({activities:await client.get(`/missions/${missionId}/activities?technical=${includeTechnical}`)},"Mission activity loaded."));
  server.registerTool("create_execution_plan",{title:"Create Mission execution plan",description:"Bind every objective to manual work or an immutable Flow revision and environment.",inputSchema:{...missionContext,bindings:z.array(executionBindingSchema).min(1).max(500),idempotencyKey:z.string().min(8).max(200).optional()},annotations:writes},async({missionId,idempotencyKey,...body})=>result({plan:await client.post(`/missions/${missionId}/execution-plans`,{missionId,...body,idempotencyKey:idempotencyKey??stableKey("execution-plan",{missionId,...body})})},"Execution plan drafted. Validate it before activation."));
  server.registerTool("validate_execution_plan",{title:"Validate Mission execution plan",description:"Check objective coverage, immutable bindings, project consistency, and authorization prerequisites.",inputSchema:{missionId:uuid,planRevision:z.number().int().positive()},annotations:readOnly},async({missionId,planRevision})=>result({validation:await client.get(`/missions/${missionId}/execution-plans/${planRevision}/validate`)},"Execution plan validation completed."));
  server.registerTool("activate_execution_plan",{title:"Activate Mission execution plan",description:"Activate one explicitly approved plan revision and let Scry calculate readiness.",inputSchema:{...missionContext,planRevision:z.number().int().positive()},annotations:writes},async({missionId,...body})=>result({orchestration:await client.post(`/missions/${missionId}/execution-plans/activate`,{missionId,...body})},"Execution plan activated; Scry readiness is authoritative."));
  server.registerTool("get_orchestration_status",{title:"Inspect Mission orchestration",description:"List ready, running, waiting, blocked, manual, and completed objectives plus active project slots.",inputSchema:{missionId:uuid},annotations:readOnly},async({missionId})=>result({orchestration:await client.get(`/missions/${missionId}/orchestration`)},"Authoritative orchestration status loaded."));
  server.registerTool("start_ready_objectives",{title:"Start ready approved objectives",description:"Ask Scry to claim and start currently ready automated objectives without exceeding project concurrency.",inputSchema:{...missionContext,objectiveIds:z.array(uuid).max(500).optional()},annotations:writes},async({missionId,...body})=>result({orchestration:await client.post(`/missions/${missionId}/orchestration/start-ready`,{missionId,...body})},"Ready objectives were scheduled subject to authoritative readiness and available slots."));
  for(const action of ["pause","resume","cancel"] as const) server.registerTool(`${action}_mission_orchestration`,{title:`${action} Mission orchestration`,description:`${action} scheduling while preserving Mission history and accepted evidence.`,inputSchema:{...missionContext,reason:z.string().trim().min(1).max(2000)},annotations:writes},async({missionId,...body})=>result({orchestration:await client.post(`/missions/${missionId}/orchestration/${action}`,{missionId,...body})},`Mission orchestration ${action} request recorded.`));
  server.registerTool("grant_mission_execution_authorization",{title:"Grant Mission execution authorization",description:"Persist explicit owner/admin authorization for a scoped Live or protected operation. Authorization is never inferred.",inputSchema:{...objectiveContext,environmentId:uuid,kind:authorizationKindSchema,reason:z.string().trim().min(1).max(2000),expiresAt:z.string().datetime().optional(),confirmedUserAuthorized:z.literal(true)},annotations:writes},async({missionId,...body})=>result({authorization:await client.post(`/missions/${missionId}/authorizations`,{missionId,...body})},"Explicit scoped execution authorization recorded."));
  server.registerTool("relate_mission_activity",{title:"Relate Mission activity",description:"Persist an explicit causal relationship between two activities in one Mission.",inputSchema:{...missionContext,fromActivityId:uuid,toActivityId:uuid,relation:z.enum(["caused_by","diagnoses","replaces","depends_on","produced","verified_by","accepted_for"])},annotations:writes},async({missionId,...body})=>result({relation:await client.post(`/missions/${missionId}/activity-relations`,{missionId,...body})},"Causal activity relationship recorded."));
  server.registerTool("create_mission_objective",{title:"Create Mission objective",description:"Create an ordered, user-visible completion objective.",inputSchema:{...missionContext,title:z.string().trim().min(1).max(200),description:z.string().trim().max(2_000).default(""),dependencies:z.array(uuid).max(100).default([]),completionCriteria:z.array(z.object({description:z.string().trim().min(1).max(2_000),required:z.boolean().default(true)}).strict()).min(1),order:z.number().int().nonnegative()},annotations:writes},async({missionId,...body})=>result({objective:await client.post(`/missions/${missionId}/objectives`,{missionId,...body})},"Objective created."));
  server.registerTool("update_mission_objective",{title:"Update Mission objective",description:"Revise an existing Objective or explicitly record its reviewed terminal conclusion instead of replacing the Mission.",inputSchema:{...missionContext,objectiveId:uuid,title:z.string().trim().min(1).max(200).optional(),description:z.string().trim().max(2_000).optional(),dependencies:z.array(uuid).max(100).optional(),completionCriteria:z.array(z.object({description:z.string().trim().min(1).max(2_000),required:z.boolean().default(true)}).strict()).min(1).optional(),order:z.number().int().nonnegative().optional(),status:z.enum(["pending","running","passed","failed","blocked","skipped"]).optional(),conclusion:z.string().trim().min(1).max(5000).optional()},annotations:writes},async({objectiveId,...body})=>result({objective:await client.patch(`/objectives/${objectiveId}`,body)},"Objective updated after explicit review."));
  server.registerTool("attach_flow_to_mission",{title:"Attach Flow to Mission",description:"Reuse an existing project Flow for an objective or explicitly promote it to the reusable library.",inputSchema:{...objectiveContext,flowId:uuid,visibility:flowVisibilitySchema,purpose:flowPurposeSchema,reason:z.string().trim().min(1).max(2_000)},annotations:writes},async({missionId,...body})=>result({flow:await client.post(`/missions/${missionId}/flows`,{missionId,...body})},"Flow attached to Mission."));

  server.registerTool("list_environments", {
    title: "List environments", description: "List execution environments for a project.", inputSchema: { projectId: uuid }, annotations: readOnly,
  }, async ({ projectId }) => {
    const environments = await client.get<unknown[]>(`/projects/${projectId}/environments`);
    return result({ environments }, `Found ${environments.length} environments.`);
  });

  server.registerTool("create_test_environment", {
    title: "Create environment", description: "Create an approved execution environment and credential allowlist.",
    inputSchema: { ...objectiveContext,projectId: uuid, name: z.string().trim().min(1).max(200), baseOrigin: z.string().url(), policy: executionPolicySchema, secretRefs: z.array(uuid).max(100).default([]) }, annotations: writes,
  }, async ({ projectId, ...body }) => result({ environment: await client.post(`/projects/${projectId}/environments`, body) }, "Environment created."));

  server.registerTool("list_project_credentials", {
    title: "List project credentials", description: "List credential references without exposing values.", inputSchema: { projectId: uuid }, annotations: readOnly,
  }, async ({ projectId }) => {
    const credentials = await client.get<unknown[]>(`/projects/${projectId}/credentials`);
    return result({ credentials }, `Found ${credentials.length} credentials.`);
  });

  server.registerTool("create_project_credential", {
    title: "Create project credential",
    description: "Create a new encrypted credential only when the user explicitly supplied its value for this project and requested this use. Never infer a value, reuse transcript content from another purpose, or call this to replace an existing credential. Stored values can never be read back through MCP.",
    inputSchema: {
      ...objectiveContext,
      projectId: uuid,
      name: z.string().trim().min(1).max(200),
      value: z.string().min(1).max(20_000).describe("Sensitive value explicitly supplied by the user for this credential."),
      purpose: z.string().trim().min(1).max(500),
      confirmedUserProvided: z.literal(true).describe("Confirms the user explicitly supplied this value for the stated project and purpose."),
    },
    annotations: writes,
  }, async ({ projectId, missionId, objectiveId, agentSessionId, name, value }) => {
    const created = await client.post<{ id: string; projectId: string; name: string; createdAt: string; updatedAt: string }>(`/projects/${projectId}/credentials`, { missionId,objectiveId,agentSessionId,name,value });
    const credential = { id: created.id, projectId: created.projectId, name: created.name, createdAt: created.createdAt, updatedAt: created.updatedAt };
    return result({ credential }, "Credential encrypted and stored. Its value cannot be read back through MCP.");
  });

  server.registerTool("authorize_environment_credentials", {
    title: "Authorize environment credentials",
    description: "Explicitly add opaque credential references to an existing environment allowlist. This never exposes credential values and never infers authorization from credential names or Flow contents.",
    inputSchema: { ...objectiveContext,projectId: uuid, environmentId: uuid, credentialIds: z.array(uuid).min(1).max(100) }, annotations: writes,
  }, async ({ projectId,environmentId,credentialIds,missionId,objectiveId,agentSessionId }) => {
    const environments = await client.get<Array<{ id: string; baseOrigin: string; policy: z.infer<typeof executionPolicySchema>; secretRefs: string[] }>>(`/projects/${projectId}/environments`);
    const environment = environments.find((candidate) => candidate.id === environmentId);
    if (!environment) throw new Error("Environment not found in the selected project.");
    const secretRefs = [...new Set([...environment.secretRefs, ...credentialIds])];
    const updated = await client.patch<{ id: string; projectId: string; name: string; baseOrigin: string; secretRefs: string[] }>(`/environments/${environmentId}`, {
      baseOrigin: environment.baseOrigin,
      policy: environment.policy,missionId,objectiveId,agentSessionId,
      secretRefs,
    });
    return result({ environment: updated }, `Authorized ${credentialIds.length} credential reference(s) for the environment.`);
  });

  server.registerTool("list_flows", {
    title: "List Flows", description: "List current Flows and their latest immutable revisions.", inputSchema: { projectId: uuid }, annotations: readOnly,
  }, async ({ projectId }) => {
    await client.requireCurrentRelease();
    const flows = await client.get<unknown[]>(`/projects/${projectId}/flows`);
    return result({ flows }, `Found ${flows.length} Flows.`);
  });

  server.registerTool("ensure_calibration", {
    title: "Ensure protected operation calibration",
    description: "Find an effective attestation or idempotently create a disposable protected calibration session. Scry derives the operation digest and structure, exercises the protected operation once, and returns only safe actions. Call only with explicit user authorization and confirmed disposable data.",
    inputSchema: { projectId: uuid, calibration: requestCalibrationSchema }, annotations: writes,
  }, async ({ projectId, calibration }) => result({ calibration: await client.post(`/projects/${projectId}/calibration-sessions`, calibration) }, "Calibration resolved or queued. Follow only the returned safeActions."));

  server.registerTool("list_calibrations", {
    title: "List calibrations", description: "List calibration contracts and their effective decisions.", inputSchema: { projectId: uuid }, annotations: readOnly,
  }, async ({ projectId }) => result({ calibrations: await client.get<unknown[]>(`/projects/${projectId}/calibrations`) }, "Calibrations loaded."));

  server.registerTool("get_calibration", {
    title: "Get calibration", description: "Inspect immutable calibration revisions, sessions, safe diagnostics, attestations, decisions, and safe actions.", inputSchema: { calibrationId: uuid }, annotations: readOnly,
  }, async ({ calibrationId }) => result({ calibration: await client.get(`/calibrations/${calibrationId}`) }, "Calibration loaded."));

  server.registerTool("approve_calibration", {
    title: "Approve exact calibration attestation",
    description: "Approve one immutable privacy attestation only when the user explicitly authorized it and the MCP identity is an owner or admin. Approval cannot edit the operation, bypass attestation, or approve another result.",
    inputSchema: {
      ...objectiveContext,
      calibrationId: uuid,
      attestationId: uuid,
      confirmedUserAuthorized: z.literal(true),
      reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("USER_AUTHORIZED_AGENT_CALIBRATION"),
    }, annotations: writes,
  }, async ({calibrationId,attestationId,reasonCode,missionId,objectiveId,agentSessionId}) => result({ calibration: await client.post(`/calibrations/${calibrationId}/attestations/${attestationId}/approve`,{missionId,objectiveId,agentSessionId,reasonCode,confirmedUserAuthorized:true}) }, "Exact immutable calibration attestation approved."));

  server.registerTool("retry_calibration", {
    title: "Retry safe calibration preflight", description: "Retry a failed or sealed calibration session only when no mutation began.",
    inputSchema:{...objectiveContext,sessionId:uuid,idempotencyKey:z.string().trim().min(8).max(200)},annotations:writes,
  },async({sessionId,...body})=>result({calibration:await client.post(`/calibration-sessions/${sessionId}/retry`,body)},"Calibration session queued for a fenced retry."));

  server.registerTool("cancel_calibration", {
    title:"Cancel queued calibration",description:"Cancel a calibration before a worker claims it.",inputSchema:{...objectiveContext,sessionId:uuid},annotations:writes,
  },async({sessionId,...body})=>result({calibration:await client.post(`/calibration-sessions/${sessionId}/cancel`,body)},"Queued calibration cancelled."));

  server.registerTool("bind_calibration", {
    title: "Bind calibration to Flow",
    description: "Atomically create a Flow revision binding one exact approved attestation. The API recomputes the operation digest and rejects changed behavior or structural mismatch.",
    inputSchema: {
      ...objectiveContext,
      projectId: uuid,
      flowId: uuid,
      environmentId: uuid,
      expectedRevisionId: uuid,
      operationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
      attestationId: uuid,
      reason:z.string().trim().min(1).max(2_000),
    }, annotations: writes,
  }, async ({ projectId, flowId, environmentId, expectedRevisionId, operationId, attestationId,missionId,objectiveId,agentSessionId,reason }) => {
    const revision = await client.post(`/flows/${flowId}/calibration-bindings`, {
      environmentId,expectedRevisionId,operationId,attestationId,missionId,objectiveId,agentSessionId,reason,
      idempotencyKey:stableKey("bind-calibration",{projectId,flowId,expectedRevisionId,operationId,attestationId,missionId,objectiveId,agentSessionId}),
    });
    return result({ revision }, "Exact approved attestation bound atomically in a new immutable Flow revision.");
  });

  server.registerTool("validate_test_plan", {
    title: "Validate plan", description: "Run authoritative API validation without mutating state.",
    inputSchema: { projectId: uuid, environmentId: uuid, plan: currentPlanSchema }, annotations: readOnly,
  }, async (body) => {
    await client.requireCurrentRelease();
    const validation = await client.post<{ valid: boolean; errors: unknown[]; warnings: unknown[] }>("/plan-validations", body);
    return result(validation, validation.valid ? "Plan is valid." : `Plan has ${validation.errors.length} error(s).`);
  });

  server.registerTool("create_flow_draft",{title:"Create Flow draft",description:"Create mutable authoring state; this does not publish a Flow revision.",inputSchema:{...objectiveContext,projectId:uuid,environmentId:uuid,flowId:uuid.optional(),name:z.string().trim().min(1).max(200),description:z.string().trim().max(2000).default(""),content:flowRevisionContentSchema,plan:currentPlanSchema,idempotencyKey:z.string().min(8).max(200).optional()},annotations:writes},async({idempotencyKey,...body})=>result({draft:await client.post("/flow-drafts",{...body,idempotencyKey:idempotencyKey??stableKey("draft",body)})},"Mutable Flow draft created."));
  server.registerTool("update_flow_draft",{title:"Update Flow draft",description:"Apply a complete correction set to an unpublished draft using optimistic versioning.",inputSchema:{...objectiveContext,draftId:uuid,expectedVersion:z.number().int().positive(),name:z.string().trim().min(1).max(200).optional(),description:z.string().trim().max(2000).optional(),content:flowRevisionContentSchema.optional(),plan:currentPlanSchema.optional(),reason:z.string().trim().min(1).max(2000)},annotations:writes},async({draftId,...body})=>result({draft:await client.patch(`/flow-drafts/${draftId}`,body)},"Flow draft updated; prior compilation is stale."));
  server.registerTool("get_flow_draft",{title:"Get Flow draft context",description:"Read draft versions, Probe Sessions, consolidated diagnostics, and compilations.",inputSchema:{draftId:uuid},annotations:readOnly},async({draftId})=>result({draft:await client.get(`/flow-drafts/${draftId}`)},"Flow draft context loaded."));
  server.registerTool("list_mission_flow_drafts",{title:"List Mission Flow drafts",description:"List authoring work without mixing it into Runs.",inputSchema:{missionId:uuid},annotations:readOnly},async({missionId})=>result({drafts:await client.get(`/missions/${missionId}/flow-drafts`)},"Mission authoring drafts loaded."));
  server.registerTool("abandon_flow_draft",{title:"Abandon Flow draft",description:"Close obsolete unpublished authoring work while retaining its audit history.",inputSchema:{...objectiveContext,draftId:uuid,expectedVersion:z.number().int().positive(),reason:z.string().trim().min(1).max(2000)},annotations:writes},async({draftId,...body})=>result({draft:await client.post(`/flow-drafts/${draftId}/abandon`,body)},"Flow draft abandoned; its history is retained."));
  server.registerTool("start_probe_session",{title:"Start Probe Session",description:"Inspect every target and readiness contract together. This is authoring activity, not a Run.",inputSchema:{...objectiveContext,draftId:uuid,environmentId:uuid,draftVersion:z.number().int().positive(),level:z.enum(["inspection","reversible","calibration_transaction"]),disposableDataConfirmed:z.boolean().default(false),authorizationId:uuid.optional(),authenticationContractRevisionId:uuid.optional(),idempotencyKey:z.string().min(8).max(200).optional()},annotations:writes},async({draftId,idempotencyKey,...body})=>result({probe:await client.post(`/flow-drafts/${draftId}/probes`,{...body,idempotencyKey:idempotencyKey??stableKey("probe",{draftId,...body})})},"Probe Session queued."));
  server.registerTool("get_probe_session",{title:"Get Probe Session",description:"Monitor authoring progress and read the consolidated safe correction set.",inputSchema:{probeSessionId:uuid},annotations:readOnly},async({probeSessionId})=>result({probe:await client.get(`/probe-sessions/${probeSessionId}`)},"Probe Session loaded."));
  server.registerTool("cancel_probe_session",{title:"Cancel Probe Session",description:"Request cancellation without creating a Run result.",inputSchema:{...missionContext,probeSessionId:uuid},annotations:writes},async({probeSessionId,...body})=>result({probe:await client.post(`/probe-sessions/${probeSessionId}/cancel`,body)},"Probe cancellation requested."));
  server.registerTool("compile_flow_draft",{title:"Compile Flow draft",description:"Compile all probe knowledge into one execution contract and return every blocker together.",inputSchema:{...objectiveContext,draftId:uuid,environmentId:uuid,draftVersion:z.number().int().positive(),probeSessionId:uuid,authenticationContractRevisionId:uuid.optional(),idempotencyKey:z.string().min(8).max(200).optional()},annotations:writes},async({draftId,idempotencyKey,...body})=>result({compilation:await client.post(`/flow-drafts/${draftId}/compile`,{...body,idempotencyKey:idempotencyKey??stableKey("compile",{draftId,...body})})},"Flow draft compiled."));
  server.registerTool("publish_flow_draft",{title:"Publish execution-ready Flow",description:"Freeze an execution-ready draft as one immutable Flow revision.",inputSchema:{...objectiveContext,draftId:uuid,expectedVersion:z.number().int().positive(),compilationId:uuid,visibility:flowVisibilitySchema.default("mission_local"),purpose:flowPurposeSchema.default("primary"),reason:z.string().trim().min(1).max(2000),idempotencyKey:z.string().min(8).max(200).optional()},annotations:writes},async({draftId,idempotencyKey,...body})=>result({publication:await client.post(`/flow-drafts/${draftId}/publish`,{...body,idempotencyKey:idempotencyKey??stableKey("publish",{draftId,...body})})},"Execution-ready Flow revision published."));
  server.registerTool("list_authentication_contracts",{title:"List Authentication Contracts",description:"Read reusable environment-bound authentication setup without exposing browser state.",inputSchema:{projectId:uuid},annotations:readOnly},async({projectId})=>result({contracts:await client.get(`/projects/${projectId}/authentication-contracts`)},"Authentication Contracts loaded."));
  server.registerTool("list_authenticated_session_leases",{title:"List authenticated session leases",description:"Read sanitized encrypted-session lease metadata; cookies and storage are never returned.",inputSchema:{projectId:uuid},annotations:readOnly},async({projectId})=>result({leases:await client.get(`/projects/${projectId}/authenticated-session-leases`)},"Authenticated session lease metadata loaded."));
  server.registerTool("revoke_authenticated_session_lease",{title:"Revoke authenticated session lease",description:"Revoke an encrypted reusable browser session without exposing its contents.",inputSchema:{leaseId:uuid},annotations:writes},async({leaseId})=>result({lease:await client.post(`/authenticated-session-leases/${leaseId}/revoke`)},"Authenticated session lease revoked."));

  server.registerTool("start_run", {
    title: "Start run", description: "Create and queue a run from an immutable Flow revision.",
    inputSchema: { ...objectiveContext,projectId: uuid, environmentId: uuid, flowRevisionId: uuid,compiledContractId:uuid,role:runRoleSchema.default("candidate"),
      viewport: z.object({ width: z.number().int().min(320).max(3_840), height: z.number().int().min(320).max(2_160) }).default({ width: 1280, height: 720 }),
      seed: z.number().int().min(0).max(4_294_967_295).default(1), idempotencyKey: z.string().trim().min(8).max(200).optional() }, annotations: writes,
  }, async ({ projectId, idempotencyKey, ...body }) => {
    await client.requireCurrentRelease();
    const run = await client.post<Record<string, unknown>>(`/projects/${projectId}/runs`, { ...body, browser: "chromium", idempotencyKey: idempotencyKey ?? stableKey("run", { projectId, ...body }) });
    return result({ run }, "Run queued.");
  });

  server.registerTool("get_run", {
    title: "Get run observation", description: "Read the canonical run observation: current attempt, independent step channels, typed failure, safe artifact manifest, privacy timeline, integrity status, and permitted next actions.", inputSchema: { runId: uuid }, annotations: readOnly,
  }, async ({ runId }) => result({ observation: await client.get(`/runs/${runId}`) }, "Canonical run observation loaded."));
  server.registerTool("get_veil_findings", {
    title: "Get Veil privacy findings",
    description: "Read the effective Veil profile, privacy timeline, capture gaps, safe reason codes, and remediation without exposing protected values.",
    inputSchema: { runId: uuid }, annotations: readOnly,
  }, async ({ runId }) => result({ veil: await client.get(`/runs/${runId}/veil`) }, "Veil privacy findings loaded."));
  server.registerTool("tighten_veil_preferences", {
    title: "Tighten Veil preferences",
    description: "Apply a strictly more private environment policy. This tool cannot enable a disabled channel, add an origin, extend a lease, or weaken Veil's safety floor.",
    inputSchema: { environmentId: uuid, ...veilPreferenceUpdateSchema.shape }, annotations: writes,
  }, async ({ environmentId, ...preferences }) => result({
    veil: await client.patch(`/environments/${environmentId}/veil`, preferences),
  }, "Veil preferences tightened; the hard safety floor remains active."));
  server.registerTool("get_protected_recovery",{title:"Get protected acquisition recovery",description:"Inspect the bounded recovery state without exposing protected values.",inputSchema:{runId:uuid,operationId:z.string().min(1).max(128)},annotations:readOnly},async({runId,operationId})=>result({recovery:await client.get(`/runs/${runId}/protected-transactions/${operationId}/recovery`)},"Protected recovery state loaded."));
  server.registerTool("act_on_protected_recovery",{title:"Act on protected acquisition recovery",description:"Retry an approved acquisition method, request secure assistance, revoke, or abandon. This never repeats the mutation.",inputSchema:{runId:uuid,operationId:z.string().min(1).max(128),...protectedRecoveryCommandSchema.shape},annotations:writes},async({runId,operationId,...body})=>result({recovery:await client.post(`/runs/${runId}/protected-transactions/${operationId}/recovery`,body)},"Protected recovery action recorded."));

  server.registerTool("accept_objective_evidence",{title:"Accept objective evidence",description:"Select one passed Run and optional safe artifacts as authoritative objective evidence.",inputSchema:{...missionContext,objectiveId:uuid,runId:uuid,artifactIds:z.array(uuid).max(500).default([]),conclusion:z.string().trim().min(1).max(10_000)},annotations:writes},async({objectiveId,...body})=>result({evidence:await client.post(`/objectives/${objectiveId}/evidence`,body)},"Evidence accepted for objective."));
  server.registerTool("classify_run",{title:"Classify Mission Run",description:"Classify a Run's purpose within its Mission.",inputSchema:{...missionContext,runId:uuid,role:runRoleSchema,reason:z.string().trim().min(1).max(2_000)},annotations:writes},async({runId,...body})=>result({run:await client.post(`/runs/${runId}/classification`,body)},"Run classified."));
  server.registerTool("set_mission_resume_pointer",{title:"Set Mission resume pointer",description:"Persist the single authoritative next action for later agents and users.",inputSchema:{...missionContext,pointer:missionResumePointerSchema.nullable()},annotations:writes},async({missionId,...body})=>result({mission:await client.patch(`/missions/${missionId}/resume-pointer`,{missionId,...body})},"Mission resume pointer updated."));
  server.registerTool("publish_mission_report",{title:"Publish Mission report",description:"Publish an immutable consolidated report after all required objectives are terminal.",inputSchema:{...missionContext,overallConclusion:z.string().trim().min(1).max(20_000),journeySummary:z.array(z.string().trim().min(1).max(2_000)).min(1).max(500),remainingActions:z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),expectedRevision:z.number().int().nonnegative()},annotations:writes},async({missionId,...body})=>result({report:await client.post(`/missions/${missionId}/reports`,{missionId,...body})},"Immutable Mission report published."));

  server.registerTool("get_artifact", {
    title: "Get artifact", description: "Read a bounded text page or return a stable Scry resource identifier.",
    inputSchema: { artifactId: uuid, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(262_144).default(65_536) }, annotations: readOnly,
  }, async ({ artifactId, offset, limit }) => {
    await client.requireCurrentRelease();
    const metadata = await client.get<{ contentType: string }>(`/artifacts/${artifactId}/metadata`);
    if (metadata.contentType.startsWith("text/") || metadata.contentType.includes("json") || metadata.contentType.includes("html")) {
      const page = await client.get(`/artifacts/${artifactId}/text?offset=${offset}&limit=${limit}`);
      return result({ artifactId, resource: `scry://artifact/${artifactId}`, metadata, page }, "Artifact page loaded.");
    }
    return result({ artifactId, resource: `scry://artifact/${artifactId}`, metadata }, "Binary artifact is available as a Scry resource.");
  });

  server.registerTool("search_artifact", {
    title: "Search artifact", description: "Search textual artifact content with bounded context.",
    inputSchema: { artifactId: uuid, query: z.string().min(1).max(500), maxMatches: z.number().int().min(1).max(100).default(20) }, annotations: readOnly,
  }, async ({ artifactId, ...body }) => result({ search: await client.post(`/artifacts/${artifactId}/search`, body) }, "Artifact search complete."));

  server.registerTool("extract_artifact_html", {
    title: "Extract artifact HTML", description: "Extract bounded structural HTML and normalized text using a validated CSS selector.",
    inputSchema: { artifactId: uuid, selector: z.string().trim().min(1).max(500) }, annotations: readOnly,
  }, async ({ artifactId, selector }) => result({ extraction: await client.post(`/artifacts/${artifactId}/extract-html`, { selector }) }, "HTML extraction complete."));

  return server;
}

function stableKey(scope: string, value: unknown) {
  return `mcp-${scope}-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function result(data: Record<string, unknown>, message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ message, ...data }, null, 2) }], structuredContent: { message, ...data } };
}
