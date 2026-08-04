import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LocalArtifactStore,
  VeilEvidenceAdmissionError,
  type VeilEvidenceAdmissionProof,
} from "@scry/artifact";
import {
  currentPlanSchema,
  executionPolicySchema,
  type Artifact,
  type Assertion,
  type InteractionTargetIntent,
  type ProtectedTransaction,
} from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
import { compileVeilPolicy } from "@scry/veil";
import { chromium, type CDPSession } from "playwright";
import { unzipSync } from "fflate";

import { executePlan } from "../src/executor.js";
import { availableArtifact, registerVeilEvidenceAdmission } from "../src/artifacts.js";
import { BrowserSessionProvenance } from "../src/browser-session.js";
import { resolveTargetLocator } from "@scry/praxis";
import { VeilAuthority } from "@scry/veil";
import { VeilChannelCollector } from "@scry/veil";
import { VeilRuntimeCoordinator } from "@scry/veil";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import {
  PlaywrightProtectedCapsuleFactory,
  ProtectedTransactionKernel,
  type MutationLedgerState,
} from "../src/protected-transaction-coordinator.js";
import { VeilVisualCaptureAuthority } from "@scry/veil";
import { VeilVideoSegmentAuthority } from "@scry/veil";

type Check = { name: string; status: "passed" | "failed"; diagnostic?: string };

const admissionKey = "veil-production-campaign-admission-key-32-bytes";
const canarySurfaces = [
  "dom-text",
  "dom-attribute",
  "accessibility",
  "console",
  "page-error",
  "request",
  "response",
  "canvas",
  "svg",
  "webgl",
  "video",
  "clipboard",
  "download",
  "filename",
  "trace",
  "cache",
  "diagnostic",
  "report",
  "memory-observable",
] as const;
type CanarySurface = (typeof canarySurfaces)[number];
const surfaceCanaries = Object.fromEntries(
  canarySurfaces.map((surface) => [
    surface,
    `VEIL_${surface.toUpperCase().replaceAll("-", "_")}_${randomUUID()}`,
  ]),
) as Record<CanarySurface, string>;
const checks: Check[] = [];
const replicas = [
  "credential",
  "payment",
  "recovery",
  "health",
  "financial",
  "upload-download",
  "cross-origin-authentication",
  "protected-generated-value",
] as const;
type Replica = (typeof replicas)[number];

const replicaFlows: Record<
  Replica,
  { field: string; label: string; value: string; submit: string; result: string }
> = {
  credential: {
    field: "account",
    label: "Account alias",
    value: "campaign-user",
    submit: "Verify credential",
    result: "Credential verified",
  },
  payment: {
    field: "invoice",
    label: "Invoice reference",
    value: "INV-2048",
    submit: "Authorize payment",
    result: "Payment authorized",
  },
  recovery: {
    field: "recovery",
    label: "Recovery address",
    value: "synthetic@example.test",
    submit: "Send recovery",
    result: "Recovery requested",
  },
  health: {
    field: "visit",
    label: "Visit reference",
    value: "VISIT-42",
    submit: "Confirm health consent",
    result: "Health consent recorded",
  },
  financial: {
    field: "portfolio",
    label: "Portfolio alias",
    value: "demo-growth",
    submit: "Generate financial preview",
    result: "Financial preview generated",
  },
  "upload-download": {
    field: "filename",
    label: "Synthetic filename",
    value: "safe-sample.txt",
    submit: "Process transfer",
    result: "Transfer processed",
  },
  "cross-origin-authentication": {
    field: "tenant",
    label: "Tenant alias",
    value: "example-tenant",
    submit: "Continue authentication",
    result: "Authentication boundary completed",
  },
  "protected-generated-value": {
    field: "purpose",
    label: "Generated value purpose",
    value: "test-session",
    submit: "Generate protected value",
    result: "Protected value generated",
  },
};

