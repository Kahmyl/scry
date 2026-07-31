import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  testPlanSchema,
  testPlanV2Schema,
  analyzePlanRisks,
  validatePlanAgainstPolicy,
  executionPolicyV1Schema,
} from "@scry/contracts";
import { z } from "zod";

import { ScryApiClient } from "./api-client.js";

const id = z.string().uuid();
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function createScryMcpServer(client = new ScryApiClient()) {
  const server = new McpServer(
    { name: "scry", version: "0.1.0" },
    {
      instructions:
        "Scry executes deterministic browser plans; it does not plan tests. Author protocol v2 by default. Before guessing exact copy on an unfamiliar page, run a bounded reconnaissance step with transient screenshot and DOM evidence, inspect those artifacts, then revise the same Flow with observed semantic targets. Every reaction-triggering action that produces final evidence must define semantic readiness in after; readiness means inspectable, assertions mean correct, and evidence is captured only afterward. Use transient capture with justification only for intentional intermediate states. Validate and resolve every error before saving or running. Choose the Flow operation by journey continuity. Use start_run or rerun_exact_plan when the plan is unchanged, extend_flow for a dependent continuation, revise_flow for a complete corrected replacement, and submit_test_spec for an independently meaningful journey. A failed run alone never justifies a new Flow. A repeated readiness timeout proves only that the configured ready state was not observed twice; it never validates that expectation or confirms a product defect. Only a reproduced assertion failure after successful semantic readiness may be classified as confirmed_product_failure.",
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Scry projects",
      description: "Find the Scry project IDs available for browser testing.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    async () => {
      const projects = await client.get<unknown[]>("/projects");
      return result({ projects }, `Found ${projects.length} Scry projects.`);
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create Scry project",
      description: "Create a project that will own test environments, specifications, and runs.",
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(""),
      },
      annotations: writeAnnotations,
    },
    async (input) => {
      const project = await client.post<Record<string, unknown>>("/projects", input);
      return result({ project }, `Created Scry project ${String(project.name)}.`);
    },
  );

  server.registerTool(
    "list_flows",
    {
      title: "Find existing Flows",
      description:
        "List a project's existing Flows and their latest saved versions. Always call this before submit_test_spec. Reuse a matching Flow with revise_flow instead of creating a duplicate.",
      inputSchema: { projectId: id },
      annotations: readAnnotations,
    },
    async ({ projectId }) => {
      const flows = await client.get<unknown[]>(`/projects/${projectId}/specifications`);
      return result(
        { flows },
        flows.length === 0
          ? "No Flows exist in this project. Create one with submit_test_spec."
          : `Found ${flows.length} existing Flows. Revise a matching Flow with revise_flow; create a new one only for a genuinely different journey.`,
      );
    },
  );

  server.registerTool(
    "list_environments",
    {
      title: "List test environments",
      description: "List approved browser origins and execution policies for a project.",
      inputSchema: { projectId: id },
      annotations: readAnnotations,
    },
    async ({ projectId }) => {
      const environments = await client.get<unknown[]>(
        `/projects/${projectId}/environments`,
      );
      return result({ environments }, `Found ${environments.length} environments.`);
    },
  );

  server.registerTool(
    "create_test_environment",
    {
      title: "Create test environment",
      description:
        "Create an approved browser origin, execution boundary, and credential allowlist for a project. secretRefs must contain credential IDs returned by list_project_credentials or create_project_credential.",
      inputSchema: {
        projectId: id,
        name: z.string().trim().min(1).max(200),
        baseOrigin: z.string().url(),
        policy: executionPolicyV1Schema,
        secretRefs: z.array(id).max(100).default([]),
      },
      annotations: writeAnnotations,
    },
    async ({ projectId, ...input }) => {
      const environment = await client.post<Record<string, unknown>>(
        `/projects/${projectId}/environments`,
        input,
      );
      return result({ environment }, `Created test environment ${String(environment.name)}.`);
    },
  );

  server.registerTool(
    "update_test_environment",
    {
      title: "Update test environment",
      description:
        "Update an environment's approved origin, execution boundary, and credential allowlist. This does not reveal credential values.",
      inputSchema: {
        environmentId: id,
        baseOrigin: z.string().url(),
        policy: executionPolicyV1Schema,
        secretRefs: z.array(id).max(100).default([]),
      },
      annotations: writeAnnotations,
    },
    async ({ environmentId, ...input }) => {
      const environment = await client.patch<Record<string, unknown>>(
        `/environments/${environmentId}`,
        input,
      );
      return result({ environment }, `Updated test environment ${String(environment.name)}.`);
    },
  );

  server.registerTool(
    "list_project_credentials",
    {
      title: "List protected credentials",
      description:
        "List safe credential IDs and display names for a project. Secret values are never returned. Use the ID as a plan secretRef.",
      inputSchema: { projectId: id },
      annotations: readAnnotations,
    },
    async ({ projectId }) => {
      const credentials = await client.get<unknown[]>(`/projects/${projectId}/credentials`);
      return result(
        { credentials },
        `Found ${credentials.length} protected credentials. Use a credential ID as secretRef.`,
      );
    },
  );

  server.registerTool(
    "create_project_credential",
    {
      title: "Store protected test information",
      description:
        "Encrypt and store one private test value for a project. The value is accepted once and never returned. Use the returned credential ID in environment secretRefs and plan fill actions.",
      inputSchema: {
        projectId: id,
        name: z.string().trim().min(1).max(200),
        value: z.string().min(1).max(20_000),
      },
      annotations: writeAnnotations,
    },
    async ({ projectId, name, value }) => {
      const credential = await client.post<Record<string, unknown>>(
        `/projects/${projectId}/credentials`,
        { name, value },
      );
      return result(
        { credential },
        `Stored protected credential ${String(credential.name)}. Use ID ${String(credential.id)} as secretRef; the value will not be shown again.`,
      );
    },
  );

  server.registerTool(
    "get_plan_authoring_guide",
    {
      title: "Get plan authoring guide",
      description:
        "Return protocol v2 action, readiness, assertion, evidence, classification, and secret-reference guidance for a deterministic Scry plan, plus v1 compatibility notes.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    async () => result(
      {
        protocolVersion: "2",
        workflow: [
          "List projects, then call list_flows before deciding whether to create anything.",
          "If the journey already exists, validate the corrected plan and call revise_flow. Only call submit_test_spec when no existing Flow represents the journey.",
          "For an unfamiliar destination, first capture an intentional transient screenshot and DOM after bounded settling, inspect them with list_run_artifacts and get_artifact, then revise the same Flow using observed roles and names. Do not guess exact UI copy repeatedly.",
          "Store missing private values and authorize their IDs in an environment.",
          "Start a run from the selected plan version, poll status, then read its report. A run is an execution and never requires a new Flow.",
        ],
        flowLifecycle: {
          newJourney: "list_flows -> validate_test_plan -> submit_test_spec -> start_run",
          continueSameJourney:
            "list_flows -> extend_flow (preserves old steps and appends new steps) -> validate the returned combined plan -> start_run",
          correctOrExtendExistingJourney:
            "list_flows -> revise_flow with the complete corrected plan -> validate_test_plan -> start_run",
          applicationChangedButPlanDidNot: "rerun_exact_plan",
          inspectExecution: "get_run_status -> get_test_report",
          reconnaissance:
            "revise the existing Flow with captureIntent transient + justification + domStable/networkQuiet readiness + screenshot/DOM evidence -> run -> list_run_artifacts -> get_artifact -> revise the same Flow with observed semantic targets",
        },
        actions: {
          navigate: { type: "navigate", url: "/login" },
          fillLiteral: { type: "fill", target: { strategy: "placeholder", value: "Email" }, value: "safe test value" },
          fillProtected: { type: "fill", target: { strategy: "label", value: "Password" }, secretRef: "credential UUID" },
          captureGeneratedProtectedValue: {
            type: "captureSecret",
            target: { strategy: "label", value: "Client secret" },
            reference: "generated_api_secret",
            credentialName: "Generated API credential",
          },
          reuseCapturedValueInSameRun: {
            type: "fill",
            target: { strategy: "label", value: "API secret" },
            capturedSecretRef: "generated_api_secret",
          },
          click: { type: "click", target: { strategy: "role", role: "button", name: "Sign in", exact: true } },
          select: { type: "select", target: { strategy: "label", value: "Mode" }, value: "test" },
          scroll: { type: "scroll", deltaY: 600 },
          waitFor: { type: "waitFor", target: { strategy: "text", value: "Dashboard", exact: true }, state: "visible", timeoutMs: 15_000 },
          screenshot: { type: "screenshot", name: "final-state" },
        },
        readiness: {
          semanticExample: {
            mode: "all",
            timeoutMs: 30_000,
            conditions: [{ type: "visible", target: { strategy: "text", value: "Run POST", exact: true } }],
          },
          contentExample: {
            mode: "all",
            timeoutMs: 30_000,
            conditions: [{ type: "content", target: { strategy: "css", value: "#docs-root", justification: "Documentation mount point" }, minimumChildren: 1 }],
          },
          supported: ["visible", "hidden", "text", "value", "checked", "url", "content", "request", "domStable", "networkQuiet", "delay"],
        },
        locatorStrategies: ["role", "label", "placeholder", "text", "testId", "css (requires justification)"],
        assertionTypes: ["visible", "hidden", "text", "value", "url"],
        evidenceKinds: ["screenshot", "dom", "network"],
        rules: [
          "Use credential UUIDs only; never place passwords or tokens in literal values.",
          "Use captureSecret for a generated one-time value. Scry disables trace and video for every run that captures or fills protected values, redacts subsequent DOM/network evidence, stores the value encrypted, authorizes it for future runs, and allows same-run reuse through capturedSecretRef. Never request screenshots in a protected-value run.",
          "Readiness is required before final evidence after navigate, click, press, select, or check. Prefer destination-specific text or content over technical settling.",
          "A transient capture requires justification and cannot support a completed-state defect claim.",
          "Flow creation is exceptional. A failure never justifies a new Flow, even after repeated failed revisions or runs.",
          "Use extend_flow when later actions depend on earlier actions and one run should record the whole journey. It appends; it does not overwrite.",
          "Use revise_flow to correct or replace actions. Because revise_flow accepts a complete plan, include every step that must remain.",
          "Create a separate Flow when it is independently runnable and independently meaningful, even if it tests the same product area from another starting context or goal.",
          "Never create a second Flow solely to fix a locator, assertion, URL, credential reference, or failed run.",
          "Do not revise a Flow merely to execute it again. Use start_run for its saved plan version, or rerun_exact_plan for an unchanged prior run.",
          "Every absolute destination origin must be present in plan.allowedOrigins and the environment policy.",
          "Each step needs a unique identifier, a human-readable title, and onFailure stop or continue.",
        ],
      },
      "Protocol v2 authoring guide returned. Add semantic readiness before final evidence and use credential IDs for protected fill actions.",
    ),
  );

  server.registerTool(
    "validate_test_plan",
    {
      title: "Validate test plan",
      description:
        "Validate a v1 or v2 plan against schema, selected environment policy, credential availability, and conclusive-evidence risks before saving or running it.",
      inputSchema: {
        projectId: id,
        environmentId: id,
        plan: testPlanSchema,
      },
      annotations: readAnnotations,
    },
    async ({ projectId, environmentId, plan }) => {
      const [environments, credentials] = await Promise.all([
        client.get<Array<{ id: string; policy: unknown; secretRefs: string[] }>>(
          `/projects/${projectId}/environments`,
        ),
        client.get<Array<{ id: string }>>(`/projects/${projectId}/credentials`),
      ]);
      const environment = environments.find((item) => item.id === environmentId);
      if (!environment) throw new Error("Environment does not belong to the project.");
      const policy = executionPolicyV1Schema.parse(environment.policy);
      const violations: Array<{ code: string; message: string }> = [
        ...validatePlanAgainstPolicy(plan, policy),
      ];
      const activeCredentialIds = new Set(credentials.map((credential) => credential.id));
      const environmentCredentialIds = new Set(environment.secretRefs ?? []);
      const secretRefs = [...new Set(plan.steps.flatMap((step) =>
        step.action.type === "fill" && step.action.secretRef ? [step.action.secretRef] : [],
      ))];
      for (const secretRef of secretRefs) {
        if (!activeCredentialIds.has(secretRef)) {
          violations.push({
            code: "CREDENTIAL_UNAVAILABLE",
            message: `Protected credential "${secretRef}" is invalid or unavailable for this project.`,
          });
        } else if (!environmentCredentialIds.has(secretRef)) {
          violations.push({
            code: "CREDENTIAL_NOT_ALLOWED",
            message: `Protected credential "${secretRef}" is not available in the selected Flow environment.`,
          });
        }
      }
      const risks = analyzePlanRisks(plan);
      const errors = [
        ...violations.map((violation) => ({ severity: "error" as const, ...violation, suggestion: "Update the plan or selected environment policy." })),
        ...risks.errors,
      ];
      return result(
        { valid: errors.length === 0, errors, warnings: risks.warnings, violations },
        errors.length === 0
          ? `Plan is valid with ${plan.steps.length} executable steps and ${risks.warnings.length} warnings.`
          : `Plan was rejected with ${errors.length} errors. Apply each suggested correction before saving or running.`,
      );
    },
  );

  server.registerTool(
    "submit_test_spec",
    {
      title: "Create a new Flow",
      description:
        "Exceptionally create a genuinely distinct user journey. This tool rechecks the complete Flow list and rejects unreviewed or duplicate Flows. A failed run, corrected plan, additional coverage, or retry is never a reason to call this tool; use revise_flow, start_run, or rerun_exact_plan.",
      inputSchema: {
        projectId: id,
        reviewedExistingFlowIds: z
          .array(id)
          .max(500)
          .describe("Every Flow ID returned by the immediately preceding list_flows call."),
        newFlowJustification: z
          .string()
          .trim()
          .min(30)
          .max(1_000)
          .describe("Why this is a genuinely distinct user journey that cannot be represented as a revision of any existing Flow."),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(""),
        objective: z.string().trim().min(1).max(2_000),
        expectedOutcomes: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
        preconditions: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
        prohibitedSideEffects: z
          .array(z.string().trim().min(1).max(2_000))
          .max(50)
          .default([]),
        plan: testPlanSchema,
      },
      annotations: writeAnnotations,
    },
    async ({
      projectId,
      reviewedExistingFlowIds,
      newFlowJustification,
      name,
      description,
      objective,
      expectedOutcomes,
      preconditions,
      prohibitedSideEffects,
      plan,
    }) => {
      const existingFlows = await client.get<Array<{ id: string; name: string }>>(
        `/projects/${projectId}/specifications`,
      );
      const existingIds = new Set(existingFlows.map((flow) => flow.id));
      const reviewedIds = new Set(reviewedExistingFlowIds);
      const missingReviews = [...existingIds].filter((flowId) => !reviewedIds.has(flowId));
      const unknownReviews = [...reviewedIds].filter((flowId) => !existingIds.has(flowId));
      if (missingReviews.length > 0 || unknownReviews.length > 0) {
        throw new Error(
          "New Flow rejected: the project Flow list changed or was not reviewed completely. Call list_flows again, inspect every Flow, and pass exactly the returned Flow IDs. Revise an existing Flow when the journey overlaps.",
        );
      }
      const duplicate = existingFlows.find(
        (flow) => normalizeFlowName(flow.name) === normalizeFlowName(name),
      );
      if (duplicate) {
        throw new Error(
          `New Flow rejected: "${name}" matches existing Flow ${duplicate.id}. Use revise_flow for that Flow, then start_run with its new plan version.`,
        );
      }
      const specification = await client.post<{ id: string }>(
        `/projects/${projectId}/specifications`,
        { name, description },
      );
      const version = await client.post<{ id: string }>(
        `/specifications/${specification.id}/versions`,
        { objective, expectedOutcomes, preconditions, prohibitedSideEffects },
      );
      const planVersion = await client.post<{ id: string; version: number }>(
        "/plans/versions",
        { specificationVersionId: version.id, plan },
      );
      return result(
        {
          specificationId: specification.id,
          specificationVersionId: version.id,
          planVersionId: planVersion.id,
          planVersion: planVersion.version,
        },
        `Created distinct Flow ${name} as executable plan version ${planVersion.version}. Reason recorded by the agent: ${newFlowJustification}`,
      );
    },
  );

  server.registerTool(
    "revise_flow",
    {
      title: "Revise an existing Flow",
      description:
        "Update an existing Flow and append a new immutable specification and plan version. Use this for changed steps, locators, assertions, URLs, credential references, or requirements. It preserves the Flow identity and does not start a run.",
      inputSchema: {
        specificationId: id,
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(""),
        objective: z.string().trim().min(1).max(2_000),
        expectedOutcomes: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
        preconditions: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
        prohibitedSideEffects: z
          .array(z.string().trim().min(1).max(2_000))
          .max(50)
          .default([]),
        plan: testPlanSchema,
      },
      annotations: writeAnnotations,
    },
    async ({
      specificationId,
      name,
      description,
      objective,
      expectedOutcomes,
      preconditions,
      prohibitedSideEffects,
      plan,
    }) => {
      await client.patch(`/specifications/${specificationId}`, { name, description });
      const version = await client.post<{ id: string }>(
        `/specifications/${specificationId}/versions`,
        { objective, expectedOutcomes, preconditions, prohibitedSideEffects },
      );
      const planVersion = await client.post<{ id: string; version: number }>(
        "/plans/versions",
        { specificationVersionId: version.id, plan },
      );
      return result(
        {
          specificationId,
          specificationVersionId: version.id,
          planVersionId: planVersion.id,
          planVersion: planVersion.version,
        },
        `Revised existing Flow ${name} with executable plan version ${planVersion.version}. Use this planVersionId for the next run.`,
      );
    },
  );

  server.registerTool(
    "extend_flow",
    {
      title: "Continue an existing Flow",
      description:
        "Append actions to the latest version of an existing Flow while automatically preserving every earlier action. Use when the new work continues the same dependent journey and one future run should record it end to end. Do not use for an independently runnable audit or journey; create a distinct Flow for that.",
      inputSchema: {
        projectId: id,
        specificationId: id,
        objectiveAddition: z.string().trim().max(2_000).default(""),
        additionalExpectedOutcomes: z
          .array(z.string().trim().min(1).max(2_000))
          .max(50)
          .default([]),
        additionalPreconditions: z
          .array(z.string().trim().min(1).max(2_000))
          .max(20)
          .default([]),
        additionalProhibitedSideEffects: z
          .array(z.string().trim().min(1).max(2_000))
          .max(50)
          .default([]),
        additionalAllowedOrigins: z.array(z.string().url()).max(20).default([]),
        appendedSteps: testPlanV2Schema.shape.steps.min(1),
        budgets: testPlanV2Schema.shape.budgets.optional(),
      },
      annotations: writeAnnotations,
    },
    async ({
      projectId,
      specificationId,
      objectiveAddition,
      additionalExpectedOutcomes,
      additionalPreconditions,
      additionalProhibitedSideEffects,
      additionalAllowedOrigins,
      appendedSteps,
      budgets,
    }) => {
      type Plan = z.infer<typeof testPlanV2Schema>;
      type Content = {
        objective: string;
        expectedOutcomes: string[];
        preconditions?: string[];
        prohibitedSideEffects?: string[];
      };
      type Flow = {
        id: string;
        name: string;
        latestContent?: Content;
        latestPlan?: Plan;
      };
      const flows = await client.get<Flow[]>(`/projects/${projectId}/specifications`);
      const flow = flows.find((candidate) => candidate.id === specificationId);
      if (!flow?.latestPlan || !flow.latestContent) {
        throw new Error("Flow cannot be extended because its latest plan version is unavailable.");
      }
      if (flow.latestPlan.protocolVersion !== "2") {
        throw new Error("Flow must be revised to protocol v2 before it can be extended with readiness-aware steps.");
      }
      const existingStepIds = new Set(flow.latestPlan.steps.map((step) => step.id));
      const duplicateStepId = appendedSteps.find((step) => existingStepIds.has(step.id))?.id;
      if (duplicateStepId) {
        throw new Error(
          `Flow extension rejected: step ID "${duplicateStepId}" already exists. Appended steps need new stable IDs.`,
        );
      }
      const combinedSteps = [...flow.latestPlan.steps, ...appendedSteps];
      const combinedPlan: Plan = testPlanV2Schema.parse({
        ...flow.latestPlan,
        objective: appendSentence(flow.latestPlan.objective, objectiveAddition),
        allowedOrigins: unique([
          ...flow.latestPlan.allowedOrigins,
          ...additionalAllowedOrigins,
        ]),
        budgets: budgets ?? {
          ...flow.latestPlan.budgets,
          maxActions: Math.max(flow.latestPlan.budgets.maxActions, combinedSteps.length),
        },
        steps: combinedSteps,
      });
      const combinedContent = {
        objective: appendSentence(flow.latestContent.objective, objectiveAddition),
        expectedOutcomes: unique([
          ...flow.latestContent.expectedOutcomes,
          ...additionalExpectedOutcomes,
        ]),
        preconditions: unique([
          ...(flow.latestContent.preconditions ?? []),
          ...additionalPreconditions,
        ]),
        prohibitedSideEffects: unique([
          ...(flow.latestContent.prohibitedSideEffects ?? []),
          ...additionalProhibitedSideEffects,
        ]),
      };
      const version = await client.post<{ id: string }>(
        `/specifications/${specificationId}/versions`,
        combinedContent,
      );
      const planVersion = await client.post<{ id: string; version: number }>(
        "/plans/versions",
        { specificationVersionId: version.id, plan: combinedPlan },
      );
      return result(
        {
          specificationId,
          specificationVersionId: version.id,
          planVersionId: planVersion.id,
          planVersion: planVersion.version,
          preservedStepCount: flow.latestPlan.steps.length,
          appendedStepCount: appendedSteps.length,
          combinedPlan,
        },
        `Extended ${flow.name}: preserved ${flow.latestPlan.steps.length} earlier steps and appended ${appendedSteps.length}. Validate the returned combinedPlan, then run plan version ${planVersion.version}.`,
      );
    },
  );

  server.registerTool(
    "start_run",
    {
      title: "Start browser run",
      description:
        "Create and asynchronously queue a browser run for a stored plan version and approved environment.",
      inputSchema: {
        projectId: id,
        environmentId: id,
        planVersionId: id,
        viewport: z
          .object({
            width: z.number().int().min(320).max(3_840),
            height: z.number().int().min(320).max(2_160),
          })
          .default({ width: 1280, height: 720 }),
        seed: z.number().int().min(0).max(4_294_967_295).default(1),
      },
      annotations: writeAnnotations,
    },
    async ({ projectId, environmentId, planVersionId, viewport, seed }) => {
      const run = await client.post<{ id: string; state: string }>(
        `/projects/${projectId}/runs`,
        { environmentId, planVersionId, browser: "chromium", viewport, seed },
      );
      await client.post(`/runs/${run.id}/start`);
      return result(
        { runId: run.id, state: "queued" },
        `Queued run ${run.id}. Poll get_run_status; do not resubmit the run.`,
      );
    },
  );

  server.registerTool(
    "get_run_status",
    {
      title: "Get run status",
      description: "Read the current state and immutable configuration of an asynchronous run.",
      inputSchema: { runId: id },
      annotations: readAnnotations,
    },
    async ({ runId }) => {
      const run = await client.get<Record<string, unknown>>(`/runs/${runId}`);
      const classification = run.outcomeClassification
        ? ` Its outcome classification is ${String(run.outcomeClassification)}.`
        : "";
      return result({ run }, `Run ${runId} is ${String(run.state)}.${classification}`);
    },
  );

  server.registerTool(
    "get_test_report",
    {
      title: "Get test report",
      description:
        "Retrieve the durable run report with attempts, events, assertions, diagnostics, and artifact metadata.",
      inputSchema: { runId: id },
      annotations: readAnnotations,
    },
    async ({ runId }) => {
      const report = await client.get<Record<string, unknown>>(`/runs/${runId}/report`);
      return result({ report }, summarizeReport(report));
    },
  );

  server.registerTool(
    "list_failed_steps",
    {
      title: "List failed steps",
      description: "Extract actionable failed browser steps and failed assertions from a run.",
      inputSchema: { runId: id },
      annotations: readAnnotations,
    },
    async ({ runId }) => {
      const report = await client.get<{
        events: Array<{ type: string; payload: Record<string, unknown> }>;
        assertions: Array<Record<string, unknown> & { status: string }>;
      }>(`/runs/${runId}/report`);
      const steps = report.events
        .filter((event) => event.type === "step.failed")
        .map((event) => event.payload);
      const assertions = report.assertions.filter(
        (assertion) => assertion.status === "failed",
      );
      return result(
        { steps, assertions },
        `Found ${steps.length} failed steps and ${assertions.length} failed assertions.`,
      );
    },
  );

  server.registerTool(
    "list_run_artifacts",
    {
      title: "List run artifacts",
      description:
        "List run evidence with URLs for screenshots, DOM, network captures, and Playwright traces.",
      inputSchema: { runId: id },
      annotations: readAnnotations,
    },
    async ({ runId }) => {
      const report = await client.get<{
        artifacts: Array<Record<string, unknown> & { id: string; status: string }>;
      }>(`/runs/${runId}/report`);
      const artifacts = report.artifacts.map((artifact) => ({
        ...artifact,
        ...(artifact.status === "available"
          ? { url: client.artifactUrl(artifact.id) }
          : {}),
      }));
      return result({ artifacts }, `Found ${artifacts.length} run artifacts.`);
    },
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Read run artifact",
      description:
        "Read an authenticated run artifact through MCP. Returns screenshots as image content, text evidence as text, and recordings/traces as embedded binary resources.",
      inputSchema: { artifactId: id },
      annotations: readAnnotations,
    },
    async ({ artifactId }) => {
      const artifact = await client.getArtifact(artifactId);
      if (artifact.data.byteLength > 50 * 1024 * 1024) {
        throw new Error("Artifact exceeds the 50 MB MCP transfer limit.");
      }
      const encoded = Buffer.from(artifact.data).toString("base64");
      if (artifact.contentType.startsWith("image/")) {
        return {
          content: [{ type: "image" as const, data: encoded, mimeType: artifact.contentType }],
        };
      }
      if (
        artifact.contentType.startsWith("text/")
        || artifact.contentType.includes("json")
        || artifact.contentType.includes("xml")
      ) {
        return {
          content: [{ type: "text" as const, text: new TextDecoder().decode(artifact.data) }],
        };
      }
      return {
        content: [{
          type: "resource" as const,
          resource: {
            uri: `scry://artifacts/${artifactId}`,
            mimeType: artifact.contentType,
            blob: encoded,
          },
        }],
      };
    },
  );

  server.registerTool(
    "rerun_exact_plan",
    {
      title: "Rerun exact plan",
      description:
        "Queue a new run using the source run's immutable plan and configuration snapshots. Use after fixing the application.",
      inputSchema: { runId: id },
      annotations: writeAnnotations,
    },
    async ({ runId }) => {
      const run = await client.post<{ id: string }>(`/runs/${runId}/rerun`);
      return result(
        { runId: run.id, sourceRunId: runId, state: "queued" },
        `Queued exact rerun ${run.id} from ${runId}.`,
      );
    },
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel browser run",
      description: "Request cancellation of a queued or active browser run.",
      inputSchema: { runId: id },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) => {
      const run = await client.post<Record<string, unknown>>(`/runs/${runId}/cancel`);
      return result({ run }, `Cancellation requested for run ${runId}.`);
    },
  );

  return server;
}

