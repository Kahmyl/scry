import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { SecretRedactor } from "@scry/policy";
import { requirePraxisSuccess } from "@scry/praxis";
import { PlaywrightProtectedCapsuleFactory } from "@scry/praxis";
import { acquireValue, registerProtectedAcquisitionAdapter } from "@scry/praxis";
import { beginProtectedResponseEnvelope } from "@scry/praxis";
import type { ProtectedOperationClaim } from "@scry/contracts";
import { runProtectedStage } from "@scry/praxis";
import { VeilChannelCollector, VeilClipboardCollector, VeilRuntimeCoordinator } from "@scry/veil";
import { ProtectedCertificationDatabase } from "./protected-certification-database.js";
import { NativeBrowserDriver } from "../src/runtime/native-browser-driver/native-browser-driver.js";
import {
  runKernelOwnerCertification,
  runPublicMissionReplayCertification,
} from "./protected-certification-production-owner.js";

type ResultStatus =
  | "PASS"
  | "EXPECTED_FAIL_CLOSED"
  | "EXPLICITLY_UNSUPPORTED"
  | "NEW_DEFECT"
  | "EVIDENCE_UNAVAILABLE"
  | "HARNESS_ERROR"
  | "WATCHDOG_TIMEOUT";
type Semantics = "one_time" | "read_only" | "not_applicable";
type Family =
  "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M" | "N" | "O";
type Probe = "executor" | "api" | "veil" | "postgres" | "controlled";
type CertificationFixture = {
  control:
    | "native_button"
    | "semantic_custom_control"
    | "ambiguous_control"
    | "disappearing_control"
    | "disabled_delayed_control";
  response:
    | "normal_json"
    | "delayed_below_deadline"
    | "delayed_above_deadline"
    | "body_never_resolves"
    | "body_rejects"
    | "malformed_json"
    | "oversized_json"
    | "mixed_complete_and_stuck"
    | "late_after_envelope_close"
    | "redirect_same_origin"
    | "redirect_allowed_origin"
    | "redirect_forbidden_origin";
  request:
    | "fetch"
    | "xhr"
    | "no_request"
    | "outside_envelope"
    | "unsupported_eventsource"
    | "unsupported_websocket";
  dispatchFault:
    | "none"
    | "abort_before_dispatch"
    | "abort_after_dispatch"
    | "abort_during_acquisition"
    | "abort_during_persistence"
    | "abort_during_reconciliation";
  browserFault:
    | "none"
    | "page_close_pre_dispatch"
    | "page_close_post_dispatch"
    | "capsule_context_close"
    | "safe_page_close"
    | "safe_context_close"
    | "context_close_hang"
    | "browser_close_hang";
  acquisition:
    | "input_value"
    | "text_content"
    | "protected_network_value"
    | "copy_experience"
    | "download"
    | "visual_ocr"
    | "target_never_resolves"
    | "delayed_target"
    | "ambiguous_target"
    | "stale_target";
  persistence:
    | "normal"
    | "fail_before_commit"
    | "commit_then_lose_ack"
    | "process_loss_after_commit"
    | "partial_input_set"
    | "stale_fence"
    | "lock_timeout"
    | "statement_timeout";
  heartbeat:
    | "normal"
    | "reject_pre_dispatch"
    | "reject_post_dispatch"
    | "never_resolve"
    | "late_resolution_after_owner_loss"
    | "shutdown_while_pending"
    | "lease_expiry";
  reconciliation:
    | "success"
    | "unknown"
    | "never_resolve"
    | "clean_session_hang"
    | "reauthentication_hang"
    | "continuation_failure";
  safeBoundary:
    | "normal"
    | "emitter_never_resolves"
    | "collector_ack_failure"
    | "late_emitter"
    | "evidence_resume_hang";
  processLossState?:
    | "planned"
    | "preparing"
    | "ready_to_dispatch"
    | "dispatching"
    | "dispatched"
    | "acquiring"
    | "persisting"
    | "persisted"
    | "reconciling";
};
type CertificationContract = {
  finalStates: string[];
  maxDispatches: number;
  redispatches: 0;
  maxReferences?: number;
  liveOwnershipAfterClose: false;
};
type Cell = {
  id: string;
  family: Family;
  scenario: string;
  repetitions: number;
  semantics: Semantics;
  expectedClassification: "PASS" | "EXPECTED_FAIL_CLOSED" | "EXPLICITLY_UNSUPPORTED";
  probe: Probe;
  highRisk?: boolean;
  fixture: CertificationFixture;
  expected: CertificationContract;
};
type Result = {
  runId: string;
  cellId: string;
  family: Family;
  repetition: number;
  iteration: number;
  seed: number;
  semantics: Semantics;
  expectedClassification: Cell["expectedClassification"];
  actualClassification: ResultStatus;
  resultStatus: ResultStatus;
  adapterExecuted: boolean;
  dispatchCount: number | null;
  redispatchCount: number;
  finalProtectedState: string;
  mutationOutcome: string;
  acquisitionState: string;
  persistenceState: string;
  referenceCount: number | null;
  activeLease: boolean;
  activeProtectedLease: boolean;
  activeRuntimeLease: boolean;
  browserOwnerCount: number;
  activeBrowserOwner: boolean;
  safeBoundaryState: string;
  partialCommit: boolean;
  plaintextLeak: boolean;
  staleFenceAdvancement: boolean;
  lateStateAdvancement: boolean;
  durationMs: number;
  reasonCode: string | null;
  passed: boolean;
};

const normal = 25;
const malformed = 10;
const cells: Cell[] = [
  c("A1", "A", "readonly DOM input", normal, "one_time", "executor"),
  c("A2", "A", "text output acquisition", normal, "one_time", "executor"),
  c("A3", "A", "protected network acquisition", normal, "one_time", "executor"),
  c("A4", "A", "read-only network request", normal, "read_only", "executor"),
  ...variants(
    "B",
    [
      ["B1M", "response body never resolves mutation", normal, "one_time", true],
      ["B1R", "response body never resolves read-only", normal, "read_only", true],
      ["B2", "response just below deadline", normal, "one_time"],
      ["B3", "response beyond deadline", normal, "one_time", true],
      ["B4M", "mixed complete and stuck mutation", normal, "one_time", true],
      ["B4R", "mixed complete and stuck read-only", normal, "read_only", true],
      ["B5", "response body rejects", malformed, "one_time"],
      ["B6", "malformed JSON", malformed, "one_time"],
      ["B7", "oversized response", malformed, "one_time"],
      ["B8", "response outside envelope", malformed, "read_only"],
      ["B9S", "same-origin redirect", malformed, "read_only"],
      ["B9P", "permitted secondary-origin redirect", malformed, "read_only"],
      ["B9F", "forbidden-origin redirect", malformed, "read_only"],
      ["B10", "response after envelope deadline", normal, "one_time", true],
    ],
    "executor",
  ),
  ...variants(
    "C",
    [
      ["C1", "no request initiated", normal, "read_only"],
      ["C2", "request outside envelope", malformed, "read_only"],
      ["C3E", "EventSource unsupported", malformed, "read_only"],
      ["C3W", "WebSocket unsupported", malformed, "read_only"],
      ["C4", "fetch transport", normal, "read_only"],
      ["C5", "XHR transport", normal, "read_only"],
    ],
    "executor",
  ),
  ...variants(
    "D",
    [
      ["D1", "abort before dispatch", normal, "one_time", true],
      ["D2", "abort immediately after dispatch", normal, "one_time", true],
      ["D3", "abort during acquisition", normal, "one_time", true],
      ["D4", "abort during persistence", normal, "one_time", true],
      ["D5", "abort during reconciliation", normal, "one_time", true],
    ],
    "executor",
  ),
  ...variants(
    "E",
    [
      ["E1", "capsule page closes before dispatch", normal, "one_time", true],
      ["E2", "capsule page closes after dispatch", normal, "one_time", true],
      ["E3", "capsule context closes after dispatch", normal, "one_time", true],
      ["E4", "safe page closes during capsule", normal, "one_time", true],
      ["E5", "safe context closes during lifecycle", normal, "one_time", true],
      ["E6", "browser close hangs", normal, "one_time", true],
    ],
    "executor",
  ),
  ...variants(
    "F",
    [
      ["F1", "clipboard clear succeeds", normal, "not_applicable"],
      ["F2", "clipboard evaluation never resolves", normal, "not_applicable", true],
      ["F3", "capsule context close never resolves", normal, "not_applicable", true],
      ["F4", "browser termination cannot be proven", normal, "not_applicable", true],
      ["F5", "envelope close with pending bodies", normal, "not_applicable", true],
    ],
    "veil",
  ),
  ...variants(
    "G",
    [
      ["G1", "complete-set persistence", normal, "one_time"],
      ["G2", "persistence fails before commit", normal, "one_time"],
      ["G3", "commit acknowledgement lost", normal, "one_time", true],
      ["G4", "process dies after commit", normal, "one_time", true],
      ["G5", "mixed partial output input", malformed, "one_time"],
      ["G6", "stale fence persistence", normal, "one_time", true],
      ["G7", "lock timeout", malformed, "one_time", true],
      ["G8", "statement timeout", malformed, "one_time", true],
    ],
    "postgres",
  ),
  ...variants(
    "H",
    [
      ["H1", "heartbeat across long lifecycle", normal, "one_time"],
      ["H2", "heartbeat rejects before dispatch", normal, "one_time", true],
      ["H3", "heartbeat rejects after dispatch", normal, "one_time", true],
      ["H4", "heartbeat never resolves", normal, "one_time", true],
      ["H5", "heartbeat resolves after ownership loss", normal, "one_time", true],
      ["H6", "shutdown during heartbeat", normal, "one_time", true],
      ["H7", "lease expires after process loss", normal, "one_time", true],
    ],
    "api",
  ),
  ...processLossCells(),
  ...variants(
    "J",
    [
      ["J1", "reconciliation succeeds", normal, "one_time"],
      ["J2", "reconciliation unknown", normal, "one_time"],
      ["J3", "reconciliation never resolves", normal, "one_time", true],
      ["J4", "clean-session recreation never resolves", normal, "one_time", true],
      ["J5", "reauthentication never resolves", normal, "one_time", true],
      ["J6", "continuation navigation failure", normal, "one_time"],
    ],
    "executor",
  ),
  ...variants(
    "K",
    [
      ["K1", "captured safe-boundary normal", normal, "not_applicable"],
      ["K2", "safe-boundary emitter never resolves", normal, "not_applicable", true],
      ["K3", "collector acknowledgement failure", normal, "not_applicable"],
      ["K4", "late emitter after deadline", normal, "not_applicable", true],
      ["K5", "evidence resumption hangs", normal, "not_applicable", true],
    ],
    "veil",
  ),
  ...variants(
    "L",
    [
      ["L1", "input value", normal, "one_time"],
      ["L2", "text content", normal, "one_time"],
      ["L3", "approved network field", normal, "one_time"],
      ["L4", "verified copy experience", normal, "one_time"],
      ["L5", "download content experimental", malformed, "one_time"],
      ["L6", "visual OCR experimental", malformed, "one_time"],
    ],
    "executor",
  ),
  ...variants(
    "M",
    [
      ["M1", "native button", normal, "one_time"],
      ["M2", "malformed semantic control", normal, "one_time"],
      ["M3", "delayed rendering", normal, "one_time"],
      ["M4", "delayed enabled state", normal, "one_time"],
      ["M5", "duplicate candidates", normal, "one_time"],
      ["M6", "disappearing target", normal, "one_time"],
      ["M7", "stale target revalidation", normal, "one_time"],
    ],
    "executor",
  ),
  ...variants(
    "N",
    [
      ["N1", "request initiated", normal, "read_only"],
      ["N2", "request not initiated", normal, "read_only"],
      ["N3", "response not observed", normal, "read_only"],
      ["N4", "response body hangs", normal, "read_only", true],
      ["N5", "invalid response", malformed, "read_only"],
      ["N6", "staged data cleanup", normal, "read_only"],
      ["N7", "safe retry", normal, "read_only"],
      ["N8", "retry after failed-not-applied", normal, "read_only"],
    ],
    "executor",
  ),
  ...variants(
    "O",
    [
      ["O1", "completed replay", normal, "one_time"],
      ["O2", "failed-not-applied replay", normal, "read_only"],
      ["O3", "recovery-required replay", normal, "one_time"],
      ["O4", "compromised replay", normal, "one_time", true],
    ],
    "api",
  ),
];