async function main() {
  const crossServer = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    if (request.url === "/auth-popup") {
      response.end(
        `<button id="approve">Approve synthetic identity</button><script>approve.onclick=()=>{opener.postMessage({type:'veil-auth',phase:'popup-approved'},'*');close()}</script>`,
      );
      return;
    }
    response.end(
      `<body style="margin:0;background:rgb(255,0,255)"><div data-canary=${JSON.stringify(surfaceCanaries["dom-attribute"])}>${surfaceCanaries["dom-text"]}</div></body>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    crossServer.once("error", reject);
    crossServer.listen(0, "127.0.0.1", resolve);
  });
  const crossAddress = crossServer.address();
  if (!crossAddress || typeof crossAddress === "string")
    throw new Error("cross-origin replica unavailable");
  const crossOrigin = `http://127.0.0.1:${crossAddress.port}`;
  const sessions = new Map<string, Partial<Record<Replica, number>>>();
  let uploadedBytes = Buffer.alloc(0);
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://local");
    if (requestUrl.pathname === "/ping") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(surfaceCanaries.response);
      return;
    }
    if (requestUrl.pathname === "/literal-upload" && request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        uploadedBytes = Buffer.concat(chunks);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          `<p id="upload-received">${uploadedBytes.byteLength}</p><a id="literal-download" download="sanitized-receipt.txt" href="data:text/plain,sanitized-transfer-receipt">Download sanitized receipt</a>`,
        );
      });
      return;
    }
    const replica = replicas.find((id) => requestUrl.pathname === `/replica/${id}`) ?? "credential";
    const sessionId =
      /(?:^|;\s*)veil-session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? randomUUID();
    const state = sessions.get(sessionId) ?? {};
    if (request.method === "POST") state[replica] = (state[replica] ?? 0) + 1;
    sessions.set(sessionId, state);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": `veil-session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
    });
    response.end(fixture(surfaceCanaries, crossOrigin, replica, state[replica] ?? 0));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("campaign HTTP server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const executionRoot = await mkdtemp(path.join(tmpdir(), "scry-veil-production-executor-"));
  const videoRoot = await mkdtemp(path.join(tmpdir(), "scry-veil-production-video-"));
  const storageRoot = await mkdtemp(path.join(tmpdir(), "scry-veil-production-store-"));

  try {
    const plan = currentPlanSchema.parse({
      name: "Veil production evidence lifecycle",
      objective: "Capture privacy-safe evidence through the production executor",
      allowedOrigins: [origin],
      budgets: {
        maxActions: replicas.length * 3,
        maxDurationMs: 120_000,
        maxNavigations: replicas.length,
      },
      checkpoints: [],
      steps: replicas.flatMap((replica) => replicaSteps(origin, replica)),
    });
    const report = await executePlan({
      plan,
      policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
      outputDirectory: executionRoot,
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      veilAdmissionKey: admissionKey,
    });
    verify("executor completed", () =>
      requireValue(report.state === "passed", `state was ${report.state}`),
    );
    verify("all controlled replica HTTP workflows committed server state", () =>
      requireValue(
        [...sessions.values()].some((state) =>
          replicas.every((replica) => (state[replica] ?? 0) === 1),
        ),
        `server transitions were incomplete: ${JSON.stringify([...sessions.values()])}`,
      ),
    );
    verify("execution report and diagnostics exclude every independent surface canary", () =>
      requireValue(
        allCanariesAbsent(JSON.stringify(report)),
        "execution report retained a surface canary",
      ),
    );
    const protectedFlow = await inspectRealProtectedTransaction();
    verify("protected transaction safe summary excludes protected value", () =>
      requireValue(
        !JSON.stringify(protectedFlow.summary).includes(protectedFlow.protectedValue),
        "protected value entered campaign summary",
      ),
    );
    await inspectLiteralTransferAndCrossOriginFlows(origin, crossOrigin, () => uploadedBytes);
    await inspectBrowserCapabilityTeardown(origin, report);

    const artifacts = report.artifacts.filter((artifact) => artifact.availability === "available");
    await inspectAllRetainedSurfaces(executionRoot, report.artifacts, report);
    verify("executor produced admitted evidence", () =>
      requireValue(artifacts.length > 0, "no available artifact"),
    );
    const screenshots = artifacts.filter((artifact) => artifact.kind === "screenshot");
    verify("all controlled replicas produced admitted screenshots", () =>
      requireValue(
        screenshots.length === replicas.length,
        `expected ${replicas.length} screenshots, got ${screenshots.length}`,
      ),
    );
    for (const screenshot of screenshots) await inspectScreenshot(executionRoot, screenshot);
    const videoReport = await executePlan({
      plan: currentPlanSchema.parse({
        name: "Veil stable video",
        objective: "Qualify continuous admitted video",
        allowedOrigins: [origin],
        budgets: { maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
        checkpoints: [],
        steps: [
          {
            id: "stable-video",
            title: "Stable video replica",
            action: { type: "navigate", url: `${origin}/replica/credential` },
            after: {
              mode: "all",
              timeoutMs: 5_000,
              conditions: [{ type: "delay", durationMs: 500 }],
            },
            assertions: [{ type: "url", expected: "/replica/credential", match: "path" }],
            evidence: [],
            onFailure: "stop",
            captureIntent: "final",
          },
        ],
      }),
      policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
      outputDirectory: videoRoot,
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      veilAdmissionKey: admissionKey,
    });
    const video = videoReport.artifacts.find(
      (artifact) => artifact.kind === "video" && artifact.availability === "available",
    );
    verify("video admitted through continuous segment authority", () =>
      requireValue(
        Boolean(video),
        `no admitted video artifact: ${JSON.stringify(report.artifacts.filter((artifact) => artifact.kind === "video").map((artifact) => ({ availability: artifact.availability, reasonCode: artifact.reasonCode, observation: artifact.observation })))}`,
      ),
    );
    if (video) await inspectVideo(videoRoot, video);

    const store = new LocalArtifactStore(storageRoot, admissionKey);
    for (const artifact of artifacts)
      await verifyArtifactLifecycle(store, executionRoot, storageRoot, artifact);
    if (video) await verifyArtifactLifecycle(store, videoRoot, storageRoot, video);
    verify("protected transaction value is absent from all admitted executor artifacts", () =>
      requireValue(
        !JSON.stringify(report.artifacts).includes(protectedFlow.protectedValue),
        "protected value entered artifact metadata",
      ),
    );

    const reportValue = {
      schemaVersion: 1,
      campaign: "veil-production-e2e",
      executedAt: new Date().toISOString(),
      environment: {
        transport: "real_http",
        browser: "production_executor_real_chrome",
        browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
        storage: "LocalArtifactStore",
      },
      counts: {
        total: checks.length,
        passed: checks.filter((item) => item.status === "passed").length,
        failed: checks.filter((item) => item.status === "failed").length,
        skipped: 0,
      },
      lifecycle: [
        "executor_capture",
        "veil_classification",
        "veil_permit",
        "signed_admission",
        "storage",
        "verified_retrieval",
        "tamper_refusal",
        "destruction",
      ],
      coverage: {
        canarySurfaces,
        refusalChecks: [
          "forged-admission-token",
          "stored-byte-tampering",
          "post-destruction-retrieval",
        ],
        controlledReplicas: replicas,
        controlledReplicaExecution:
          "distinct_executePlan_fill_submit_server_transition_assert_capture_flows",
        coveredByCompanionCampaigns: {
          traceArchive: "veil-adversarial",
          crossOriginAuthentication: "veil-release-scope",
          processCrashAndRecovery: "veil-release-scope-and-docker-topology",
          multiProcessTopology: "docker-publish-production-topology",
          upgradeAndRollback: "verify-veil-release-transition",
        },
      },
      qualification: checks.some((item) => item.status === "failed")
        ? "PRODUCTION_EXECUTOR_FAIL"
        : "PRODUCTION_EXECUTOR_PASS",
      readiness: checks.some((item) => item.status === "failed")
        ? "NOT_READY"
        : "PASSED_AS_COMBINED_CAMPAIGN_COMPONENT",
      checks,
    };
    if (reportValue.counts.failed > 0)
      process.stderr.write(
        `${JSON.stringify({ executorError: report.error, failedChecks: checks.filter((item) => item.status === "failed") })}\n`,
      );
    process.stdout.write(`${JSON.stringify(reportValue, null, 2)}\n`);
    process.exitCode = reportValue.counts.failed > 0 ? 1 : 0;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => crossServer.close(() => resolve()));
  }
}