function normalizeFlowName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function appendSentence(current: string, addition: string) {
  return addition ? `${current.trim()} ${addition.trim()}` : current;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function result(structuredContent: Record<string, unknown>, text: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
  };
}

function summarizeReport(report: Record<string, unknown>) {
  const run = report.run as Record<string, unknown> | undefined;
  const assertions = Array.isArray(report.assertions) ? report.assertions : [];
  const failed = assertions.filter(
    (assertion) =>
      assertion &&
      typeof assertion === "object" &&
      "status" in assertion &&
      assertion.status === "failed",
  ).length;
  const classification = String(run?.outcomeClassification ?? "");
  const prefix = `Run ${String(run?.id ?? "")} is ${String(run?.state ?? "unknown")} with ${failed} failed assertions.`;
  switch (classification) {
    case "readiness_timeout":
      return `${prefix} The configured ready state timed out. A linked confirmation may establish timing reproducibility, but readiness timeouts do not by themselves validate the expectation or prove a product defect.`;
    case "transient_observation":
      return `${prefix} This is an intentional intermediate-state observation and cannot prove completed-state behavior.`;
    case "inconclusive_plan":
      return `${prefix} The plan did not collect enough readiness or assertion proof for a product-level conclusion.`;
    case "non_reproduced_failure":
      return `${prefix} The timing-controlled confirmation passed, so the original observation was not reproduced.`;
    case "confirmed_product_failure":
      return `${prefix} Readiness succeeded and a linked timing-controlled confirmation reproduced the semantic assertion failure.`;
    case "infrastructure_failure":
      return `${prefix} This is a Scry infrastructure failure, not a tested-product conclusion.`;
    case "policy_failure":
      return `${prefix} Execution was blocked by Scry policy, not by tested-product behavior.`;
    default:
      return prefix;
  }
}