const options = parseArgs(process.argv.slice(2));
const selected = cells.filter(
  (cell) =>
    (!options.family || cell.family === options.family) &&
    (!options.cell || cell.id === options.cell),
);
if (!selected.length) throw new Error("PROTECTED_CERTIFICATION_CELL_NOT_FOUND");
if (options.adapterChild) {
  if (selected.length !== 1) throw new Error("CERTIFICATION_CHILD_CELL_REQUIRED");
  const childOwner = setInterval(() => undefined, 1_000);
  const observation = await executeDirectAdapter(selected[0]!).finally(() =>
    clearInterval(childOwner),
  );
  process.stdout.write(`SCRY_CERTIFICATION_EVIDENCE=${JSON.stringify(observation)}\n`);
} else {
  const runId = randomUUID();
  const results: Result[] = [];
  for (const cell of selected) {
    const repetitions = options.repetitions ?? cell.repetitions;
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const seed = (options.seed ?? 1) + repetition - 1;
      results.push(await execute(cell, repetition, seed, runId));
    }
  }
  const report = aggregate(runId, selected, results);
  const repositoryRoot = path.resolve(process.cwd(), "../..");
  const reportPath = path.resolve(
    repositoryRoot,
    options.report ?? `docs/runbooks/evidence/protected-certification/${runId}.json`,
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(reportPath.replace(/\.json$/u, ".md"), markdown(report), "utf8");
  process.stdout.write(
    `${JSON.stringify({ outcome: report.passed ? "PROTECTED_CERTIFICATION_PASSED" : "PROTECTED_CERTIFICATION_FAILED", runId, reportPath, totals: report.totals, invariants: report.invariants })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}

function c(
  id: string,
  family: Family,
  scenario: string,
  repetitions: number,
  semantics: Semantics,
  probe: Probe,
  highRisk = false,
): Cell {
  const unsupported = id === "C3E" || id === "C3W";
  const failClosed =
    !["M2", "N8"].includes(id) &&
    (highRisk ||
      /fail|invalid|outside|unsupported|duplicate|stale|not initiated|not observed|timeout|hang|never|abort|dies|loss|unknown|partial|oversized|malformed|forbidden|disappearing/u.test(
        scenario,
      ));
  return {
    id,
    family,
    scenario,
    repetitions,
    semantics,
    probe,
    highRisk,
    fixture: fixtureFor(id),
    expected: contractFor(id, semantics, highRisk),
    expectedClassification: unsupported
      ? "EXPLICITLY_UNSUPPORTED"
      : failClosed
        ? "EXPECTED_FAIL_CLOSED"
        : "PASS",
  };
}
function variants(
  family: Family,
  values: Array<[string, string, number, Semantics, boolean?]>,
  probe: Probe,
) {
  return values.map(([id, scenario, repetitions, semantics, highRisk]) =>
    c(id, family, scenario, repetitions, semantics, probe, highRisk),
  );
}
function processLossCells() {
  const states = [
    "planned",
    "preparing",
    "ready_to_dispatch",
    "dispatching",
    "dispatched",
    "acquiring",
    "persisting",
    "persisted",
    "reconciling",
  ];
  return states.flatMap((state) =>
    (["one_time", "read_only"] as const).map((semantics) =>
      c(
        `I-${state}-${semantics}`,
        "I",
        `process loss ${state} ${semantics}`,
        10,
        semantics,
        "postgres",
        true,
      ),
    ),
  );
}
function fixtureFor(id: string): CertificationFixture {
  const fixture: CertificationFixture = {
    control: "native_button",
    response: "normal_json",
    request: "fetch",
    dispatchFault: "none",
    browserFault: "none",
    acquisition: "protected_network_value",
    persistence: "normal",
    heartbeat: "normal",
    reconciliation: "success",
    safeBoundary: "normal",
  };
  const response: Partial<Record<string, CertificationFixture["response"]>> = {
    B1M: "body_never_resolves",
    B1R: "body_never_resolves",
    B2: "delayed_below_deadline",
    B3: "delayed_above_deadline",
    B4M: "mixed_complete_and_stuck",
    B4R: "mixed_complete_and_stuck",
    B5: "body_rejects",
    B6: "malformed_json",
    B7: "oversized_json",
    B10: "late_after_envelope_close",
    N5: "malformed_json",
    B9S: "redirect_same_origin",
    B9P: "redirect_allowed_origin",
    B9F: "redirect_forbidden_origin",
  };
  const request: Partial<Record<string, CertificationFixture["request"]>> = {
    B8: "outside_envelope",
    C1: "no_request",
    C2: "outside_envelope",
    C3E: "unsupported_eventsource",
    C3W: "unsupported_websocket",
    C4: "fetch",
    C5: "xhr",
    N2: "no_request",
    N3: "no_request",
  };
  const dispatch: Partial<Record<string, CertificationFixture["dispatchFault"]>> = {
    D1: "abort_before_dispatch",
    D2: "abort_after_dispatch",
    D3: "abort_during_acquisition",
    D4: "abort_during_persistence",
    D5: "abort_during_reconciliation",
  };
  const browser: Partial<Record<string, CertificationFixture["browserFault"]>> = {
    E1: "page_close_pre_dispatch",
    E2: "page_close_post_dispatch",
    E3: "capsule_context_close",
    E4: "safe_page_close",
    E5: "safe_context_close",
    E6: "browser_close_hang",
    F3: "context_close_hang",
    F4: "browser_close_hang",
  };
  const acquisition: Partial<Record<string, CertificationFixture["acquisition"]>> = {
    A1: "input_value",
    A2: "text_content",
    A3: "protected_network_value",
    A4: "protected_network_value",
    L1: "input_value",
    L2: "text_content",
    L3: "protected_network_value",
    L4: "copy_experience",
    L5: "download",
    L6: "visual_ocr",
    M3: "delayed_target",
    M4: "delayed_target",
    M5: "ambiguous_target",
    M6: "target_never_resolves",
    M7: "stale_target",
    N4: "protected_network_value",
  };
  const persistence: Partial<Record<string, CertificationFixture["persistence"]>> = {
    G2: "fail_before_commit",
    G3: "commit_then_lose_ack",
    G4: "process_loss_after_commit",
    G5: "partial_input_set",
    G6: "stale_fence",
    G7: "lock_timeout",
    G8: "statement_timeout",
  };
  const heartbeat: Partial<Record<string, CertificationFixture["heartbeat"]>> = {
    H2: "reject_pre_dispatch",
    H3: "reject_post_dispatch",
    H4: "never_resolve",
    H5: "late_resolution_after_owner_loss",
    H6: "shutdown_while_pending",
    H7: "lease_expiry",
  };
  const reconciliation: Partial<Record<string, CertificationFixture["reconciliation"]>> = {
    J2: "unknown",
    J3: "never_resolve",
    J4: "clean_session_hang",
    J5: "reauthentication_hang",
    J6: "continuation_failure",
  };
  const safeBoundary: Partial<Record<string, CertificationFixture["safeBoundary"]>> = {
    K2: "emitter_never_resolves",
    K3: "collector_ack_failure",
    K4: "late_emitter",
    K5: "evidence_resume_hang",
  };
  if (response[id]) fixture.response = response[id]!;
  if (request[id]) fixture.request = request[id]!;
  if (dispatch[id]) fixture.dispatchFault = dispatch[id]!;
  if (browser[id]) fixture.browserFault = browser[id]!;
  if (acquisition[id]) fixture.acquisition = acquisition[id]!;
  if (persistence[id]) fixture.persistence = persistence[id]!;
  if (heartbeat[id]) fixture.heartbeat = heartbeat[id]!;
  if (reconciliation[id]) fixture.reconciliation = reconciliation[id]!;
  if (safeBoundary[id]) fixture.safeBoundary = safeBoundary[id]!;
  if (id === "F2") fixture.acquisition = "target_never_resolves";
  if (id === "F5") fixture.response = "body_never_resolves";
  if (id === "M2") fixture.control = "semantic_custom_control";
  if (id === "M5") fixture.control = "ambiguous_control";
  if (id === "M6") fixture.control = "disappearing_control";
  if (id === "M3" || id === "M4") fixture.control = "disabled_delayed_control";
  if (id === "N4") fixture.response = "body_never_resolves";
  if (id.startsWith("I-"))
    fixture.processLossState = id.slice(2).replace(/-(one_time|read_only)$/u, "") as NonNullable<
      CertificationFixture["processLossState"]
    >;
  return fixture;
}
function contractFor(id: string, semantics: Semantics, highRisk: boolean): CertificationContract {
  const explicitlyUnsupported = id === "C3E" || id === "C3W" || id === "L5" || id === "L6";
  const preDispatch =
    ["D1", "E1", "M5", "M6", "M7"].includes(id) ||
    id.startsWith("I-planned-") ||
    id.startsWith("I-preparing-") ||
    id.startsWith("I-ready_to_dispatch-");
  const replay = id.startsWith("O");
  const failClosed =
    highRisk ||
    explicitlyUnsupported ||
    preDispatch ||
    /^(B5|B6|B7|B8|B9F|C1|C2|G2|G5|G6|G7|G8|J2|J6|K3|N2|N3|N5)$/u.test(id);
  return {
    finalStates: replay
      ? ["completed", "failed_not_applied", "recovery_required", "compromised"]
      : failClosed
        ? preDispatch || semantics === "read_only"
          ? ["failed_not_applied"]
          : ["recovery_required"]
        : ["completed"],
    maxDispatches: replay || preDispatch ? 0 : 1,
    redispatches: 0,
    ...(failClosed ? { maxReferences: 0 } : {}),
    liveOwnershipAfterClose: false,
  };
}
function parseArgs(args: string[]) {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  return {
    family: value("--family") as Family | undefined,
    cell: value("--cell"),
    repetitions: number(value("--repetitions")),
    seed: number(value("--seed")),
    report: value("--report"),
    adapterChild: args.includes("--adapter-child"),
  };
}
function number(value: string | undefined) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error("PROTECTED_CERTIFICATION_ARGUMENT_INVALID");
  return parsed;
}

async function execute(
  cell: Cell,
  repetition: number,
  seed: number,
  currentRunId: string,
): Promise<Result> {
  const started = performance.now();
  // Production deadlines intentionally unref their timers. Keep the harness
  // owner alive while an adapter is pending so those deadlines can fire even
  // when the certification script has no unrelated event-loop handles.
  const keepAlive = setInterval(() => undefined, 1_000);
  const directWork =
    cell.highRisk &&
    (["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "N", "O"] as Family[]).includes(cell.family)
      ? executeIsolatedDirectAdapter(cell, seed)
      : executeDirectAdapter(cell);
  const direct = await directWork
    .catch((error): DirectObservation => ({
      executed: true,
      contractSatisfied: false,
      finalProtectedState: "not_applicable",
      mutationOutcome: "not_applicable",
      acquisitionState: "not_applicable",
      persistenceState: "not_applicable",
      safeBoundaryState: "sealed",
      dispatchCount: null,
      redispatchCount: 0,
      referenceCount: null,
      activeLease: false,
      browserOwnerCount: 0,
      partialCommit: false,
      plaintextLeak: false,
      staleFenceAdvancement: false,
      lateStateAdvancement: false,
      reasonCode: safeReason(error, "CERTIFICATION_ADAPTER_FAILED"),
      harnessError: true,
    }))
    .finally(() => clearInterval(keepAlive));
  if (direct) {
    const actualClassification: ResultStatus = direct.watchdog
      ? "WATCHDOG_TIMEOUT"
      : direct.harnessError
        ? "HARNESS_ERROR"
        : direct.contractSatisfied
          ? cell.expectedClassification
          : "NEW_DEFECT";
    return {
      runId: currentRunId,
      cellId: cell.id,
      family: cell.family,
      repetition,
      iteration: repetition,
      seed,
      semantics: cell.semantics,
      expectedClassification: cell.expectedClassification,
      actualClassification,
      resultStatus: actualClassification,
      adapterExecuted: direct.executed,
      dispatchCount: direct.dispatchCount,
      redispatchCount: direct.redispatchCount,
      finalProtectedState: direct.finalProtectedState,
      mutationOutcome: direct.mutationOutcome,
      acquisitionState: direct.acquisitionState,
      persistenceState: direct.persistenceState,
      referenceCount: direct.referenceCount,
      activeLease: direct.activeLease,
      activeProtectedLease: direct.activeLease,
      activeRuntimeLease: false,
      browserOwnerCount: direct.browserOwnerCount,
      activeBrowserOwner: direct.browserOwnerCount > 0,
      safeBoundaryState: direct.safeBoundaryState,
      partialCommit: direct.partialCommit,
      plaintextLeak: direct.plaintextLeak,
      staleFenceAdvancement: direct.staleFenceAdvancement,
      lateStateAdvancement: direct.lateStateAdvancement,
      durationMs: Math.round(performance.now() - started),
      reasonCode: direct.reasonCode,
      passed:
        actualClassification === "PASS" ||
        actualClassification === "EXPECTED_FAIL_CLOSED" ||
        actualClassification === "EXPLICITLY_UNSUPPORTED",
    };
  }
  const command = probeCommand(cell);
  // Broad unit-suite success is deliberately not certification evidence. A
  // cell adapter must emit its observed record over the certification protocol
  // before the runner may populate dispatch, durable-state, privacy, or cleanup
  // fields. Until an adapter is registered, fail closed without spending the
  // requested repetitions rerunning an unrelated suite.
  if (!command.certificationEvidence) {
    return {
      runId: currentRunId,
      cellId: cell.id,
      family: cell.family,
      repetition,
      iteration: repetition,
      seed,
      semantics: cell.semantics,
      expectedClassification: cell.expectedClassification,
      actualClassification: "EVIDENCE_UNAVAILABLE",
      resultStatus: "EVIDENCE_UNAVAILABLE",
      adapterExecuted: false,
      dispatchCount: null,
      redispatchCount: 0,
      finalProtectedState: "unknown",
      mutationOutcome: "unknown",
      acquisitionState: "unknown",
      persistenceState: "unknown",
      referenceCount: null,
      activeLease: false,
      activeProtectedLease: false,
      activeRuntimeLease: false,
      browserOwnerCount: 0,
      activeBrowserOwner: false,
      safeBoundaryState: "unknown",
      partialCommit: false,
      plaintextLeak: false,
      staleFenceAdvancement: false,
      lateStateAdvancement: false,
      durationMs: Math.round(performance.now() - started),
      reasonCode: "CERTIFICATION_DIRECT_EVIDENCE_UNAVAILABLE",
      passed: false,
    };
  }
  const execution = await child(
    command.command,
    command.args,
    command.env,
    cell.highRisk ? 30_000 : 60_000,
  );
  throw new Error(
    execution.watchdog
      ? "CERTIFICATION_CHILD_WATCHDOG"
      : "CERTIFICATION_EVIDENCE_PROTOCOL_NOT_IMPLEMENTED",
  );
}
type DirectObservation = {
  executed: true;
  contractSatisfied: boolean;
  finalProtectedState: string;
  mutationOutcome: string;
  acquisitionState: string;
  persistenceState: string;
  safeBoundaryState: string;
  dispatchCount: number | null;
  redispatchCount: number;
  referenceCount: number | null;
  activeLease: boolean;
  browserOwnerCount: number;
  partialCommit: boolean;
  plaintextLeak: boolean;
  staleFenceAdvancement: boolean;
  lateStateAdvancement: boolean;
  reasonCode: string | null;
  harnessError?: boolean;
  watchdog?: boolean;
};
async function executeDirectAdapter(cell: Cell): Promise<DirectObservation | undefined> {
  if (
    cell.family === "B" ||
    cell.family === "C" ||
    cell.id === "A4" ||
    (cell.family === "N" && ["N1", "N2", "N3", "N4", "N5"].includes(cell.id))
  )
    return responseLifecycleAdapter(cell);
  if (cell.family === "N") return readOnlyLifecycleAdapter(cell);
  if (cell.family === "L" || ["A1", "A2", "A3"].includes(cell.id))
    return acquisitionMethodAdapter(cell);
  if (cell.family === "M") return semanticControlAdapter(cell);
  if (cell.family === "F") return cleanupAdapter(cell);
  if (cell.family === "G") return persistenceAdapter(cell);
  if (cell.family === "K") return safeBoundaryAdapter(cell);
  if (cell.family === "D") return dispatchFaultAdapter(cell);
  if (cell.family === "E") return browserLifecycleAdapter(cell);
  if (cell.family === "H") return heartbeatAdapter(cell);
  if (cell.family === "I") return processLossAdapter(cell);
  if (cell.family === "J") return reconciliationAdapter(cell);
  if (cell.family === "O") return terminalReplayAdapter(cell);
  return undefined;
}
async function readOnlyLifecycleAdapter(cell: Cell): Promise<DirectObservation> {
  const fixture = await ProtectedCertificationDatabase.create();
  const firstId = `cert-${cell.id.toLowerCase()}-${randomUUID()}`;
  const canary = `staged-canary-${randomUUID()}`;
  try {
    await fixture.createOperation(firstId, "read_only");
    let claim: ProtectedOperationClaim = await fixture.claimOperation(
      firstId,
      fixture.leaseOwner,
      "read_only",
    );
    claim = await fixture.moveTo(claim, "dispatching");
    const stageContext = {
      protectedOperationId: claim.id,
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      missionId: fixture.missionId,
      objectiveId: fixture.objectiveId,
      agentSessionId: fixture.agentSessionId,
      ownerKind: "authoring_session" as const,
      ownerId: fixture.sessionId,
      operationId: firstId,
      leaseOwner: fixture.leaseOwner,
      fencingToken: claim.fencingToken,
      version: claim.version,
    };
    await fixture.outputs.stageResponseOutputs(stageContext, [
      {
        reference: "publicValue",
        classification: "public",
        storageName: "Public value",
        value: "stale-public",
        scope: "project",
      },
      {
        reference: "protectedValue",
        classification: "protected",
        storageName: "Protected value",
        value: canary,
        scope: "project",
      },
    ]);
    claim = await fixture.operations.transition({
      id: claim.id,
      leaseOwner: fixture.leaseOwner,
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "dispatching",
      next: "failed_not_applied",
      phase: "failed_not_applied",
      reasonCode: "READ_ONLY_RESPONSE_UNAVAILABLE",
    });
    const staging = await fixture.database.query<{ count: number }>(
      `SELECT count(*)::int count FROM protected_response_output_staging WHERE protected_operation_id=$1`,
      [claim.id],
    );
    if (cell.id === "N6") {
      const observed = await fixture.observe(firstId);
      return baseObservation({
        contractSatisfied: observed.state === "failed_not_applied" && staging.rows[0]!.count === 0,
        finalProtectedState: observed.state,
        mutationOutcome: observed.mutationOutcome,
        acquisitionState: "failed",
        persistenceState: "not_started",
        referenceCount: 0,
        dispatchCount: observed.dispatchCount,
        safeBoundaryState: "sealed",
        plaintextLeak: JSON.stringify({ observed, staging: staging.rows[0] }).includes(canary),
        reasonCode: "READ_ONLY_STAGING_DISPOSED",
      });
    }
    const retryId = `${firstId}-retry`;
    await fixture.createOperation(retryId, "read_only");
    let retry: ProtectedOperationClaim = await fixture.claimOperation(
      retryId,
      fixture.leaseOwner,
      "read_only",
    );
    retry = await fixture.moveTo(retry, "persisting");
    const persisted = await fixture.outputs.persistOutputsAtomically(
      {
        protectedOperationId: retry.id,
        projectId: fixture.projectId,
        environmentId: fixture.environmentId,
        missionId: fixture.missionId,
        objectiveId: fixture.objectiveId,
        agentSessionId: fixture.agentSessionId,
        ownerKind: "authoring_session",
        ownerId: fixture.sessionId,
        operationId: retryId,
        leaseOwner: fixture.leaseOwner,
        fencingToken: retry.fencingToken,
        version: retry.version,
      },
      [
        {
          reference: "publicValue",
          classification: "public",
          storageName: "Public value",
          value: "fresh-public",
          scope: "project",
        },
        {
          reference: "protectedValue",
          classification: "protected",
          storageName: "Protected value",
          value: `fresh-${randomUUID()}`,
          scope: "project",
        },
      ],
    );
    retry = await fixture.moveTo(persisted.claim, "completed");
    const observedRetry = await fixture.observe(retryId);
    const first = await fixture.observe(firstId);
    const refs = Object.keys(observedRetry.references ?? {}).length;
    return baseObservation({
      contractSatisfied:
        first.state === "failed_not_applied" &&
        staging.rows[0]!.count === 0 &&
        observedRetry.state === "completed" &&
        refs === 2 &&
        first.dispatchCount === 1 &&
        observedRetry.dispatchCount === 1,
      finalProtectedState: observedRetry.state,
      mutationOutcome: observedRetry.mutationOutcome,
      acquisitionState: "completed",
      persistenceState: "committed",
      referenceCount: refs,
      dispatchCount: observedRetry.dispatchCount,
      redispatchCount: Math.max(0, observedRetry.dispatchCount - 1),
      safeBoundaryState: "sealed",
      reasonCode: "READ_ONLY_RETRY_USED_FRESH_OPERATION",
    });
  } finally {
    await fixture.close();
  }
}
async function acquisitionMethodAdapter(cell: Cell): Promise<DirectObservation> {
  const fixture = await ProtectedCertificationDatabase.create();
  const operationId = `cert-${cell.id.toLowerCase()}-${randomUUID()}`;
  const canary = `acquisition-canary-${randomUUID()}`;
  const driver = new NativeBrowserDriver();
  const owned = await driver.openBrowser({}, { kind: "protected_capsule", ownerId: operationId });
  let unregister: (() => void) | undefined;
  try {
    await fixture.createOperation(operationId, "one_time");
    let claim: ProtectedOperationClaim = await fixture.claimOperation(operationId);
    claim = await fixture.moveTo(claim, "acquiring");
    const method = cell.fixture.acquisition;
    const role = method === "download" ? "link" : method === "visual_ocr" ? "region" : "textbox";
    const name =
      method === "download"
        ? "Download"
        : method === "visual_ocr"
          ? "Visual value"
          : "Generated value";
    if (method === "text_content")
      await owned.page.setContent(`<output aria-label="Generated value">${canary}</output>`);
    else if (method === "copy_experience") {
      await owned.page.setContent(
        `<div role="group"><label>Generated value<input value="${canary}"></label><button>Copy</button></div>`,
      );
      await owned.page.evaluate(() =>
        document
          .querySelector("button")
          ?.addEventListener("click", () => document.dispatchEvent(new ClipboardEvent("copy"))),
      );
    } else if (method === "download")
      await owned.page.setContent(
        `<a aria-label="Download" download="value.txt" href="data:text/plain,certification-download">Download</a>`,
      );
    else if (method === "visual_ocr")
      await owned.page.setContent(
        `<div role="region" aria-label="Visual value" style="font-size:32px">CERTIFICATION OCR</div>`,
      );
    else await owned.page.setContent(`<label>Generated value<input value="${canary}"></label>`);
    const adapterId = `certification.${randomUUID()}`;
    if (method === "protected_network_value")
      unregister = registerProtectedAcquisitionAdapter(adapterId, async () => canary);
    const acquisition = {
      target: {
        concept: "generated_value",
        requiredCapabilities: ["readable_value"],
        preferredEvidence: {
          roles: [role],
          names: [name],
          labels: [name],
          descriptions: [],
          placeholders: [],
          inputTypes: method === "input_value" ? ["text"] : [],
        },
        scope: { kind: "page" },
        relations: [],
        prohibited: ["hidden", "disabled"],
        risk: "protected",
        confidence: { requiredFamilies: [] },
      },
      classification: "unknown_secret",
      objective:
        method === "copy_experience"
          ? { kind: "verify_user_copy_experience", expectedValueType: "unknown_secret" }
          : { kind: "capture_value", expectedValueType: "unknown_secret" },
      permittedMethods: [
        method === "visual_ocr"
          ? "ocr_region"
          : method === "download"
            ? "download_content"
            : method === "copy_experience"
              ? "copy_control"
              : method,
      ],
      ...(method === "protected_network_value"
        ? { adapter: { id: adapterId, configuration: {} } }
        : {}),
      validation: { minimumLength: 1, maximumLength: 200 },
    };
    const acquisitionResult = await acquireValue(owned.page, acquisition as never, 2_000);
    const captured =
      acquisitionResult.result?.kind === "captured_value" ? acquisitionResult.value : undefined;
    let references = 0;
    if (captured) {
      claim = await fixture.moveTo(claim, "persisting");
      const persisted = await fixture.outputs.persistOutputsAtomically(
        {
          protectedOperationId: claim.id,
          projectId: fixture.projectId,
          environmentId: fixture.environmentId,
          missionId: fixture.missionId,
          objectiveId: fixture.objectiveId,
          agentSessionId: fixture.agentSessionId,
          ownerKind: "authoring_session",
          ownerId: fixture.sessionId,
          operationId,
          leaseOwner: fixture.leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
        },
        [
          {
            reference: "publicValue",
            classification: "public",
            storageName: "Public value",
            value: "opaque-public",
            scope: "project",
          },
          {
            reference: "protectedValue",
            classification: "protected",
            storageName: "Protected value",
            value: captured,
            scope: "project",
          },
        ],
      );
      claim = await fixture.moveTo(persisted.claim, "completed");
      references = 2;
    } else if (acquisitionResult.result?.kind === "copy_experience_verified") {
      claim = await fixture.moveTo(claim, "completed");
    } else {
      claim = await fixture.operations.transition({
        id: claim.id,
        leaseOwner: fixture.leaseOwner,
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next: "recovery_required",
        phase: "recovery_required",
        reasonCode: "ACQUISITION_UNAVAILABLE",
      });
    }
    const observed = await fixture.observe(operationId);
    await owned.context.close().catch(() => undefined);
    await owned.browser.close().catch(() => owned.forceClose());
    const released = owned.ownership.events.some(
      (event) => event.milestone === "ownership_released",
    );
    const mandatory = ["A1", "A2", "A3", "L1", "L2", "L3", "L4"].includes(cell.id);
    const methodObserved = acquisitionResult.result !== undefined;
    return baseObservation({
      contractSatisfied: mandatory
        ? methodObserved && observed.state === "completed"
        : ["completed", "recovery_required"].includes(observed.state),
      finalProtectedState: observed.state,
      mutationOutcome: observed.mutationOutcome,
      acquisitionState: methodObserved ? "completed" : "failed",
      persistenceState: references ? "committed" : "not_started",
      referenceCount: references,
      dispatchCount: observed.dispatchCount,
      browserOwnerCount: released ? 0 : 1,
      safeBoundaryState: "sealed",
      plaintextLeak: JSON.stringify({
        observed,
        result: acquisitionResult.result && {
          ...acquisitionResult.result,
          ...("value" in acquisitionResult.result ? { value: "[REDACTED]" } : {}),
        },
      }).includes(canary),
      reasonCode: mandatory
        ? null
        : observed.state === "completed"
          ? "EXPERIMENTAL_ACQUISITION_SUCCEEDED"
          : "EXPERIMENTAL_ACQUISITION_FAILED_CLOSED",
    });
  } finally {
    unregister?.();
    await owned.context.close().catch(() => undefined);
    await owned.browser.close().catch(() => owned.forceClose().catch(() => undefined));
    await fixture.close();
  }
}
async function semanticControlAdapter(cell: Cell): Promise<DirectObservation> {
  const fixture = await ProtectedCertificationDatabase.create();
  const operationId = `cert-${cell.id.toLowerCase()}-${randomUUID()}`;
  const driver = new NativeBrowserDriver();
  const owned = await driver.openBrowser({}, { kind: "protected_capsule", ownerId: operationId });
  let dispatches = 0;
  const server = createServer((request, response) => {
    if (request.url === "/dispatch") {
      dispatches += 1;
      response.writeHead(204).end();
      return;
    }
    response.setHeader("content-type", "text/html");
    const normal = `<button aria-label="Activate" onclick="fetch('/dispatch',{method:'POST'})">Activate</button>`;
    const html =
      cell.id === "M2"
        ? `<div role="button" tabindex="0" aria-label="Activate" onclick="fetch('/dispatch',{method:'POST'})">Activate</div>`
        : cell.id === "M3"
          ? `<main></main><script>setTimeout(()=>document.querySelector('main').innerHTML=${JSON.stringify(normal)},50)</script>`
          : cell.id === "M4"
            ? `<button disabled aria-label="Activate" onclick="fetch('/dispatch',{method:'POST'})">Activate</button><script>setTimeout(()=>document.querySelector('button').disabled=false,50)</script>`
            : cell.id === "M5"
              ? `${normal}${normal}`
              : cell.id === "M6"
                ? `<main><p>Stable certification surface</p>${normal}</main><script>document.querySelector('button').remove()</script>`
                : cell.id === "M7"
                  ? `<main>${normal}</main><script>document.querySelector('button').remove();document.querySelector('main').innerHTML='<button aria-label="Changed">Changed</button>'</script>`
                  : normal;
    response.end(`<!doctype html>${html}`);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("CERTIFICATION_CONTROL_SERVER_UNAVAILABLE");
    const origin = `http://127.0.0.1:${address.port}`;
    await driver.navigateAndWait(owned.page, origin, [origin], 2_000);
    await fixture.createOperation(operationId, "one_time");
    let claim: ProtectedOperationClaim = await fixture.claimOperation(operationId);
    claim = await fixture.moveTo(claim, "ready_to_dispatch");
    const target = {
      concept: "activate",
      requiredCapabilities: ["focusable", "pointer_activatable"],
      preferredEvidence: {
        roles: ["button"],
        names: ["Activate"],
        labels: ["Activate"],
        descriptions: [],
        placeholders: [],
        inputTypes: [],
      },
      scope: { kind: "page" },
      relations: [],
      prohibited: ["hidden", "disabled"],
      risk: "protected",
      confidence: { requiredFamilies: [] },
      matching: "exact",
    };
    let failure: unknown;
    try {
      await requirePraxisSuccess({
        page: owned.page,
        intent: target as never,
        operation: { type: "activate" },
        context: {
          stepId: operationId,
          channel: "protected",
          ordinal: 0,
          allowedOrigins: [origin],
          timeoutMs: 1_000,
          privacy: {
            state: "protected",
            allowedChannels: ["public_dom", "accessibility"],
            suppressedChannels: ["visual", "ocr"],
          },
          beforeMutation: async () => {
            claim = await fixture.operations.transition({
              id: claim.id,
              leaseOwner: fixture.leaseOwner,
              fencingToken: claim.fencingToken,
              version: claim.version,
              expected: "ready_to_dispatch",
              next: "dispatching",
              phase: "dispatching",
            });
          },
        },
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    } catch (error) {
      failure = error;
    }
    if (dispatches === 1 && claim.state === "dispatching") {
      claim = await fixture.moveTo(claim, "persisting");
      const persisted = await fixture.outputs.persistOutputsAtomically(
        {
          protectedOperationId: claim.id,
          projectId: fixture.projectId,
          environmentId: fixture.environmentId,
          missionId: fixture.missionId,
          objectiveId: fixture.objectiveId,
          agentSessionId: fixture.agentSessionId,
          ownerKind: "authoring_session",
          ownerId: fixture.sessionId,
          operationId,
          leaseOwner: fixture.leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
        },
        [
          {
            reference: "publicValue",
            classification: "public",
            storageName: "Public value",
            value: "opaque",
            scope: "project",
          },
          {
            reference: "protectedValue",
            classification: "protected",
            storageName: "Protected value",
            value: `control-${randomUUID()}`,
            scope: "project",
          },
        ],
      );
      claim = await fixture.moveTo(persisted.claim, "completed");
    } else if (claim.state === "ready_to_dispatch") {
      claim = await fixture.operations.transition({
        id: claim.id,
        leaseOwner: fixture.leaseOwner,
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: "ready_to_dispatch",
        next: "failed_not_applied",
        phase: "failed_not_applied",
        reasonCode: "CONTROL_NOT_DISPATCHED",
      });
    } else if (claim.state === "dispatching") {
      claim = await fixture.operations.transition({
        id: claim.id,
        leaseOwner: fixture.leaseOwner,
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: "dispatching",
        next: "recovery_required",
        phase: "recovery_required",
        reasonCode: "CONTROL_DISPATCH_UNCERTAIN",
      });
    }
    const observed = await fixture.observe(operationId);
    await owned.context.close().catch(() => undefined);
    await owned.browser.close().catch(() => owned.forceClose());
    const released = owned.ownership.events.some(
      (event) => event.milestone === "ownership_released",
    );
    const shouldDispatch = ["M1", "M2", "M3", "M4"].includes(cell.id);
    return baseObservation({
      contractSatisfied:
        dispatches === (shouldDispatch ? 1 : 0) &&
        observed.state === (shouldDispatch ? "completed" : "failed_not_applied") &&
        released,
      finalProtectedState: observed.state,
      mutationOutcome: observed.mutationOutcome,
      acquisitionState: shouldDispatch ? "completed" : "not_started",
      persistenceState: shouldDispatch ? "committed" : "not_started",
      referenceCount: Object.keys(observed.references ?? {}).length,
      dispatchCount: dispatches,
      browserOwnerCount: released ? 0 : 1,
      safeBoundaryState: "sealed",
      reasonCode: failure ? safeReason(failure, "CONTROL_RESOLUTION_FAILED") : null,
    });
  } finally {
    await owned.context.close().catch(() => undefined);
    await owned.browser.close().catch(() => owned.forceClose().catch(() => undefined));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  }
}
async function responseLifecycleAdapter(cell: Cell): Promise<DirectObservation> {
  const fixture = await ProtectedCertificationDatabase.create();
  const operationId = `cert-${cell.id.toLowerCase()}-${randomUUID()}`;
  const semantics = cell.semantics === "read_only" ? "read_only" : "one_time";
  const canary = `response-canary-${randomUUID()}`;
  try {
    await fixture.createOperation(operationId, semantics);
    let claim: ProtectedOperationClaim = await fixture.claimOperation(
      operationId,
      fixture.leaseOwner,
      semantics,
    );
    claim = await fixture.moveTo(claim, "dispatching");
    const listeners = new Map<string, (value: any) => void>();
    const page = {
      on: (event: string, callback: (value: any) => void) => {
        listeners.set(event, callback);
      },
      off: () => undefined,
    };
    const staged: Array<{
      reference: string;
      classification: "public" | "protected";
      name: string;
      value: string;
      scope: "project";
    }> = [];
    const output = (
      reference: "publicValue" | "protectedValue",
      classification: "public" | "protected",
    ) => ({
      reference,
      classification,
      storage:
        classification === "protected"
          ? { scope: "project", credentialName: "Protected value" }
          : { scope: "project", name: "Public value" },
      acquisition: {
        target: {
          concept: reference,
          requiredCapabilities: [],
          preferredEvidence: {
            roles: [],
            names: [reference],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: [],
          risk: "protected",
          confidence: { requiredFamilies: [] },
        },
        classification: classification === "protected" ? "unknown_secret" : "public",
        permittedMethods: ["protected_network_value"],
      },
    });
    const allowedOrigins =
      cell.id === "B9P"
        ? ["https://fixture.test", "https://allowed.test"]
        : ["https://fixture.test"];
    const envelope = beginProtectedResponseEnvelope(
      page as never,
      allowedOrigins,
      new SecretRedactor(),
      {
        outputs: [output("publicValue", "public"), output("protectedValue", "protected")] as never,
        stage: async (values) => {
          staged.splice(0, staged.length, ...(values as typeof staged));
        },
      },
    );
    let emittedRequest:
      | {
          method: () => string;
          resourceType: () => string;
          url: () => string;
          redirectedFrom: () => any;
          redirectedTo: () => any;
        }
      | undefined;
    const emitRequest = (
      resourceType: string,
      url = "https://fixture.test/values",
      redirectedFrom?: typeof emittedRequest,
    ) => {
      let redirectedTo: typeof emittedRequest;
      emittedRequest = {
        method: () => "POST",
        resourceType: () => resourceType,
        url: () => url,
        redirectedFrom: () => redirectedFrom ?? null,
        redirectedTo: () => redirectedTo ?? null,
      };
      if (redirectedFrom) {
        const descendant = emittedRequest;
        redirectedFrom.redirectedTo = () => descendant;
      }
      listeners.get("request")?.(emittedRequest);
    };
    envelope.beginActionCapture();
    if (cell.fixture.request === "unsupported_websocket") listeners.get("websocket")?.({});
    else if (cell.fixture.request === "unsupported_eventsource") emitRequest("eventsource");
    else if (cell.fixture.request !== "no_request")
      emitRequest(
        cell.fixture.request === "xhr" ? "xhr" : "fetch",
        cell.fixture.request === "outside_envelope"
          ? "https://outside.test/values"
          : "https://fixture.test/values",
      );
    envelope.endActionCapture();
    const responseUrl =
      cell.fixture.response === "redirect_allowed_origin"
        ? "https://allowed.test/values"
        : cell.fixture.response === "redirect_forbidden_origin" ||
            cell.fixture.request === "outside_envelope"
          ? "https://outside.test/values"
          : "https://fixture.test/values";
    let redirectRootRequest: typeof emittedRequest;
    if (
      emittedRequest &&
      ["redirect_same_origin", "redirect_allowed_origin", "redirect_forbidden_origin"].includes(
        cell.fixture.response,
      )
    ) {
      const rootRequest = emittedRequest;
      redirectRootRequest = rootRequest;
      emitRequest("fetch", responseUrl, rootRequest);
    }
    const normalBody = () =>
      Buffer.from(JSON.stringify({ publicValue: "opaque-public", protectedValue: canary }));
    const response = (
      body: () => Promise<Buffer>,
      overrides: { headers?: Record<string, string>; url?: string } = {},
    ) => ({
      request: () => emittedRequest ?? { method: () => "POST" },
      url: () => overrides.url ?? responseUrl,
      status: () => 200,
      headers: () => overrides.headers ?? { "content-type": "application/json" },
      body,
    });
    if (redirectRootRequest) {
      listeners.get("response")?.({
        request: () => redirectRootRequest,
        url: () => redirectRootRequest!.url(),
        status: () => 302,
        headers: () => ({ "content-type": "text/html" }),
        body: async () => Buffer.alloc(0),
      });
    }
    let releaseLate: (() => void) | undefined;
    if (
      !["no_request", "unsupported_eventsource", "unsupported_websocket"].includes(
        cell.fixture.request,
      )
    ) {
      if (cell.fixture.response === "body_never_resolves")
        listeners.get("response")?.(response(() => new Promise<Buffer>(() => undefined)));
      else if (cell.fixture.response === "body_rejects")
        listeners.get("response")?.(
          response(() => Promise.reject(new Error("FIXTURE_BODY_REJECTED"))),
        );
      else if (cell.fixture.response === "malformed_json")
        listeners.get("response")?.(response(async () => Buffer.from("{malformed")));
      else if (cell.fixture.response === "oversized_json")
        listeners.get("response")?.(
          response(async () => normalBody(), {
            headers: { "content-type": "application/json", "content-length": String(65 * 1024) },
          }),
        );
      else if (cell.fixture.response === "mixed_complete_and_stuck") {
        listeners.get("response")?.(
          response(async () => Buffer.from(JSON.stringify({ publicValue: "opaque-public" }))),
        );
        listeners.get("response")?.(response(() => new Promise<Buffer>(() => undefined)));
      } else if (cell.fixture.response === "delayed_below_deadline")
        listeners.get("response")?.(
          response(() => new Promise((resolve) => setTimeout(() => resolve(normalBody()), 5))),
        );
      else if (cell.fixture.response === "delayed_above_deadline")
        listeners.get("response")?.(
          response(() => new Promise((resolve) => setTimeout(() => resolve(normalBody()), 40))),
        );
      else if (cell.fixture.response === "late_after_envelope_close") {
        const late = new Promise<Buffer>((resolve) => {
          releaseLate = () => resolve(normalBody());
        });
        listeners.get("response")?.(response(() => late));
      } else listeners.get("response")?.(response(async () => normalBody()));
    }
    const requestObservation = await envelope.waitForRequestInitiation(10);
    const settled = await envelope.settle(20);
    await envelope.close();
    releaseLate?.();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const requestSupported = ![
      "not_observed",
      "outside_envelope",
      "unsupported_transport",
    ].includes(requestObservation.status);
    const completeSet =
      staged.length === 2 && new Set(staged.map((value) => value.reference)).size === 2;
    if (completeSet && settled && requestSupported) {
      claim = await fixture.moveTo(claim, "persisting");
      const persisted = await fixture.outputs.persistOutputsAtomically(
        {
          protectedOperationId: claim.id,
          projectId: fixture.projectId,
          environmentId: fixture.environmentId,
          missionId: fixture.missionId,
          objectiveId: fixture.objectiveId,
          agentSessionId: fixture.agentSessionId,
          ownerKind: "authoring_session",
          ownerId: fixture.sessionId,
          operationId,
          leaseOwner: fixture.leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
        },
        staged.map((value) => ({
          reference: value.reference,
          classification: value.classification,
          storageName: value.name,
          value: value.value,
          scope: value.scope,
        })),
      );
      claim = await fixture.moveTo(persisted.claim, "completed");
    } else {
      claim = await fixture.operations.transition({
        id: claim.id,
        leaseOwner: fixture.leaseOwner,
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next: semantics === "read_only" ? "failed_not_applied" : "recovery_required",
        phase: semantics === "read_only" ? "failed_not_applied" : "recovery_required",
        reasonCode:
          requestObservation.status === "unsupported_transport"
            ? "PROTECTED_TRANSPORT_UNSUPPORTED"
            : "PROTECTED_RESPONSE_UNAVAILABLE",
      });
    }
    const observed = await fixture.observe(operationId);
    const references = Object.keys(observed.references ?? {}).length;
    const expectedSuccess = ["A4", "B2", "B9S", "B9P", "C4", "C5", "N1"].includes(cell.id);
    const explicitlyUnsupported = cell.expectedClassification === "EXPLICITLY_UNSUPPORTED";
    const expectedState = expectedSuccess
      ? "completed"
      : semantics === "read_only"
        ? "failed_not_applied"
        : "recovery_required";
    const serializedEvidence = JSON.stringify({
      observed,
      requestObservation,
      settled,
      staged: staged.map(({ value: _value, ...safe }) => safe),
    });
    return baseObservation({
      contractSatisfied:
        observed.state === expectedState && references === (expectedSuccess ? 2 : 0),
      finalProtectedState: observed.state,
      mutationOutcome: observed.mutationOutcome,
      acquisitionState: expectedSuccess ? "completed" : "failed",
      persistenceState: expectedSuccess ? "committed" : "not_started",
      referenceCount: references,
      dispatchCount: observed.dispatchCount,
      safeBoundaryState: "sealed",
      plaintextLeak: serializedEvidence.includes(canary),
      partialCommit: references === 1,
      lateStateAdvancement:
        cell.fixture.response === "late_after_envelope_close" && staged.length > 0,
      reasonCode: explicitlyUnsupported
        ? "PROTECTED_TRANSPORT_UNSUPPORTED"
        : expectedSuccess
          ? null
          : "PROTECTED_RESPONSE_UNAVAILABLE",
    });
  } finally {
    await fixture.close();
  }
}
async function persistenceAdapter(cell: Cell): Promise<DirectObservation> {
  const fixture = await ProtectedCertificationDatabase.create();
  const operationId = `cert-${cell.id.toLowerCase()}-${randomUUID()}`;
  const canary = `certification-canary-${randomUUID()}`;
  try {
    await fixture.createOperation(operationId, "one_time");
    let claim: ProtectedOperationClaim = await fixture.claimOperation(operationId);
    claim = await fixture.moveTo(claim, "persisting");
    const context = () => ({
      protectedOperationId: claim.id,
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      missionId: fixture.missionId,
      objectiveId: fixture.objectiveId,
      agentSessionId: fixture.agentSessionId,
      ownerKind: "authoring_session" as const,
      ownerId: fixture.sessionId,
      operationId,
      leaseOwner: fixture.leaseOwner,
      fencingToken: claim.fencingToken,
      version: claim.version,
    });
    const complete = () => [
      {
        reference: "publicValue",
        classification: "public" as const,
        storageName: "Public value",
        value: "opaque-public",
        scope: "project" as const,
      },
      {
        reference: "protectedValue",
        classification: "protected" as const,
        storageName: "Protected value",
        value: canary,
        scope: "project" as const,
      },
    ];
    let reasonCode: string | null = null;
    let staleFenceAdvanced = false;
    if (cell.id === "G1") {
      const persisted = await fixture.outputs.persistOutputsAtomically(context(), complete());
      claim = persisted.claim;
      claim = await fixture.moveTo(claim, "completed");
    } else if (cell.id === "G2") {
      try {
        await fixture.outputs.persistOutputsAtomically(context(), []);
      } catch (error) {
        reasonCode = safeReason(error, "PERSISTENCE_FAILED_BEFORE_COMMIT");
      }
      await fixture.database.query(
        `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        [claim.id],
      );
      claim = await fixture.claimOperation(operationId, `${fixture.leaseOwner}-recovery`);
    } else if (cell.id === "G3" || cell.id === "G4") {
      await fixture.outputs.persistOutputsAtomically(context(), complete()).then(() => undefined);
      await fixture.database.query(
        `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        [claim.id],
      );
      claim = await fixture.claimOperation(operationId, `${fixture.leaseOwner}-recovery`);
      reasonCode =
        cell.id === "G3" ? "PERSISTENCE_ACKNOWLEDGEMENT_LOST" : "PROCESS_LOSS_AFTER_COMMIT";
    } else if (cell.id === "G5") {
      try {
        await fixture.outputs.persistOutputsAtomically(context(), [complete()[0]!]);
        reasonCode = "PARTIAL_OUTPUT_SET_ACCEPTED";
      } catch (error) {
        reasonCode = safeReason(error, "PARTIAL_OUTPUT_SET_REJECTED");
      }
      const observed = await fixture.observe(operationId);
      if (observed.state === "persisting") {
        await fixture.database.query(
          `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
          [claim.id],
        );
        claim = await fixture.claimOperation(operationId, `${fixture.leaseOwner}-recovery`);
      }
    } else if (cell.id === "G6") {
      const stale = context();
      await fixture.database.query(
        `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        [claim.id],
      );
      claim = await fixture.claimOperation(operationId, `${fixture.leaseOwner}-recovery`);
      try {
        await fixture.outputs.persistOutputsAtomically(stale, complete());
        staleFenceAdvanced = true;
      } catch (error) {
        reasonCode = safeReason(error, "STALE_FENCE_REJECTED");
      }
    } else if (cell.id === "G7") {
      const blocker = await fixture.database.pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(`SELECT id FROM protected_operations WHERE id=$1 FOR UPDATE`, [
          claim.id,
        ]);
        try {
          await fixture.claimOperation(operationId, `${fixture.leaseOwner}-waiter`);
        } catch (error) {
          reasonCode = safeReason(error, "LOCK_TIMEOUT");
        }
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      await fixture.database.query(
        `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        [claim.id],
      );
      claim = await fixture.claimOperation(operationId, `${fixture.leaseOwner}-recovery`);
    } else {
      try {
        await fixture.database.query(`SELECT pg_sleep(0.5)`);
      } catch (error) {
        reasonCode = safeReason(error, "STATEMENT_TIMEOUT");
      }
      await fixture.database.query(
        `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        [claim.id],
      );
      claim = await fixture.claimOperation(operationId, `${fixture.leaseOwner}-recovery`);
    }
    const observed = await fixture.observe(operationId);
    const references = Object.keys(observed.references ?? {}).length;
    const partialCommit = references > 0 && references < 2;
    const recoveryOwnerActive =
      observed.leaseOwner !== null &&
      observed.leaseExpiresAt !== null &&
      observed.leaseExpiresAt.getTime() > Date.now();
    const serialized = JSON.stringify({ observed, reasonCode });
    const expectedReferences = cell.id === "G1" || cell.id === "G3" || cell.id === "G4" ? 2 : 0;
    const expectedState = cell.id === "G1" ? "completed" : "recovery_required";
    return baseObservation({
      contractSatisfied:
        observed.state === expectedState &&
        references === expectedReferences &&
        !partialCommit &&
        !staleFenceAdvanced,
      finalProtectedState: observed.state,
      mutationOutcome: observed.mutationOutcome,
      acquisitionState: "not_applicable",
      persistenceState: references === 2 ? "committed" : "failed",
      referenceCount: references,
      dispatchCount: observed.dispatchCount,
      // fixture.close() below destroys the isolated workspace and therefore
      // the active recovery owner's test lease. Preserve its presence only as
      // a privacy-safe reason code while reporting post-cleanup ownership.
      activeLease: false,
      partialCommit,
      staleFenceAdvancement: staleFenceAdvanced,
      plaintextLeak: serialized.includes(canary),
      reasonCode: reasonCode ?? (recoveryOwnerActive ? "ACTIVE_RECOVERY_OWNER_CLEANED" : null),
    });
  } finally {
    await fixture.close();
  }
}

async function settleFaultedOperation(
  fixture: ProtectedCertificationDatabase,
  claim: ProtectedOperationClaim,
  preDispatch: boolean,
  reasonCode: string,
) {
  return fixture.operations.transition({
    id: claim.id,
    leaseOwner: fixture.leaseOwner,
    fencingToken: claim.fencingToken,
    version: claim.version,
    expected: claim.state,
    next: preDispatch ? "failed_not_applied" : "recovery_required",
    phase: preDispatch ? "failed_not_applied" : "recovery_required",
    reasonCode,
  });
}

async function dispatchFaultAdapter(cell: Cell): Promise<DirectObservation> {
  return baseObservation(await runKernelOwnerCertification({ family: "D", cellId: cell.id }));
}

async function browserLifecycleAdapter(cell: Cell): Promise<DirectObservation> {
  return baseObservation(await runKernelOwnerCertification({ family: "E", cellId: cell.id }));
}

async function heartbeatAdapter(cell: Cell): Promise<DirectObservation> {
  return baseObservation(await runKernelOwnerCertification({ family: "H", cellId: cell.id }));
}

async function processLossAdapter(cell: Cell): Promise<DirectObservation> {
  return baseObservation(
    await runKernelOwnerCertification({
      family: "I",
      cellId: cell.id,
      ...(cell.fixture.processLossState ? { initialState: cell.fixture.processLossState } : {}),
      semantics: cell.semantics === "read_only" ? "read_only" : "one_time",
      activationPath: "mission",
    }),
  );
}

async function reconciliationAdapter(cell: Cell): Promise<DirectObservation> {
  return baseObservation(await runKernelOwnerCertification({ family: "J", cellId: cell.id }));
}

async function terminalReplayAdapter(cell: Cell): Promise<DirectObservation> {
  return baseObservation(await runPublicMissionReplayCertification(cell.id));
}
function baseObservation(overrides: Partial<DirectObservation> = {}): DirectObservation {
  return {
    executed: true,
    contractSatisfied: true,
    finalProtectedState: "not_applicable",
    mutationOutcome: "not_applicable",
    acquisitionState: "not_applicable",
    persistenceState: "not_applicable",
    safeBoundaryState: "not_applicable",
    dispatchCount: null,
    redispatchCount: 0,
    referenceCount: null,
    activeLease: false,
    browserOwnerCount: 0,
    partialCommit: false,
    plaintextLeak: false,
    staleFenceAdvancement: false,
    lateStateAdvancement: false,
    reasonCode: null,
    ...overrides,
  };
}
async function cleanupAdapter(cell: Cell): Promise<DirectObservation> {
  if (cell.id === "F1" || cell.id === "F2") {
    const clearAndVerify = () =>
      cell.id === "F2" ? new Promise<never>(() => undefined) : Promise.resolve();
    const collector = new VeilClipboardCollector(clearAndVerify, cell.id === "F2" ? 1 : 3, 5);
    collector.markProtectedClipboardTouched();
    try {
      await collector.finalize();
      return baseObservation({
        contractSatisfied: cell.id === "F1",
        reasonCode: cell.id === "F1" ? null : "CLIPBOARD_HANG_WAS_NOT_CONTAINED",
      });
    } catch (error) {
      return baseObservation({
        contractSatisfied: cell.id === "F2",
        safeBoundaryState: "sealed",
        reasonCode: safeReason(error, "VEIL_CLIPBOARD_CLEANUP_FAILED"),
      });
    }
  }
  if (cell.id === "F3" || cell.id === "F4") {
    let contextClosed = false;
    let browserClosed = false;
    let forceClosed = false;
    const context = {
      close: () =>
        cell.id === "F3"
          ? new Promise<never>(() => undefined)
          : Promise.resolve().then(() => {
              contextClosed = true;
            }),
    };
    const browser = {
      close: () =>
        cell.id === "F4"
          ? new Promise<never>(() => undefined)
          : Promise.resolve().then(() => {
              browserClosed = true;
            }),
    };
    const factory = new PlaywrightProtectedCapsuleFactory(async () => ({
      browser: browser as never,
      context: context as never,
      page: { evaluate: async () => undefined } as never,
      forceClose: async () => {
        forceClosed = true;
        browserClosed = true;
        contextClosed = true;
      },
    }));
    const capsule = await factory.create({
      storageState: { cookies: [], origins: [] },
      prepare: async () => undefined,
    });
    const outcome = await capsule.destroy();
    const released = contextClosed && browserClosed && forceClosed;
    return baseObservation({
      contractSatisfied: outcome === "force_terminated" && released,
      browserOwnerCount: released ? 0 : 1,
      safeBoundaryState: released ? "sealed" : "destruction_unproven",
      reasonCode: released ? "CAPSULE_FORCE_TERMINATED" : "CAPSULE_DESTRUCTION_UNPROVEN",
    });
  }
  const listeners = new Map<string, (value: any) => void>();
  const page = {
    on: (event: string, callback: (value: any) => void) => {
      listeners.set(event, callback);
    },
    off: () => undefined,
  };
  const envelope = beginProtectedResponseEnvelope(
    page as never,
    ["https://fixture.test"],
    new SecretRedactor(),
  );
  const ownedRequest = {
    method: () => "POST",
    resourceType: () => "fetch",
    url: () => "https://fixture.test/value",
    redirectedFrom: () => null,
    redirectedTo: () => null,
  };
  envelope.beginActionCapture();
  listeners.get("request")?.(ownedRequest);
  envelope.endActionCapture();
  listeners.get("response")?.({
    request: () => ownedRequest,
    url: () => "https://fixture.test/value",
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    body: () => new Promise<Buffer>(() => undefined),
  });
  const settled = await envelope.settle(5);
  await envelope.close();
  return baseObservation({
    contractSatisfied: !settled,
    safeBoundaryState: "sealed",
    reasonCode: "PENDING_RESPONSE_CONTAINED",
  });
}
async function safeBoundaryAdapter(cell: Cell): Promise<DirectObservation> {
  let collectorStatus: "active" | "prepared" | "suspended" | "isolated" | "sealed" | "finalized" =
    "active";
  let resumed = false;
  const collector = {
    name: "certification",
    arm: async () => {
      collectorStatus = "prepared";
    },
    suspend: async () => {
      if (cell.id === "K3") return;
      collectorStatus = "suspended";
    },
    isolate: async () => {
      collectorStatus = "isolated";
    },
    resume: async () => {
      if (cell.id === "K5") await new Promise<never>(() => undefined);
      resumed = true;
      collectorStatus = "active";
    },
    seal: async () => {
      collectorStatus = "sealed";
    },
    finalize: async () => {
      collectorStatus = "finalized";
    },
    state: () => ({ status: collectorStatus }),
  };
  let releaseLateEmitter: (() => void) | undefined;
  const emit = async ({ state }: { state: string }) => {
    if ((cell.id === "K2" || cell.id === "K4") && state === "safe_to_resume") {
      await new Promise<void>((resolve) => {
        releaseLateEmitter = resolve;
      });
    }
  };
  const gate = new VeilRuntimeCoordinator([collector], emit, 5);
  const boundary = {
    kind: "protected_surface_closed" as const,
  };
  try {
    await gate.prepare(`certification-${cell.id}`);
    await gate.beginProtected();
    await gate.markCaptured();
    await gate.beginSafeBoundary();
    await gate.confirmSafeBoundary(boundary);
    await gate.finalize();
    return baseObservation({
      contractSatisfied: cell.id === "K1",
      safeBoundaryState: gate.state(),
      reasonCode: cell.id === "K1" ? null : "SAFE_BOUNDARY_FAULT_NOT_CONTAINED",
    });
  } catch (error) {
    releaseLateEmitter?.();
    await gate.seal({ code: "CERTIFICATION_SAFE_BOUNDARY_FAILED" }).catch(() => undefined);
    await gate.finalize().catch(() => undefined);
    const failClosed = gate.state() === "sealed" && !resumed;
    return baseObservation({
      contractSatisfied: cell.id !== "K1" && failClosed,
      safeBoundaryState: gate.state(),
      lateStateAdvancement: resumed,
      reasonCode: safeReason(error, "SAFE_BOUNDARY_FAILED_CLOSED"),
    });
  }
}
function safeReason(error: unknown, fallback: string) {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : error instanceof Error
        ? error.message
        : fallback;
  return /^[A-Z0-9_: -]+$/u.test(candidate) ? candidate.slice(0, 160) : fallback;
}
async function executeIsolatedDirectAdapter(
  cell: Cell,
  seed: number,
): Promise<DirectObservation | undefined> {
  const apiRoot = path.resolve(
    process.cwd().endsWith("/apps/api") ? process.cwd() : path.join(process.cwd(), "apps/api"),
  );
  const execution = await childCapture(
    "./node_modules/.bin/tsx",
    [
      "scripts/protected-transaction-certification.ts",
      "--adapter-child",
      "--cell",
      cell.id,
      "--seed",
      String(seed),
    ],
    30_000,
    apiRoot,
  );
  if (execution.watchdog)
    return baseObservation({
      contractSatisfied: false,
      watchdog: true,
      reasonCode: "CERTIFICATION_CHILD_WATCHDOG",
    });
  if (execution.code !== 0)
    return baseObservation({
      contractSatisfied: false,
      harnessError: true,
      reasonCode: "CERTIFICATION_CHILD_FAILED",
    });
  const evidenceLine = execution.stdout
    .split("\n")
    .find((line) => line.startsWith("SCRY_CERTIFICATION_EVIDENCE="));
  if (!evidenceLine)
    return baseObservation({
      contractSatisfied: false,
      harnessError: true,
      reasonCode: "CERTIFICATION_CHILD_EVIDENCE_MISSING",
    });
  try {
    return JSON.parse(evidenceLine.slice("SCRY_CERTIFICATION_EVIDENCE=".length)) as
      DirectObservation | undefined;
  } catch {
    return baseObservation({
      contractSatisfied: false,
      harnessError: true,
      reasonCode: "CERTIFICATION_CHILD_EVIDENCE_INVALID",
    });
  }
}
function probeCommand(cell: Cell): {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  certificationEvidence: boolean;
} {
  const root = path.resolve(process.cwd(), "../..");
  if (cell.probe === "controlled")
    return {
      command: "pnpm",
      args: ["campaign:mission-first:protected-qualification"],
      certificationEvidence: false,
    };
  if (cell.probe === "veil")
    return {
      command: "pnpm",
      args: [
        "--filter",
        "@scry/veil",
        "exec",
        "vitest",
        "run",
        "test/clipboard-collector.test.ts",
        "test/runtime-coordinator.test.ts",
        "--maxWorkers=1",
      ],
      certificationEvidence: false,
    };
  if (cell.probe === "api")
    return {
      command: "pnpm",
      args: [
        "--filter",
        "@scry/api",
        "exec",
        "vitest",
        "run",
        "test/adaptive-session-kernel.runner.test.ts",
        "test/mission-flow-authoring.service.test.ts",
        "--maxWorkers=1",
      ],
      certificationEvidence: false,
    };
  if (cell.probe === "postgres")
    return {
      command: "pnpm",
      args: [
        "--filter",
        "@scry/api",
        "exec",
        "vitest",
        "run",
        "test/protected-operation.repository.integration.test.ts",
        "--maxWorkers=1",
      ],
      env: {
        ...process.env,
        SCRY_AUTHORING_TEST_DATABASE_URL:
          process.env.SCRY_AUTHORING_TEST_DATABASE_URL ??
          "postgres://scry:scry-local@127.0.0.1:54329/scry_protected_lifecycle_test",
        DATABASE_STATEMENT_TIMEOUT_MS: "250",
        DATABASE_LOCK_TIMEOUT_MS: "100",
        DATABASE_QUERY_TIMEOUT_MS: "1000",
      },
      certificationEvidence: false,
    };
  const file =
    cell.family === "B" || cell.family === "C"
      ? "test/protected-response-envelope.test.ts"
      : cell.family === "L"
        ? "test/protected-acquisition-adapters.test.ts"
        : cell.family === "M"
          ? "test/protected-extractor.test.ts"
          : "test/protected-transaction-coordinator.test.ts";
  void root;
  return {
    command: "pnpm",
    args: ["--filter", "@scry/executor", "exec", "vitest", "run", file, "--maxWorkers=1"],
    certificationEvidence: false,
  };
}
function child(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
) {
  return new Promise<{ code: number | null; watchdog: boolean }>((resolve) => {
    const childProcess = spawn(command, args, {
      cwd: path.resolve(process.cwd(), "../.."),
      env: env ?? globalThis.process.env,
      stdio: "ignore",
    });
    let watchdog = false;
    const timer = setTimeout(() => {
      watchdog = true;
      childProcess.kill("SIGKILL");
    }, timeoutMs);
    childProcess.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, watchdog });
    });
    childProcess.once("exit", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, watchdog });
    });
  });
}
function childCapture(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd = path.resolve(process.cwd(), "../.."),
) {
  return new Promise<{ code: number | null; watchdog: boolean; stdout: string }>((resolve) => {
    const childProcess = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let watchdog = false;
    childProcess.stdout.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      watchdog = true;
      childProcess.kill("SIGKILL");
    }, timeoutMs);
    childProcess.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, watchdog, stdout });
    });
    childProcess.once("exit", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, watchdog, stdout });
    });
  });
}
function aggregate(currentRunId: string, selectedCells: Cell[], values: Result[]) {
  const evidenceAuthorityAudit = cells.map(authorityAuditFor);
  const evidenceAuthorityTotals = {
    PRODUCTION_OWNER_EVIDENCE: evidenceAuthorityAudit.filter(
      (entry) => entry.verdict === "PRODUCTION_OWNER_EVIDENCE",
    ).length,
    INSUFFICIENT_EVIDENCE: evidenceAuthorityAudit.filter(
      (entry) => entry.verdict === "INSUFFICIENT_EVIDENCE",
    ).length,
  };
  const executed = values.filter((value) => value.adapterExecuted);
  const certifiedStatuses: ResultStatus[] = [
    "PASS",
    "EXPECTED_FAIL_CLOSED",
    "EXPLICITLY_UNSUPPORTED",
  ];
  const certifiedCellIds = new Set(
    values
      .filter((value) => certifiedStatuses.includes(value.actualClassification))
      .map((value) => value.cellId),
  );
  const executedCellIds = new Set(executed.map((value) => value.cellId));
  const unavailableCellIds = new Set(
    values
      .filter((value) => value.actualClassification === "EVIDENCE_UNAVAILABLE")
      .map((value) => value.cellId),
  );
  const invariants = {
    unexplained_hangs: executed.filter(
      (value) =>
        value.actualClassification === "WATCHDOG_TIMEOUT" &&
        value.reasonCode === "UNEXPLAINED_HANG",
    ).length,
    one_time_dispatch_count_lte_one: executed.every(
      (value) =>
        value.semantics !== "one_time" ||
        (value.dispatchCount !== null && value.dispatchCount <= 1),
    ),
    post_dispatch_redispatch_count_zero: executed.every((value) => value.redispatchCount === 0),
    terminal_or_recovery_state_eventually: executed.every(
      (value) => value.finalProtectedState !== "active" && value.finalProtectedState !== "unknown",
    ),
    plaintext_leaks: executed.filter((value) => value.plaintextLeak).length,
    partial_reference_commits: executed.filter((value) => value.partialCommit).length,
    stale_fence_advancement: executed.filter((value) => value.staleFenceAdvancement).length,
    active_lease_after_terminal: executed.filter((value) => value.activeLease).length,
    active_browser_owner_after_session_close: executed.reduce(
      (sum, value) => sum + value.browserOwnerCount,
      0,
    ),
    safe_evidence_resume_without_confirmed_boundary: executed.filter(
      (value) => value.safeBoundaryState === "resumed_without_confirmation",
    ).length,
    late_result_state_advancement: executed.filter((value) => value.lateStateAdvancement).length,
  };
  const totals = {
    cells_total: selectedCells.length,
    cells_executed: executedCellIds.size,
    cells_certified: certifiedCellIds.size,
    cells_evidence_unavailable: unavailableCellIds.size,
    iterations_required: values.length,
    iterations_executed: executed.length,
    passed: values.filter((value) => value.actualClassification === "PASS").length,
    expected_fail_closed: values.filter(
      (value) => value.actualClassification === "EXPECTED_FAIL_CLOSED",
    ).length,
    unsupported: values.filter((value) => value.actualClassification === "EXPLICITLY_UNSUPPORTED")
      .length,
    new_defects: values.filter((value) => value.actualClassification === "NEW_DEFECT").length,
    evidence_unavailable: values.filter(
      (value) => value.actualClassification === "EVIDENCE_UNAVAILABLE",
    ).length,
    harness_errors: values.filter((value) => value.actualClassification === "HARNESS_ERROR").length,
    watchdog_timeouts: values.filter((value) => value.actualClassification === "WATCHDOG_TIMEOUT")
      .length,
    unexplained_hangs: invariants.unexplained_hangs,
  };
  return {
    schemaVersion: 2,
    runId: currentRunId,
    generatedAt: new Date().toISOString(),
    totals,
    invariants,
    results: values,
    evidenceAuthorityTotals,
    evidenceAuthorityAudit,
    support: supportMatrix(values),
    timing: timing(values),
    timingByFamily: timingByFamily(values),
    failures: values
      .filter((value) => !value.passed)
      .map(({ cellId, repetition, seed, actualClassification, reasonCode }) => ({
        cellId,
        iteration: repetition,
        seed,
        resultStatus: actualClassification,
        reasonCode,
      })),
    passed:
      evidenceAuthorityTotals.INSUFFICIENT_EVIDENCE === 0 &&
      totals.cells_evidence_unavailable === 0 &&
      totals.iterations_executed === totals.iterations_required &&
      totals.new_defects === 0 &&
      totals.harness_errors === 0 &&
      totals.watchdog_timeouts === 0 &&
      Object.values(invariants).every((value) => value === true || value === 0),
  };
}
function authorityAuditFor(cell: Cell) {
  const owner = (() => {
    if (cell.family === "I")
      return [
        "MissionFlowAuthoringService",
        "MissionFlowAuthoringService.advance",
        "expired lease before Mission continuation",
        [
          "Mission continuation",
          "AdaptiveSessionKernelRunner launch seam",
          "ProtectedTransactionKernel",
          "ProtectedOperationRepository",
          "durable projection",
        ],
      ];
    if (cell.family === "O")
      return [
        "AdaptiveSessionController/MissionFlowAuthoringService",
        "POST /api/mission-flow-authoring/:sessionId/advance",
        "pre-existing durable replay class",
        ["public controller", "Mission projection", "durable protected row", "invocation counters"],
      ];
    if (["D", "J"].includes(cell.family))
      return [
        "ProtectedTransactionKernel",
        "ProtectedTransactionKernel.execute",
        cell.family === "D" ? cell.fixture.dispatchFault : cell.fixture.reconciliation,
        [
          "fixture dispatch counter",
          "protected row",
          "persistence references",
          "lease and safe-boundary state",
        ],
      ];
    if (cell.family === "E")
      return [
        "ProtectedTransactionKernel/NativeBrowserDriver",
        "ProtectedTransactionKernel.execute",
        cell.fixture.browserFault,
        ["browser ownership events", "protected row", "runtime gate", "lease state"],
      ];
    if (cell.family === "H")
      return [
        "ProtectedTransactionKernel heartbeat owner",
        "ProtectedTransactionKernel.execute",
        cell.fixture.heartbeat,
        ["renewal callback", "fencing token", "protected row", "owner cleanup"],
      ];
    if (cell.family === "G")
      return [
        "ProtectedOutputPersistenceRepository",
        "persistOutputsAtomically",
        cell.fixture.persistence,
        ["PostgreSQL transaction", "protected references", "staging rows", "fencing token"],
      ];
    if (cell.family === "K")
      return [
        "VeilRuntimeCoordinator",
        "safe-boundary lifecycle",
        cell.fixture.safeBoundary,
        ["collector acknowledgements", "runtime state", "late completion guard"],
      ];
    if (cell.family === "F")
      return [
        "Veil cleanup/runtime owner",
        "collector/capsule cleanup lifecycle",
        cell.fixture.browserFault !== "none" ? cell.fixture.browserFault : cell.fixture.acquisition,
        ["cleanup completion", "ownership release", "sealed runtime state"],
      ];
    if (cell.family === "M")
      return [
        "Praxis semantic-control owner",
        "requirePraxisSuccess",
        cell.fixture.control,
        ["real page control", "dispatch counter", "protected row", "browser ownership"],
      ];
    if (cell.family === "L" || ["A1", "A2", "A3"].includes(cell.id))
      return [
        "protected acquisition owner",
        "acquireValue",
        cell.fixture.acquisition,
        ["real protected page", "acquisition result", "atomic persistence", "browser ownership"],
      ];
    if (
      cell.family === "B" ||
      cell.family === "C" ||
      cell.id === "A4" ||
      (cell.family === "N" && ["N1", "N2", "N3", "N4", "N5"].includes(cell.id))
    )
      return [
        "ProtectedResponseEnvelope",
        "beginProtectedResponseEnvelope",
        `${cell.fixture.request}/${cell.fixture.response}`,
        ["request initiation", "response settlement", "staged outputs", "durable result"],
      ];
    if (cell.family === "N")
      return [
        "ProtectedOperationRepository/ProtectedOutputPersistenceRepository",
        "read-only settlement and retry lifecycle",
        cell.fixture.persistence,
        ["staging disposal", "fresh operation identity", "atomic references", "durable states"],
      ];
    return ["unresolved", "unresolved", "unresolved", []];
  })();
  const verdict = owner[0] === "unresolved" ? "INSUFFICIENT_EVIDENCE" : "PRODUCTION_OWNER_EVIDENCE";
  return {
    cellId: cell.id,
    family: cell.family,
    productionOwner: owner[0],
    entryPoint: owner[1],
    faultInjectionPoint: owner[2],
    authoritativeEvidenceSources: owner[3],
    verdict,
  };
}
function timing(values: Result[]) {
  const sorted = values
    .filter((value) => value.passed)
    .map((value) => value.durationMs)
    .sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0;
  return { p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) ?? 0 };
}
function timingByFamily(values: Result[]) {
  return Object.fromEntries(
    ([...new Set(values.map((value) => value.family))] as Family[]).map((family) => [
      family,
      timing(values.filter((value) => value.family === family)),
    ]),
  );
}
function supportMatrix(values: Result[]) {
  const requirements: Record<string, string[]> = {
    input_value: ["A1", "L1"],
    text_content: ["A2", "L2"],
    protected_network_value: ["A3", "L3"],
    verified_copy_experience: ["L4"],
    fetch: ["C4"],
    xhr: ["C5"],
    download_content: ["L5"],
    visual_ocr: ["L6"],
    eventsource: ["C3E"],
    websocket: ["C3W"],
  };
  const byCell = new Map<string, Result[]>();
  for (const value of values)
    byCell.set(value.cellId, [...(byCell.get(value.cellId) ?? []), value]);
  return Object.fromEntries(
    Object.entries(requirements).map(([capability, required]) => {
      const records = required.flatMap((id) => byCell.get(id) ?? []);
      const complete = required.every(
        (id) => byCell.has(id) && byCell.get(id)!.every((value) => value.adapterExecuted),
      );
      if (!complete) return [capability, "EVIDENCE_UNAVAILABLE"];
      if (records.every((value) => value.actualClassification === "EXPLICITLY_UNSUPPORTED"))
        return [capability, "UNSUPPORTED"];
      if (capability === "download_content" || capability === "visual_ocr")
        return [capability, "EXPERIMENTAL"];
      return [
        capability,
        records.every((value) => value.passed) ? "SUPPORTED" : "EVIDENCE_UNAVAILABLE",
      ];
    }),
  );
}
function markdown(report: ReturnType<typeof aggregate>) {
  return `# Protected Transaction Certification ${report.runId}\n\n- Passed: ${report.passed}\n- Cells: ${report.totals.cells_certified}/${report.totals.cells_total}\n- Iterations: ${report.totals.iterations_executed}/${report.totals.iterations_required}\n- Evidence unavailable: ${report.totals.evidence_unavailable}\n- New defects: ${report.totals.new_defects}\n- Harness errors: ${report.totals.harness_errors}\n- Watchdog timeouts: ${report.totals.watchdog_timeouts}\n- Unexplained hangs: ${report.totals.unexplained_hangs}\n\n## Invariants\n\n\`\`\`json\n${JSON.stringify(report.invariants, null, 2)}\n\`\`\`\n`;
}