async function inspectRealProtectedTransaction() {
  const protectedValue = `VEIL_PROTECTED_${randomUUID()}`;
  const publicValue = `public-${randomUUID()}`;
  let dispatches = 0;
  const server = createServer((request, response) => {
    if (request.url === "/created" && request.method === "POST") {
      dispatches += 1;
      response.writeHead(204).end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/safe") {
      response.end("<main>Safe continuation</main>");
      return;
    }
    response.end(
      `<label>Name<input></label><button>Generate</button><output aria-label="Public identifier"></output><div role="group"><output aria-label="Protected generated value" data-scry-redacted="true"></output><button aria-label="Copy protected generated value">Copy</button></div><script>document.querySelector('button').onclick=()=>fetch('/created',{method:'POST'}).then(()=>{document.querySelector('[aria-label="Public identifier"]').textContent=${JSON.stringify(publicValue)};document.querySelector('[aria-label="Protected generated value"]').textContent='ready'});document.querySelector('[aria-label="Copy protected generated value"]').onclick=()=>navigator.clipboard.writeText(${JSON.stringify(protectedValue)})</script>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  requireValue(address && typeof address !== "string", "protected transaction server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/safe`);
    const collector = new VeilChannelCollector("protected-campaign-evidence");
    const gate = new VeilRuntimeCoordinator([
      {
        name: "protected-campaign-evidence",
        arm: (id, policy) => collector.arm(id, policy),
        suspend: () => collector.suspend(),
        isolate: () => collector.isolate(),
        resume: (binding) => collector.resume(binding),
        seal: (reason) => collector.seal(reason),
        finalize: () => collector.finalize(),
        state: () => collector.state(),
      },
    ]);
    let ledger: MutationLedgerState = "planned";
    const secrets: string[] = [];
    const publics: string[] = [];
    const transaction = protectedCampaignTransaction(origin);
    const authority = new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
    );
    const result = await new ProtectedTransactionKernel({
      safeSession: {
        browser,
        context,
        page,
        provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
      },
      gate,
      redactor: new SecretRedactor(),
      store: {
        claim: async () => ({ state: ledger, fencingToken: 1 }),
        transition: async ({ expected, next }) => {
          if (ledger !== expected) return false;
          ledger = next;
          return true;
        },
        record: async () => undefined,
      },
      capsuleFactory: new PlaywrightProtectedCapsuleFactory(),
      allowedOrigins: [origin],
      prepareCapsule: async (session) => {
        await session.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        registerPraxisVeilAuthority(session.page, {
          authority,
          userId: "campaign",
          environmentId: "local",
          browserContextId: session.provenance.contextId,
        });
      },
      resolveKnownSecret: async () => "",
      persistSecret: async ({ value }) => {
        secrets.push(value);
        return { credentialId: randomUUID() };
      },
      persistPublicValue: async ({ value }) => {
        publics.push(value);
        return { valueId: randomUUID() };
      },
      verifyAssertions: verifyProtectedAssertions,
      verifyCalibration: async () => undefined,
    }).execute(transaction);
    verify("real protectedTransaction completed one-time capsule mutation", () =>
      requireValue(
        result.result.status === "completed" &&
          dispatches === 1 &&
          result.result.capsule === "destroyed",
        `protected transaction result: ${JSON.stringify(result.result)}`,
      ),
    );
    verify("protected generated value reached only persistSecret boundary", () =>
      requireValue(
        secrets.length === 1 && secrets[0] === protectedValue && !publics.includes(protectedValue),
        "protected persistence routing failed",
      ),
    );
    verify("public generated value reached public capture persistence equivalent", () =>
      requireValue(
        publics.length === 1 && publics[0] === publicValue && !secrets.includes(publicValue),
        "public persistence routing failed",
      ),
    );
    verify("protected capsule was destroyed and evidence resumed without secret transfer", () =>
      requireValue(
        result.result.capsule === "destroyed" &&
          result.result.evidence === "resumed" &&
          result.result.continuation === "parked_resumed",
        `unsafe protected continuation: ${JSON.stringify({ capsule: result.result.capsule, evidence: result.result.evidence, continuation: result.result.continuation })}`,
      ),
    );
    const admitted = await admitPostTransactionEvidence(
      result.safeSession,
      authority,
      origin,
      transaction.operationId,
      protectedValue,
    );
    return {
      protectedValue,
      summary: {
        status: result.result.status,
        publicValueCaptured: publics.length,
        protectedValuePersisted: secrets.length,
        dispatches,
        admittedChannels: admitted,
      },
    };
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function admitPostTransactionEvidence(
  session: {
    page: import("playwright").Page;
    context: import("playwright").BrowserContext;
    provenance: BrowserSessionProvenance;
  },
  authority: VeilAuthority,
  origin: string,
  transactionId: string,
  protectedValue: string,
) {
  const root = await mkdtemp(path.join(tmpdir(), "scry-veil-protected-evidence-"));
  const { page, context } = session;
  requireValue(!page.isClosed(), "resumed safe page is unavailable");
  const binding = {
    browserContextId: session.provenance.contextId,
    pageId: "protected-safe-page",
    frameId: "main",
    documentEpoch: 1,
  };
  const visual = new VeilVisualCaptureAuthority(authority.snapshot().digest);
  const videoAuthority = new VeilVideoSegmentAuthority(authority.snapshot().digest, visual);
  const unregister = registerVeilEvidenceAdmission({
    root,
    authority,
    admissionKey,
    context: () => ({
      userId: "campaign",
      environmentId: "local",
      transactionId,
      origin,
      browserContextId: binding.browserContextId,
      pageId: binding.pageId,
      frameId: binding.frameId,
      documentEpoch: binding.documentEpoch,
    }),
    visualAdmission: (permit) => visual.admissionBinding(permit),
    videoAdmission: (finalization) => videoAuthority.consumeFinalization(finalization),
  });
  const network: Array<{ url: string; status: number }> = [];
  page.on("response", (response) =>
    network.push({ url: response.url(), status: response.status() }),
  );
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.reload();
  await page.waitForTimeout(200);
  const files: Array<{
    channel: "screenshot" | "video" | "dom" | "network" | "trace" | "report";
    kind: Artifact["kind"];
    type: string;
    file: string;
    permit?: any;
    finalization?: any;
    sanitation?: any;
  }> = [];
  const screenshot = path.join(root, "transaction.png");
  const issued = await visual.issue(page, binding);
  await visual.capture(page, issued.permit, binding, () => page.screenshot({ path: screenshot }));
  files.push({
    channel: "screenshot",
    kind: "screenshot",
    type: "image/png",
    file: screenshot,
    permit: issued.permit,
  });
  const videoPermit = videoAuthority.issue("protected-safe-resume", binding);
  await videoAuthority.checkpoint(page, videoPermit, binding);
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const c = canvas.getContext("2d")!;
    c.fillStyle = "green";
    c.fillRect(0, 0, 320, 200);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: "video/webm" });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.start();
    await new Promise((r) => setTimeout(r, 250));
    recorder.stop();
    await new Promise((r) => (recorder.onstop = r));
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  const video = path.join(root, "transaction.webm");
  await writeFile(video, Buffer.from(videoBytes));
  files.push({
    channel: "video",
    kind: "video",
    type: "video/webm",
    file: video,
    finalization: videoAuthority.finalize(videoPermit, binding),
  });
  const redactor = new SecretRedactor();
  redactor.add(protectedValue);
  const sanitation = {
    stage: "post_capture",
    method: "SecretRedactor.redact",
    attestedAt: new Date().toISOString(),
  } as const;
  const dom = path.join(root, "transaction.html");
  await writeFile(dom, redactor.redact(await page.content()));
  files.push({ channel: "dom", kind: "dom", type: "text/html", file: dom, sanitation });
  const networkFile = path.join(root, "transaction-network.json");
  await writeFile(networkFile, JSON.stringify(network));
  files.push({ channel: "network", kind: "network", type: "application/json", file: networkFile });
  const trace = path.join(root, "transaction-trace.zip");
  await context.tracing.stop({ path: trace });
  files.push({ channel: "trace", kind: "trace", type: "application/zip", file: trace });
  const reportFile = path.join(root, "transaction-report.json");
  await writeFile(
    reportFile,
    JSON.stringify({
      transactionId,
      status: "completed",
      protected: "persisted_by_reference",
      public: "captured",
    }),
  );
  files.push({ channel: "report", kind: "report", type: "application/json", file: reportFile });
  const admitted: Artifact[] = [];
  try {
    for (const item of files)
      admitted.push(
        await availableArtifact(item.kind, item.type, item.file, undefined, {
          classification: "public",
          ...(item.permit ? { capturePermit: item.permit } : {}),
          ...(item.finalization ? { videoFinalization: item.finalization } : {}),
          ...(item.sanitation ? { sanitation: item.sanitation } : {}),
        }),
      );
  } finally {
    unregister();
  }
  for (let index = 0; index < files.length; index += 1) {
    const bytes = await readFile(files[index]!.file);
    const artifact = admitted[index]!;
    verify(
      `protected transaction ${files[index]!.channel} bytes exclude exact protected value`,
      () =>
        requireValue(
          !bytes.includes(Buffer.from(protectedValue)),
          `${files[index]!.channel} bytes retained protected value`,
        ),
    );
    verify(
      `protected transaction ${files[index]!.channel} manifest binds policy decision and transaction`,
      () => {
        const proof = artifact.observation as {
          veilManifest?: { policyDigest?: string; decisionId?: string; transactionId?: string };
        };
        requireValue(
          !JSON.stringify(proof).includes(protectedValue) &&
            proof.veilManifest?.transactionId === transactionId &&
            proof.veilManifest.policyDigest === authority.snapshot().digest &&
            Boolean(proof.veilManifest.decisionId),
          "transaction admission binding incomplete",
        );
      },
    );
  }
  return admitted.map((artifact) => artifact.kind);
}

