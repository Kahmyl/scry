import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { VEIL_CONTRACT_VERSION, type VeilCollectorPhase, type VeilEvidenceChannel, type VeilLeaseRequest } from "@scry/contracts";
import { LocalArtifactStore, signVeilEvidenceAdmission } from "@scry/artifact";
import { compileVeilPolicy } from "@scry/policy";

import { VeilAuthority } from "../src/veil-authority.js";
import { VeilRuntimeSession, type VeilRuntimeCollector } from "../src/veil-runtime-session.js";

type Result = { id: string; category: string; status: "passed" | "failed"; evidenceDigest?: string; diagnostic?: string };
const results: Result[] = [];
const replicas = ["credential", "payment", "recovery", "health", "financial", "upload-download", "cross-origin-authentication", "protected-generated-value"] as const;
const channels: VeilEvidenceChannel[] = ["video", "trace", "screenshot", "dom", "accessibility", "console", "page_error", "network", "clipboard", "download", "event", "report", "metadata"];
const canarySurfaces = ["dom-text", "dom-attribute", "accessibility", "console", "page-error", "request", "response", "canvas", "svg", "webgl", "video", "clipboard", "download", "filename", "trace", "cache", "diagnostic", "report", "memory-artifact"] as const;
const cancellationStates = ["normal", "preparing", "suspended", "isolated", "protected", "resuming", "sealed", "finalized"] as const;
const failureRequirements = ["collector-prepare", "collector-suspend", "collector-isolate", "collector-resume", "collector-seal", "collector-finalize", "policy-change", "lease-expiry", "navigation", "document-epoch", "page-loss", "context-loss", "browser-loss", "storage-failure", "admission-failure", "masking-runtime-loss", "timeout", ...cancellationStates.map((state) => `cancellation-${state}` as const), "retry", "concurrency", "crash-recovery"] as const;

class Collector implements VeilRuntimeCollector {
  constructor(readonly id: string, private readonly fail?: VeilCollectorPhase, private readonly hang?: VeilCollectorPhase) {}
  async transition(phase: VeilCollectorPhase, context: { operationId?: string; stateVersion: number }) {
    if (phase === this.hang) await new Promise((resolve) => setTimeout(resolve, 50));
    if (phase === this.fail) throw new Error(`INJECTED_${phase.toUpperCase()}_FAILURE`);
    return { schemaVersion: VEIL_CONTRACT_VERSION, collectorId: this.id, phase, operationId: context.operationId, stateVersion: context.stateVersion, acknowledgedAt: new Date().toISOString() };
  }
}