function protectedCampaignTransaction(origin: string): ProtectedTransaction {
  const input = protectedIntent("Name", "textbox");
  const button = protectedIntent("Generate", "button");
  const publicOutput = protectedIntent("Public identifier", "value");
  const secretOutput = protectedIntent("Protected generated value", "value");
  const acquisition = (
    target: InteractionTargetIntent,
    classification: "public" | "unknown_secret",
  ) => ({
    target,
    classification,
    permittedMethods: [
      classification === "unknown_secret"
        ? ("copy_control" as const)
        : ("semantic_field_value" as const),
    ],
    validation: { minimumLength: 1, maximumLength: 200 },
  });
  return {
    type: "protectedTransaction",
    operationId: "production-protected-generation",
    entry: { url: `${origin}/new`, assertions: [{ type: "visible", target: input }] },
    inputs: { purpose: { classification: "public", value: "production-campaign" } },
    preparation: {
      effectPolicy: { ignoredRequests: [] },
      actions: [
        { type: "fillPublicInput", input: "purpose", target: input, effect: "replayable_setup" },
      ],
      assertions: [
        { type: "fieldValueMatchesInput", target: input, input: "purpose" },
        { type: "enabled", target: button },
      ],
    },
    mutation: {
      action: {
        type: "click",
        target: button,
        expectedEffect: { type: "new_region", target: secretOutput },
      },
      kind: "one_time",
      reconciliation: { strategy: "none", acceptUnknownOutcome: true },
    },
    extraction: {
      outputs: [
        {
          classification: "public",
          reference: "publicIdentifier",
          acquisition: acquisition(publicOutput, "public"),
          storage: { name: "Public identifier", scope: "run" },
        },
        {
          classification: "protected",
          reference: "generatedSecret",
          acquisition: acquisition(secretOutput, "unknown_secret"),
          storage: { credentialName: "Generated secret", scope: "project" },
        },
      ],
      timeoutMs: 5_000,
      scheduling: "fair_shared_timeout",
    },
    acquisitionReadiness: {
      ceremonyIntent: button,
      expectedContainerModel: {
        version: 2,
        digest: "a".repeat(64),
        concept: "Generated value form",
        scopeKind: "page",
        capabilityDigest: "b".repeat(64),
        structuralPath: [],
      },
      valueIntent: secretOutput,
      approvedMethods: ["semantic_field_value", "copy_control"],
      minimumConfidence: 0.45,
      minimumConfidenceMargin: 0,
      recoveryPolicy: "abandon",
      recoveryWindowMs: 1_000,
    },
    continuation: {
      strategies: [
        {
          mode: "resume_parked_context",
          reentryUrl: `${origin}/safe`,
          assertions: [{ type: "url", expected: "/safe", match: "path" }],
          continueAtStepId: "protected-complete",
        },
      ],
    },
  };
}

function protectedIntent(
  concept: string,
  role: "textbox" | "button" | "value",
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities:
      role === "textbox"
        ? ["focusable", "accepts_text", "editable", "readable_value"]
        : role === "button"
          ? ["pointer_activatable"]
          : ["readable_value"],
    preferredEvidence: {
      roles: [role],
      names: [concept],
      labels: role === "textbox" ? [concept] : [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "ordinary",
    confidence: { requiredFamilies: [], minimum: 0.45, minimumMargin: 0, minimumFamilyCount: 1 },
  };
}

async function verifyProtectedAssertions(page: import("playwright").Page, assertions: Assertion[]) {
  for (const assertion of assertions) {
    if (assertion.type === "url")
      requireValue(
        new URL(page.url()).pathname === assertion.expected,
        "protected continuation URL mismatch",
      );
    else if (assertion.type === "visible")
      requireValue(
        await (await resolveTargetLocator(page, assertion.target)).isVisible(),
        "protected target not visible",
      );
    else if (assertion.type === "value")
      requireValue(
        (await (await resolveTargetLocator(page, assertion.target)).inputValue()) ===
          assertion.expected,
        "protected value assertion mismatch",
      );
    else if (assertion.type === "text")
      requireValue(
        (await (await resolveTargetLocator(page, assertion.target)).textContent()) ===
          assertion.expected,
        "protected text assertion mismatch",
      );
  }
}

async function inspectLiteralTransferAndCrossOriginFlows(
  origin: string,
  crossOrigin: string,
  uploaded: () => Buffer,
) {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const transfer = await context.newPage();
    await transfer.setContent(
      `<form method="post" enctype="multipart/form-data" action="${origin}/literal-upload"><input id="actual-upload" name="payload" type="file"><button>Upload</button></form>`,
    );
    const uploadCanary = `VEIL_LITERAL_UPLOAD_${randomUUID()}`;
    await transfer.locator("#actual-upload").setInputFiles({
      name: "literal-campaign.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(uploadCanary),
    });
    await Promise.all([
      transfer.waitForNavigation(),
      transfer.getByRole("button", { name: "Upload" }).click(),
    ]);
    verify("literal file upload used browser setInputFiles and reached server bytes", () =>
      requireValue(
        uploaded().includes(Buffer.from(uploadCanary)),
        "uploaded multipart body did not reach server",
      ),
    );
    const downloadPromise = transfer.waitForEvent("download");
    await transfer.locator("#literal-download").click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    await verify("literal server response produced an actual sanitized download", async () =>
      requireValue(
        Boolean(downloadPath) &&
          (await readFile(downloadPath!)).toString() === "sanitized-transfer-receipt",
        "downloaded receipt bytes differ",
      ),
    );
    await download.delete();

    const auth = await context.newPage();
    await auth.goto(`${origin}/replica/cross-origin-authentication`);
    const frame = auth.frame({
      url: new RegExp(`^${crossOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    });
    verify("cross-origin authentication iframe loaded in a distinct origin", () =>
      requireValue(
        Boolean(frame) && new URL(frame!.url()).origin === crossOrigin,
        "identity frame origin missing",
      ),
    );
    await auth.evaluate((idp) => {
      (globalThis as typeof globalThis & { __veilAuthPhases?: string[] }).__veilAuthPhases = [];
      addEventListener("message", (event) => {
        if (event.origin === idp && event.data?.type === "veil-auth")
          (globalThis as typeof globalThis & { __veilAuthPhases: string[] }).__veilAuthPhases.push(
            event.data.phase,
          );
      });
    }, crossOrigin);
    await frame!.locator("body").click();
    await frame!.evaluate(() =>
      parent.postMessage({ type: "veil-auth", phase: "frame-approved" }, "*"),
    );
    await auth.waitForFunction(() =>
      (
        globalThis as typeof globalThis & { __veilAuthPhases?: string[] }
      ).__veilAuthPhases?.includes("frame-approved"),
    );
    const popupPromise = context.waitForEvent("page");
    await auth.evaluate(
      (url) => window.open(url, "veil-idp", "popup,width=500,height=400"),
      `${crossOrigin}/auth-popup`,
    );
    const popup = await popupPromise;
    await popup.getByRole("button", { name: "Approve synthetic identity" }).click();
    await auth.waitForFunction(() =>
      (
        globalThis as typeof globalThis & { __veilAuthPhases?: string[] }
      ).__veilAuthPhases?.includes("popup-approved"),
    );
    const phases = await auth.evaluate(
      () => (globalThis as typeof globalThis & { __veilAuthPhases?: string[] }).__veilAuthPhases,
    );
    verify("cross-origin auth completed iframe and popup postMessage transitions", () =>
      requireValue(
        phases?.join(",") === "frame-approved,popup-approved",
        `unexpected auth phases: ${JSON.stringify(phases)}`,
      ),
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

async function inspectBrowserCapabilityTeardown(origin: string, admittedReport: unknown) {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const context = await browser.newContext({
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const { VeilClipboardCollector } = await import("@scry/veil");
  const clipboardCollector = new VeilClipboardCollector(page);
  try {
    await page.goto(`${origin}/replica/credential`);
    await page.evaluate(
      (values) => {
        const node = document.createElement("button");
        node.setAttribute("aria-label", values.accessibility);
        node.textContent = "protected";
        document.body.appendChild(node);
        sessionStorage.setItem("veil-cache", values.cache);
        (
          globalThis as typeof globalThis & { __veilRetainedObject?: { secret: string } }
        ).__veilRetainedObject = { secret: values.memory };
      },
      {
        accessibility: surfaceCanaries.accessibility,
        cache: surfaceCanaries.cache,
        memory: surfaceCanaries["memory-observable"],
      },
    );
    const cdp = await context.newCDPSession(page);
    const target = await cdp.send("Target.getTargetInfo");
    const tree = await cdp.send("Accessibility.getFullAXTree");
    verify("real accessibility tree carries independent canary before Veil suppression", () =>
      requireValue(
        JSON.stringify(tree).includes(surfaceCanaries.accessibility),
        "accessibility canary fixture missing",
      ),
    );
    const liveHeap = await takeHeapSnapshot(cdp);
    verify("CDP heap snapshot observes protected retained-object canary before teardown", () =>
      requireValue(
        liveHeap.includes(surfaceCanaries["memory-observable"]),
        "live renderer heap snapshot omitted retained-object canary",
      ),
    );
    await page.evaluate((value) => navigator.clipboard.writeText(value), surfaceCanaries.clipboard);
    clipboardCollector.markProtectedClipboardTouched();
    await verify("authorized local clipboard write/read executed", async () =>
      requireValue(
        (await page.evaluate(() => navigator.clipboard.readText())) === surfaceCanaries.clipboard,
        "clipboard roundtrip failed",
      ),
    );
    const downloadPromise = page.waitForEvent("download");
    await page.evaluate(
      ({ bytes, filename }) => {
        const link = document.createElement("a");
        link.download = filename;
        link.href = `data:text/plain,${encodeURIComponent(bytes)}`;
        document.body.appendChild(link);
        link.click();
      },
      { bytes: surfaceCanaries.download, filename: `${surfaceCanaries.filename}.txt` },
    );
    const download = await downloadPromise;
    const downloadPath = await download.path();
    verify("actual download filename contains independent canary", () =>
      requireValue(
        download.suggestedFilename().includes(surfaceCanaries.filename),
        "download filename canary missing",
      ),
    );
    await verify(
      "actual downloaded bytes contain independent canary before destruction",
      async () =>
        requireValue(
          Boolean(downloadPath) &&
            (await readFile(downloadPath!)).includes(Buffer.from(surfaceCanaries.download)),
          "download byte canary missing",
        ),
    );
    const live = await page.evaluate(() => ({
      cache: sessionStorage.getItem("veil-cache"),
      memory: (globalThis as typeof globalThis & { __veilRetainedObject?: { secret: string } })
        .__veilRetainedObject?.secret,
    }));
    verify("live cache and JS memory observables independently contain test canaries", () =>
      requireValue(
        live.cache === surfaceCanaries.cache &&
          live.memory === surfaceCanaries["memory-observable"],
        "live retained fixture incomplete",
      ),
    );
    await download.delete();
    await clipboardCollector.finalize();
    await context.close();
    verify(
      "browser context teardown destroyed live cache memory clipboard and download realm",
      () => requireValue(page.isClosed(), "capability page survived context destruction"),
    );
    const targets = await browserCdp.send("Target.getTargets");
    verify(
      "renderer process target owning retained object is destroyed after context teardown",
      () =>
        requireValue(
          !targets.targetInfos.some((item) => item.targetId === target.targetInfo.targetId),
          "destroyed context renderer target remains live",
        ),
    );
    await verify("old renderer CDP session is inaccessible after context teardown", async () => {
      try {
        await cdp.send("Runtime.evaluate", { expression: "globalThis.__veilRetainedObject" });
        throw new Error("destroyed renderer session remained addressable");
      } catch (error) {
        requireValue(!String(error).includes("destroyed renderer session remained"), String(error));
      }
    });
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    const freshCdp = await freshContext.newCDPSession(freshPage);
    const freshHeap = await takeHeapSnapshot(freshCdp);
    verify("fresh renderer heap snapshot excludes destroyed context memory canary", () =>
      requireValue(
        !freshHeap.includes(surfaceCanaries["memory-observable"]),
        "memory canary survived in a fresh renderer heap snapshot",
      ),
    );
    await freshContext.close();
    verify("none of the 19 independent surface canaries entered admitted runtime evidence", () =>
      requireValue(
        allCanariesAbsent(JSON.stringify(admittedReport)),
        "surface canary entered admitted report",
      ),
    );
  } finally {
    await context.close().catch(() => undefined);
    checks.push(...(await inspectAndClearPlatformClipboard(browser, origin)));
    await browser.close();
  }
}

async function inspectAndClearPlatformClipboard(
  browser: import("playwright").Browser,
  origin: string,
): Promise<Check[]> {
  const results: Check[] = [];
  let probe: import("playwright").BrowserContext | undefined;
  let page: import("playwright").Page | undefined;
  try {
    probe = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    page = await probe.newPage();
    await page.goto(`${origin}/replica/credential`);
    const observed = await page.evaluate(() => navigator.clipboard.readText());
    results.push(
      observed.includes(surfaceCanaries.clipboard)
        ? {
            name: "fresh authorized browser context reads platform clipboard before mutation and proves exact canary did not survive teardown",
            status: "failed",
            diagnostic: "exact clipboard canary survived browser context teardown",
          }
        : {
            name: "fresh authorized browser context reads platform clipboard before mutation and proves exact canary did not survive teardown",
            status: "passed",
          },
    );
  } catch (error) {
    results.push({
      name: "fresh authorized browser context reads platform clipboard before mutation and proves exact canary did not survive teardown",
      status: "failed",
      diagnostic: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      requireValue(page, "clipboard cleanup page was unavailable");
      await page.evaluate(() => navigator.clipboard.writeText(""));
      const cleared = await page.evaluate(() => navigator.clipboard.readText());
      requireValue(
        cleared === "",
        `platform clipboard cleanup verification returned ${JSON.stringify(cleared)}`,
      );
      requireValue(
        !cleared.includes(surfaceCanaries.clipboard),
        "exact clipboard canary remained after explicit cleanup",
      );
      results.push({
        name: "mandatory clipboard cleanup separately writes and verifies empty platform state",
        status: "passed",
      });
    } catch (error) {
      results.push({
        name: "mandatory clipboard cleanup separately writes and verifies empty platform state",
        status: "failed",
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    }
    await probe?.close().catch(() => undefined);
  }
  return results;
}

async function inspectAllRetainedSurfaces(root: string, artifacts: Artifact[], report: unknown) {
  const metadata = JSON.stringify({ report, artifacts });
  verify(
    "metadata filenames diagnostics reports and retained observables exclude all surface canaries",
    () => requireValue(allCanariesAbsent(metadata), "metadata/report retained a surface canary"),
  );
  for (const artifact of artifacts.filter(
    (item) => item.availability === "available" && item.relativePath,
  )) {
    const bytes = await artifactBytes(root, artifact);
    verify(`${artifact.kind}: retained archive bytes exclude all surface canaries`, () =>
      requireValue(
        allCanariesAbsent(bytes),
        `${artifact.kind} raw bytes retained a surface canary`,
      ),
    );
    if (artifact.kind === "trace") {
      const archive = unzipSync(bytes);
      verify("trace archive decoded entries exclude all surface canaries", () => {
        const retained = Object.entries(archive).flatMap(([name, entry]) =>
          Object.entries(surfaceCanaries)
            .filter(([, canary]) => Buffer.from(entry).includes(Buffer.from(canary)))
            .map(([surface]) => `${name}:${surface}`),
        );
        requireValue(
          retained.length === 0,
          `decoded trace entries retained classified canaries: ${retained.join(",")}`,
        );
      });
    }
  }
  verify("clipboard download cache and memory observables have no admitted representation", () =>
    requireValue(
      !artifacts.some((artifact) => ["clipboard", "download"].includes(artifact.kind)),
      "protected transfer artifact admitted",
    ),
  );
}

async function inspectVideo(root: string, artifact: Artifact) {
  const bytes = await artifactBytes(root, artifact);
  verify("video archive excludes all plaintext surface canaries", () =>
    requireValue(allCanariesAbsent(bytes), "WebM contains a surface canary"),
  );
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  try {
    const page = await browser.newPage();
    await page.evaluate(
      "Object.defineProperty(globalThis,'__name',{value:function(value){return value},configurable:true})",
    );
    const profile = await page.evaluate(
      async (source) => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.src = source;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("video metadata decode timed out")),
            5_000,
          );
          video.addEventListener(
            "loadedmetadata",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
          video.addEventListener(
            "error",
            () => {
              clearTimeout(timeout);
              reject(new Error(`video decode failed: ${video.error?.message ?? "unknown"}`));
            },
            { once: true },
          );
        });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || canvas.width === 0 || canvas.height === 0)
          throw new Error("decoded video has no drawable dimensions");
        let frames = 0;
        let magenta = 0;
        let green = 0;
        const scan = () => {
          context.drawImage(video, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index]! > 220 && pixels[index + 1]! < 40 && pixels[index + 2]! > 220)
              magenta += 1;
            if (pixels[index]! < 40 && pixels[index + 1]! > 100 && pixels[index + 2]! < 40)
              green += 1;
          }
          frames += 1;
        };
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              frames > 0
                ? resolve()
                : reject(new Error("decoded frame scan timed out before first frame")),
            10_000,
          );
          let idle: ReturnType<typeof setTimeout> | undefined;
          const finish = () => {
            clearTimeout(timeout);
            if (idle) clearTimeout(idle);
            resolve();
          };
          const frame = () => {
            scan();
            if (idle) clearTimeout(idle);
            idle = setTimeout(finish, 750);
            if (video.ended || frames >= 300) {
              finish();
              return;
            }
            video.requestVideoFrameCallback(frame);
          };
          video.requestVideoFrameCallback(frame);
          video.play().catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        return { frames, magenta, green, width: canvas.width, height: canvas.height };
      },
      `data:video/webm;base64,${bytes.toString("base64")}`,
    );
    await page.evaluate("delete globalThis.__name");
    verify("admitted video decodes real frames", () =>
      requireValue(profile.frames > 0, "no WebM frame decoded"),
    );
    verify("decoded video frames exclude visual canary pixels", () =>
      requireValue(
        profile.magenta === 0,
        `${profile.magenta} magenta pixels found across ${profile.frames} decoded frames`,
      ),
    );
    verify("decoded video retains non-protected visual control", () =>
      requireValue(
        profile.green > 0,
        `green control absent across ${profile.frames} decoded frames`,
      ),
    );
  } finally {
    await browser.close();
  }
}

async function inspectScreenshot(root: string, artifact: Artifact) {
  const bytes = await artifactBytes(root, artifact);
  verify("screenshot archive excludes all plaintext surface canaries", () =>
    requireValue(allCanariesAbsent(bytes), "PNG contains a surface canary"),
  );
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  try {
    const page = await browser.newPage();
    const profile = await page.evaluate(
      async (source) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("2D context unavailable");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        let magenta = 0;
        let green = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! > 220 && pixels[index + 1]! < 40 && pixels[index + 2]! > 220)
            magenta += 1;
          if (pixels[index]! < 40 && pixels[index + 1]! > 100 && pixels[index + 2]! < 40)
            green += 1;
        }
        return { magenta, green, total: image.width * image.height };
      },
      `data:image/png;base64,${bytes.toString("base64")}`,
    );
    verify("visual canary pixels are absent", () =>
      requireValue(profile.magenta === 0, `${profile.magenta} magenta canary pixels retained`),
    );
    verify("non-protected visual control remains", () =>
      requireValue(profile.green > 0, "green control pixels absent"),
    );
  } finally {
    await browser.close();
  }
}

async function verifyArtifactLifecycle(
  store: LocalArtifactStore,
  executionRoot: string,
  storageRoot: string,
  artifact: Artifact,
) {
  const bytes = await artifactBytes(executionRoot, artifact);
  const proof = proofFor(artifact);
  const key = `campaign/${artifact.id}`;
  verify(`${artifact.kind}: admitted proof is bound to bytes`, () =>
    requireValue(
      proof.manifest.contentDigest === artifact.checksumSha256,
      "manifest digest mismatch",
    ),
  );
  const stored = await store.put(key, bytes, proof);
  verify(`${artifact.kind}: stored through admission boundary`, () =>
    requireValue(stored.sizeBytes === bytes.byteLength, "stored size mismatch"),
  );
  const retrieved = await store.get(key, proof);
  verify(`${artifact.kind}: verified retrieval`, () =>
    requireValue(Buffer.from(retrieved).equals(bytes), "retrieved bytes changed"),
  );
  await expectAdmissionRefusal(`${artifact.kind}: forged proof refused`, () =>
    store.get(key, { ...proof, token: "forged" }),
  );
  await writeFile(path.join(storageRoot, key), Buffer.concat([bytes, Buffer.from("tampered")]));
  await expectAdmissionRefusal(`${artifact.kind}: tampered stored bytes refused`, () =>
    store.get(key, proof),
  );
  await store.delete(key);
  await verify(`${artifact.kind}: quarantine destruction removed bytes`, async () =>
    requireValue(!(await store.exists(key)), "artifact still exists"),
  );
  await expectMissing(`${artifact.kind}: retrieval after destruction refused`, () =>
    store.get(key, proof),
  );
  if (artifact.kind === "dom" || artifact.kind === "network") {
    verify(`${artifact.kind}: retained bytes exclude all surface canaries`, () =>
      requireValue(allCanariesAbsent(bytes), "retained artifact includes a surface canary"),
    );
  }
}

async function artifactBytes(root: string, artifact: Artifact) {
  requireValue(artifact.relativePath, `${artifact.kind} has no relative path`);
  return readFile(path.join(root, artifact.relativePath));
}

function proofFor(artifact: Artifact): VeilEvidenceAdmissionProof {
  const observation = artifact.observation as Record<string, unknown> | undefined;
  requireValue(
    observation?.veilManifest && observation?.veilAdmissionToken,
    `${artifact.kind} lacks Veil admission proof`,
  );
  return {
    manifest: observation.veilManifest as VeilEvidenceAdmissionProof["manifest"],
    token: String(observation.veilAdmissionToken),
    ...(observation.veilSanitation
      ? { sanitation: observation.veilSanitation as Record<string, unknown> }
      : {}),
  };
}

function replicaSteps(origin: string, replica: Replica) {
  const flow = replicaFlows[replica];
  const fieldTarget = target(
    flow.label,
    ["focusable", "accepts_text", "editable", "readable_value"],
    "field",
    [flow.label],
    "ordinary",
  );
  const submitTarget = target(
    flow.submit,
    ["focusable", "pointer_activatable"],
    "button",
    [flow.submit],
    replica === "cross-origin-authentication" ? "authentication" : "ordinary",
  );
  const resultTarget = target(
    `${replica} result`,
    ["readable_value"],
    "region",
    [flow.result],
    "read_only",
  );
  return [
    {
      id: `visit-${replica}`,
      title: `Open ${replica} controlled replica`,
      action: { type: "navigate" as const, url: `${origin}/replica/${replica}` },
      after: {
        mode: "all" as const,
        timeoutMs: 5_000,
        conditions: [{ type: "domStable" as const, quietWindowMs: 200 }],
      },
      assertions: [
        { type: "url" as const, expected: `/replica/${replica}`, match: "path" as const },
      ],
      evidence: [],
      onFailure: "stop" as const,
      captureIntent: "final" as const,
    },
    {
      id: `prepare-${replica}`,
      title: `Prepare ${replica} public state`,
      action: { type: "fill" as const, target: fieldTarget, value: flow.value },
      assertions: [{ type: "value" as const, target: fieldTarget, expected: flow.value }],
      evidence: [],
      onFailure: "stop" as const,
      captureIntent: "final" as const,
    },
    {
      id: `capture-${replica}`,
      title: `Commit and capture ${replica} controlled state`,
      action: {
        type: "click" as const,
        target: submitTarget,
        expectedEffect: {
          type: "navigation" as const,
          url: `/replica/${replica}`,
          match: "path" as const,
        },
      },
      after: {
        mode: "all" as const,
        timeoutMs: 5_000,
        conditions: [
          { type: "visible" as const, target: resultTarget },
          { type: "domStable" as const, quietWindowMs: 200 },
        ],
      },
      assertions: [
        { type: "text" as const, target: resultTarget, expected: flow.result, exact: true },
      ],
      evidence: ["screenshot" as const, "dom" as const, "network" as const],
      onFailure: "stop" as const,
      captureIntent: "final" as const,
    },
  ];
}

function target(
  concept: string,
  requiredCapabilities: Array<
    "focusable" | "pointer_activatable" | "accepts_text" | "editable" | "readable_value"
  >,
  role: "field" | "button" | "region",
  names: string[],
  risk: "ordinary" | "authentication" | "read_only",
) {
  return {
    concept,
    requiredCapabilities,
    preferredEvidence: {
      roles: [role],
      names,
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" as const },
    relations: [],
    prohibited: ["hidden" as const, "disabled" as const],
    risk,
    confidence: { requiredFamilies: ["native_control" as const] },
  };
}

function fixture(
  secrets: Record<CanarySurface, string>,
  crossOrigin: string,
  replica: Replica,
  state: number,
) {
  const flow = replicaFlows[replica];
  const categoryControl = replicaCategoryControl(replica);
  const result =
    state > 0
      ? `<section role="region" aria-label=${JSON.stringify(flow.result)}>${flow.result}</section>`
      : "";
  const j = (surface: CanarySurface) => JSON.stringify(secrets[surface]);
  return `<!doctype html><html><head><style>body{background:#fff;font-family:sans-serif}.control{width:40px;height:40px;background:rgb(0,128,0)}form{display:grid;gap:8px;max-width:420px}</style></head><body data-replica=${JSON.stringify(replica)} data-state=${JSON.stringify(state)} data-diagnostic=${j("diagnostic")}><div class=control></div><h1>${replica}</h1><form method="post" action="/replica/${replica}"><label>${flow.label}<input name=${JSON.stringify(flow.field)} aria-label=${JSON.stringify(flow.label)}></label>${categoryControl}<button type="submit">${flow.submit}</button></form>${result}<label>Protected ${replica}<input type=password value=${j("dom-text")} data-scry-redacted=true data-canary=${j("dom-attribute")} aria-label=${j("accessibility")}></label><canvas id=opaque width=80 height=80></canvas><svg width=80 height=40><text>${secrets.svg}</text></svg><video width=80 height=40 data-protected-value=${j("video")}></video><a download=${j(`${"filename"}` as CanarySurface)} href="data:text/plain,${encodeURIComponent(secrets.download)}">download</a>${replica === "cross-origin-authentication" ? `<iframe title="Identity provider" src=${JSON.stringify(crossOrigin)}></iframe>` : ""}<script>const c=document.querySelector('#opaque').getContext('2d');c.fillStyle='rgb(255,0,255)';c.fillRect(0,0,80,80);c.fillStyle='white';c.fillText(${j("canvas")},1,20);const glCanvas=document.createElement('canvas');const gl=glCanvas.getContext('webgl');if(gl){glCanvas.dataset.protectedValue=${j("webgl")};document.body.appendChild(glCanvas)}globalThis.__retainedCanary={secret:${j("memory-observable")}};globalThis.__veilReportValue=${j("report")};sessionStorage.setItem('replica-cache',${j("cache")});console.log(${j("console")});console.timeStamp(${j("trace")});performance.mark(${j("trace")});queueMicrotask(()=>{throw new Error(${j("page-error")})});fetch('/ping?value='+encodeURIComponent(${j("request")})).then(r=>r.text()).then(value=>{globalThis.__responseCanary=value});</script></body></html>`;
}

function replicaCategoryControl(replica: Replica) {
  switch (replica) {
    case "credential":
      return `<input autocomplete="username" aria-label="Credential username"><input type="password" data-scry-redacted="true" aria-label="Credential password">`;
    case "payment":
      return `<select aria-label="Payment method"><option>Test card</option></select>`;
    case "recovery":
      return `<fieldset><legend>Recovery channel</legend><label><input type="radio" checked> Email</label></fieldset>`;
    case "health":
      return `<label><input type="checkbox" checked> Synthetic health data consent</label>`;
    case "financial":
      return `<output aria-label="Illustrative balance">1000 demo units</output>`;
    case "upload-download":
      return `<input type="file" aria-label="Synthetic upload"><button type="button">Download sanitized copy</button>`;
    case "cross-origin-authentication":
      return `<p>Authentication continues in the isolated identity-provider frame.</p>`;
    case "protected-generated-value":
      return `<output data-scry-redacted="true" aria-label="Generated protected value">${surfaceCanaries["dom-text"]}</output>`;
  }
}

async function expectAdmissionRefusal(name: string, operation: () => Promise<unknown>) {
  try {
    await operation();
    checks.push({ name, status: "failed", diagnostic: "operation unexpectedly succeeded" });
  } catch (error) {
    checks.push(
      error instanceof VeilEvidenceAdmissionError
        ? { name, status: "passed" }
        : {
            name,
            status: "failed",
            diagnostic: error instanceof Error ? error.message : String(error),
          },
    );
  }
}

async function expectMissing(name: string, operation: () => Promise<unknown>) {
  try {
    await operation();
    checks.push({ name, status: "failed", diagnostic: "operation unexpectedly succeeded" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    checks.push(
      code === "ENOENT"
        ? { name, status: "passed" }
        : {
            name,
            status: "failed",
            diagnostic: error instanceof Error ? error.message : String(error),
          },
    );
  }
}

async function takeHeapSnapshot(cdp: CDPSession) {
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.takeHeapSnapshot", {
    reportProgress: false,
    captureNumericValue: true,
  });
  return chunks.join("");
}

function allCanariesAbsent(value: Uint8Array | string) {
  if (typeof value === "string")
    return Object.values(surfaceCanaries).every((secret) => !value.includes(secret));
  const bytes = Buffer.from(value);
  return Object.values(surfaceCanaries).every((secret) => !bytes.includes(Buffer.from(secret)));
}

function verify(name: string, assertion: () => void | Promise<void>) {
  try {
    const value = assertion();
    if (value instanceof Promise)
      return value.then(
        () => {
          checks.push({ name, status: "passed" });
        },
        (error) => {
          checks.push({
            name,
            status: "failed",
            diagnostic: error instanceof Error ? error.message : String(error),
          });
        },
      );
    checks.push({ name, status: "passed" });
  } catch (error) {
    checks.push({
      name,
      status: "failed",
      diagnostic: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

await main();