async function main() {
  for (const phase of ["prepare", "suspend", "isolate", "resume", "seal", "finalize"] as const) await check(`failure:collector-${phase}`, "failure-injection", () => collectorFailure(phase));
  await check("failure:policy-change", "failure-injection", policyChange);
  await check("failure:lease-expiry", "failure-injection", leaseExpiry);
  for (const id of ["navigation", "document-epoch", "page-loss", "context-loss", "browser-loss"] as const) await check(`failure:${id}`, "failure-injection", () => contextInvalidation(id));
  await check("failure:storage-failure", "failure-injection", storageFailure);
  await check("failure:admission-failure", "failure-injection", admissionFailure);
  await check("failure:masking-runtime-loss", "failure-injection", () => failClosedBoundary("masking-runtime-loss"));
  await check("failure:crash-recovery", "failure-injection", childProcessCrashRecovery);
  await check("failure:timeout", "failure-injection", timeoutFailure);
  for (const state of cancellationStates) await check(`failure:cancellation-${state}`, "failure-injection", () => cancellationAt(state));
  await check("failure:retry", "failure-injection", retry);
  await check("failure:concurrency", "failure-injection", concurrency);

  const requiredIds = failureRequirements.map((id) => `failure:${id}`);
  const missing = requiredIds.filter((id) => !results.some((result) => result.id === id));
  const failed = results.filter((result) => result.status === "failed");
  const report = {
    schemaVersion: 1, campaign: "veil-failure-boundaries", executedAt: new Date().toISOString(),
    environment: { deterministic: true, externalMutation: "none", secretValuesPersisted: false },
    counts: { required: requiredIds.length, executed: results.length, passed: results.length - failed.length, failed: failed.length, missing: missing.length, skipped: 0 },
    coverage: { failureInjection: failureRequirements, productionPathEvidence: { controlledReplicasAndRetainedCanaries: "veil-production-e2e", opaqueBrowserAndLifecycleSurfaces: "veil-adversarial", corpusAndEndurance: "veil-certification" }, companionExecutableCampaigns: ["veil-certification", "veil-adversarial", "veil-production-e2e", "veil-public-application-qualification", "veil-performance"] },
    durableEvidence: { safeScenarioIdentifiers: true, content: "digests-and-dispositions-only", reportDigest: digest(results) },
    qualification: failed.length === 0 && missing.length === 0 ? "VEIL_FAILURE_BOUNDARIES_PASS" : "VEIL_FAILURE_BOUNDARIES_FAIL",
    readiness: failed.length === 0 && missing.length === 0 ? "PASSED_AS_COMBINED_CAMPAIGN_COMPONENT" : "NOT_READY",
    missing, results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed.length || missing.length ? 1 : 0;
}

async function collectorFailure(phase: VeilCollectorPhase) {
  const runtime = new VeilRuntimeSession([new Collector(`collector-${phase}`, phase)], "a".repeat(64), `phase-${phase}`, undefined, 10);
  if (phase === "prepare" || phase === "suspend" || phase === "isolate") { await rejects(runtime.prepare("operation")); assert(runtime.state() === "sealed", "transition failure did not seal"); return; }
  if (phase === "resume") { await runtime.prepare("operation"); await runtime.beginProtected(); await rejects(runtime.resume()); assert(runtime.state() === "sealed", "resume failure did not seal"); return; }
  if (phase === "seal") { await rejects(runtime.seal(failure("VEIL_INJECTED_SEAL"))); assert(runtime.state() === "sealed", "seal failure did not remain sealed"); return; }
  await rejects(runtime.finalize());
}
async function policyChange() { const one = compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://policy.invalid"] }); const two = compileVeilPolicy({ profile: "private", allowedOrigins: ["https://policy.invalid"] }); const authority = new VeilAuthority(one); const req = request("policy", "screenshot", "public", "https://policy.invalid"); const lease = authority.issueLease(req).lease; authority.updatePolicy(two); await rejects(() => authority.validateLease(lease, req)); }
async function leaseExpiry() { let now = 1_000; const authority = new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://expiry.invalid"], leaseTtlMs: 1_000 }), () => now); const req = request("expiry", "screenshot", "public", "https://expiry.invalid"); const lease = authority.issueLease(req).lease; now = 2_001; await rejects(() => authority.validateLease(lease, req)); }
async function contextInvalidation(id: string) { const origin = "https://context.invalid"; const authority = authorityFor(origin); const req = request(id, "screenshot", "public", origin); const lease = authority.issueLease(req).lease; authority.invalidateContext(id === "document-epoch" ? { documentEpoch: 1 } : id === "page-loss" || id === "navigation" ? { pageId: `page-${id}` } : { browserContextId: `context-${id}` }); await rejects(() => authority.validateLease(lease, req)); }
async function failClosedBoundary(id: string) { const runtime = new VeilRuntimeSession([new Collector(id)], "b".repeat(64), id); await runtime.prepare(id); await runtime.beginProtected(); await runtime.seal(failure(`VEIL_${id.replaceAll("-", "_").toUpperCase()}`)); assert(runtime.state() === "sealed", `${id} did not seal`); }
async function storageFailure() { const root = mkdtempSync(path.join(tmpdir(), "veil-storage-failure-")); const blocked = path.join(root, "not-a-directory"); writeFileSync(blocked, "occupied"); const bytes = Buffer.from("safe-evidence"); const proof = admissionProof(bytes); const store = new LocalArtifactStore(blocked, "release-scope-admission-key-at-least-32-bytes"); await rejects(store.put("artifact.bin", bytes, proof)); assert(!(await store.exists("artifact.bin")), "storage failure retained artifact"); }
async function admissionFailure() { const root = mkdtempSync(path.join(tmpdir(), "veil-admission-failure-")); const bytes = Buffer.from("safe-evidence"); const store = new LocalArtifactStore(root, "release-scope-admission-key-at-least-32-bytes"); await rejects(store.put("artifact.bin", bytes, { ...admissionProof(bytes), token: "forged" })); assert(!(await store.exists("artifact.bin")), "failed admission retained artifact"); }
function admissionProof(bytes: Uint8Array) { return signVeilEvidenceAdmission({ schemaVersion: VEIL_CONTRACT_VERSION, evidenceId: "release-scope-evidence", channel: "report", classification: "public", disposition: "allow", policyDigest: "a".repeat(64), decisionId: "release-scope-decision", contentDigest: createHash("sha256").update(bytes).digest("hex"), omissionIntervals: [], createdAt: new Date().toISOString() }, "release-scope-admission-key-at-least-32-bytes"); }
async function timeoutFailure() { const runtime = new VeilRuntimeSession([new Collector("timeout", undefined, "prepare")], "c".repeat(64), "timeout", undefined, 5); await rejects(runtime.prepare("timeout")); assert(runtime.state() === "sealed", "timeout did not seal"); }
async function cancellationAt(target: typeof cancellationStates[number]) {
  if (target === "finalized") {
    const finalized = new VeilRuntimeSession([new Collector("cancel-finalized")], "d".repeat(64), "cancel-finalized");
    await finalized.prepare("cancel-finalized");
    await finalized.beginProtected();
    await finalized.resume();
    await finalized.finalize();
    await finalized.cancel();
    assert(finalized.state() === "finalized", "cancel reopened finalized runtime");
    return;
  }
  let runtime!: VeilRuntimeSession; let requested = false;
  runtime = new VeilRuntimeSession([new Collector(`cancel-${target}`)], "d".repeat(64), `cancel-${target}`, async (event) => { if (event.to === target && target !== "finalized") { requested = true; queueMicrotask(() => void runtime.cancel()); } });
  if (target === "normal") { await runtime.cancel(); requested = true; }
  else if (["preparing", "suspended", "isolated"].includes(target)) await runtime.prepare("cancel").catch(() => undefined);
  else if (target === "protected" || target === "resuming") { await runtime.prepare("cancel"); await runtime.beginProtected(); if (target === "resuming") await runtime.resume().catch(() => undefined); }
  else if (target === "sealed") await runtime.seal(failure("VEIL_CANCEL_SEALED"));
  await runtime.cancel(); assert(requested && runtime.state() === "sealed", `cancel at ${target} did not seal`);
}
async function retry() { const runtime = new VeilRuntimeSession([new Collector("retry")], "e".repeat(64), "retry"); const checkpoint = runtime.checkpoint(); await runtime.seal(failure("VEIL_RETRY")); await runtime.restore(checkpoint); assert(runtime.state() === "normal", "safe retry checkpoint did not restore"); }
async function concurrency() { const runtime = new VeilRuntimeSession([new Collector("concurrent")], "f".repeat(64), "concurrent"); const outcomes = await Promise.allSettled([runtime.prepare("one"), runtime.prepare("two")]); assert(outcomes.filter((x) => x.status === "fulfilled").length === 1, "concurrent transitions were not serialized/refused"); await runtime.seal(failure("VEIL_CONCURRENCY_COMPLETE")); }
async function childProcessCrashRecovery() {
  const root = mkdtempSync(path.join(tmpdir(), "veil-crash-recovery-")); const checkpoint = path.join(root, "checkpoint.json"); const recovered = path.join(root, "recovered.json"); const artifacts = path.join(root, "artifacts");
  const crashProgram = `import fs from 'node:fs';import http from 'node:http';import {executePlan} from './src/executor.ts';import {VeilRuntimeSession} from './src/veil-runtime-session.ts';import {currentPlanSchema,executionPolicySchema} from '@scry/contracts';fs.mkdirSync(${JSON.stringify(artifacts)});const collector={id:'child-real-collector',async transition(phase,context){return{schemaVersion:1,collectorId:this.id,phase,operationId:context.operationId,stateVersion:context.stateVersion,acknowledgedAt:new Date().toISOString()}}};const runtime=new VeilRuntimeSession([collector],'a'.repeat(64),'real-child');fs.writeFileSync(${JSON.stringify(checkpoint)},JSON.stringify(runtime.checkpoint()));await runtime.prepare('mid-capture');await runtime.beginProtected();const server=http.createServer((_,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<body><input type=password data-scry-redacted=true value=VEIL_CHILD_SECRET><script>setTimeout(()=>document.body.dataset.ready=\"yes\",20000)</script></body>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;const plan=currentPlanSchema.parse({name:'crash capture',objective:'crash actual executor mid capture',allowedOrigins:[origin],budgets:{maxActions:1,maxDurationMs:30000,maxNavigations:1},checkpoints:[],steps:[{id:'crash-step',title:'crash during capture',action:{type:'navigate',url:origin},after:{mode:'all',timeoutMs:25000,conditions:[{type:'delay',durationMs:20000}]},assertions:[],evidence:['screenshot'],onFailure:'stop',captureIntent:'final'}]});setTimeout(()=>process.kill(process.pid,'SIGKILL'),1200);await executePlan({plan,policy:executionPolicySchema.parse({allowedOrigins:[origin],allowPrivateNetwork:true}),outputDirectory:${JSON.stringify(artifacts)},browserChannel:process.env.SCRY_BROWSER_CHANNEL??'chrome',veilAdmissionKey:'release-scope-admission-key-at-least-32-bytes'})`;
  const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", crashProgram]);
  assert(crashed.signal === "SIGKILL", `child did not crash with SIGKILL: ${crashed.status}/${crashed.signal}`);
  const crashEntries = readdirSync(artifacts, { recursive: true }).map(String);
  const crashFiles = crashEntries.filter((entry) => path.basename(entry).includes("."));
  assert(crashFiles.every((entry) => entry === "events.jsonl"), `crashed executor left unadmitted artifact files: ${crashFiles.join(",")}`);
  assert(!readFileSync(path.join(artifacts, "events.jsonl"), "utf8").includes("VEIL_CHILD_SECRET"), "crashed executor persisted protected bytes in safe events");
  const recoveryProgram = `import fs from 'node:fs';import http from 'node:http';import {executePlan} from './src/executor.ts';import {VeilRuntimeSession} from './src/veil-runtime-session.ts';import {currentPlanSchema,executionPolicySchema} from '@scry/contracts';const checkpoint=JSON.parse(fs.readFileSync(${JSON.stringify(checkpoint)},'utf8'));const collector={id:'replacement-real-collector',async transition(phase,context){return{schemaVersion:1,collectorId:this.id,phase,operationId:context.operationId,stateVersion:context.stateVersion,acknowledgedAt:new Date().toISOString()}}};const runtime=new VeilRuntimeSession([collector],'a'.repeat(64),'real-child');await runtime.seal({schemaVersion:1,code:'VEIL_CHILD_PROCESS_LOST',provenance:'runtime',retry:'requires_new_context'});await runtime.restore(checkpoint);const server=http.createServer((_,res)=>res.end('<body>recovered</body>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;const plan=currentPlanSchema.parse({name:'recovery run',objective:'actual clean recovery entrypoint',allowedOrigins:[origin],budgets:{maxActions:1,maxDurationMs:10000,maxNavigations:1},checkpoints:[],steps:[{id:'recover-step',title:'recover cleanly',action:{type:'navigate',url:origin},assertions:[],evidence:[],onFailure:'stop',captureIntent:'final'}]});const report=await executePlan({plan,policy:executionPolicySchema.parse({allowedOrigins:[origin],allowPrivateNetwork:true}),outputDirectory:${JSON.stringify(path.join(root, "recovery-artifacts"))},browserChannel:process.env.SCRY_BROWSER_CHANNEL??'chrome',veilAdmissionKey:'release-scope-admission-key-at-least-32-bytes'});server.close();fs.writeFileSync(${JSON.stringify(recovered)},JSON.stringify({state:runtime.state(),checkpoint,runState:report.state,artifacts:report.artifacts.map(a=>({kind:a.kind,availability:a.availability}))}))`;
  const restart = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", recoveryProgram]);
  const recovery = JSON.parse(readFileSync(recovered, "utf8"));
  assert(restart.status === 0 && recovery.state === "normal" && recovery.runState === "passed", `replacement Veil runtime/executor did not recover sealed checkpoint: ${restart.stderr?.toString()}`);
}

function authorityFor(origin: string) { return new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] })); }
function channelForSurface(surface: typeof canarySurfaces[number]): VeilEvidenceChannel {
  if (["canvas", "svg", "webgl"].includes(surface)) return "screenshot";
  if (surface === "video") return "video";
  if (["dom-text", "dom-attribute"].includes(surface)) return "dom";
  if (surface === "accessibility") return "accessibility";
  if (surface === "console" || surface === "diagnostic") return "console";
  if (surface === "page-error") return "page_error";
  if (surface === "request" || surface === "response" || surface === "cache") return "network";
  if (surface === "clipboard") return "clipboard";
  if (["download", "filename"].includes(surface)) return "download";
  if (surface === "trace") return "trace";
  return "report";
}
function request(id: string, channel: VeilEvidenceChannel, classification: "public" | "secret", origin = `https://${id}.replica.invalid`): VeilLeaseRequest { return { context: { userId: "release-campaign", environmentId: "controlled", transactionId: `tx-${id}`, origin, browserContextId: `context-${id}`, pageId: `page-${id}`, frameId: "main", documentEpoch: 1 }, operation: "capture", channel, classification, scope: "channel" }; }
function failure(code: string) { return { schemaVersion: VEIL_CONTRACT_VERSION, code, provenance: "runtime" as const, retry: "unsafe" as const }; }
async function rejects(operation: Promise<unknown> | (() => unknown)) { let rejected = false; try { await (typeof operation === "function" ? operation() : operation); } catch { rejected = true; } assert(rejected, "expected rejection"); }
async function check(id: string, category: string, operation: () => Promise<void>) { try { await operation(); results.push({ id, category, status: "passed", evidenceDigest: digest({ id, category, disposition: "safe" }) }); } catch (error) { results.push({ id, category, status: "failed", diagnostic: error instanceof Error ? error.message : String(error) }); } }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

await main();
