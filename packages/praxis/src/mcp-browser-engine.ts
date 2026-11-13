import { fork, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  nativeBrowserTools,
  nativeObservationTools,
  editBrowserTextSchema,
  nativeBrowserToolSchema,
  browserSequenceInputSchema,
  maskingDiagnosticSchema,
  type MaskingDiagnostic,
  nativeCapabilitySchemas,
  scopedRequestSchema,
  canonicalRecordingAssessment,
  nativeImageReasons,
  type NativeCapturePort,
  type NativeCaptureEpoch,
  type NativeCaptureSample,
  type NativeImageEvidence,
  type RecordingAssessment,
  type BrowserSequenceInput,
  type BrowserCommand,
  type ChronicleEvidencePort,
  type ChronicleEvidenceSessionPort,
  type ChronicleNativeRecordingPort,
  type PraxisCommandsPort,
  type PraxisEffectsPort,
  type PraxisSessionScope,
  type PraxisCommandOptions,
  type PraxisRuntimeOptions,
  type VeilBrowserProtectionPort,
} from "@scry/contracts";
import { CommandLane, type CommandAttempt } from "./command-lane.js";
import { ExecutionSupervision } from "./execution-supervision.js";
import { PraxisOwnerLease } from "./owner-lease.js";
import { SupervisedBrowser } from "./supervised-browser.js";
import {
  createSessionDenials,
  type DenialCursor,
  type DenialSnapshot,
} from "./mcp-native/scope-denials.js";

const failure = (code: string) => new Error(`SCRY_BROWSER_${code}`);
function privateNetworkOrigins(): string[] {
  let values: unknown;
  try {
    values = JSON.parse(process.env.SCRY_BROWSER_PRIVATE_NETWORK_ORIGINS ?? "[]");
  } catch {
    throw failure("PRIVATE_NETWORK_CONFIGURATION_INVALID");
  }
  if (
    !Array.isArray(values) ||
    values.length > 20 ||
    values.some((v) => {
      try {
        const u = new URL(v);
        return typeof v !== "string" || u.origin !== v || !["https:", "http:"].includes(u.protocol);
      } catch {
        return true;
      }
    })
  )
    throw failure("PRIVATE_NETWORK_CONFIGURATION_INVALID");
  return values;
}
type Content = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResult = {
  content: Content[];
  observationId?: string;
  /** Private adapter admission fact; no new public response member. */
  observationAvailable?: boolean;
  observationIssue?:
    | "native_protection_capacity"
    | "native_protection_refresh_incomplete"
    | "native_protection_classification_failed";
  diagnosticDetailAllowed?: boolean;
  imageEvidence?: NativeImageEvidence;
  isError?: boolean;
  interaction?: {
    status: string;
    inputState: string;
    reason: string;
    intent: string;
    method: string;
  };
  evidence?: { title?: string; description?: string };
};
const adapterFailureCodes = new Set([
  "ADAPTER_INVALID_TOOL_ARGUMENTS",
  "ADAPTER_SNAPSHOT_CAPACITY",
  "ADAPTER_OUTPUT_CAPACITY",
  "ADAPTER_TARGET_NOT_READY",
  "ADAPTER_REFERENCE_UNAVAILABLE",
  "ADAPTER_CLIPBOARD_UNAVAILABLE",
  "ADAPTER_COMMAND_CONCURRENT",
  "ADAPTER_OBSERVATION_INVALIDATED",
  "ADAPTER_INVALID_PLAN_STATE",
]);
type Proxy = { url: string; close(): Promise<void> };
type Cell = {
  id: string;
  lane: CommandLane;
  supervision: ExecutionSupervision;
  retired: boolean;
  opening?: Promise<void>;
  stopping?: Promise<void>;
  escalateStop?: () => void;
  scope?: PraxisSessionScope;
  lease?: PraxisOwnerLease;
  evidence?: ChronicleEvidenceSessionPort;
  native?: ChronicleNativeRecordingPort;
  capture?: NativeCapturePort;
  capturePolicyGeneration: number;
  recordingAssessment?: RecordingAssessment;
  forceStopRequested: boolean;
  launch?: Promise<SupervisedBrowser>;
  custody?: SupervisedBrowser;
  worker?: AdapterWorker;
  proxy?: Proxy;
  downloadDirectory?: string;
  policyDigest?: string;
  maskingPartial: boolean;
  diagnosticDetailAllowed: boolean;
  diagnosticDetailSuppressed: boolean;
  denials: ReturnType<typeof createSessionDenials>;
  lastPublishedDenialCursor: DenialCursor;
  denialsDisposed: boolean;
  captureDenials?: () => void;
  sealed?: Record<string, unknown>;
};

/** An IPC-only official adapter. No API credentials, database, lease, or
 * encryption key enters this process. Its browser is independently supervised. */
export class AdapterWorker {
  readonly child: ChildProcess;
  #sequence = 0;
  #captureTasks = new Set<Promise<void>>();
  #captureFailed = false;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;
  #tools = new Set<string>();
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      initializes: boolean;
    }
  >();
  constructor(
    directory: string,
    entrypoint: string,
    onWarning: (event?: MaskingDiagnostic) => void,
    onLost: () => void,
    onCapture: (event: Record<string, unknown>) => Promise<void>,
  ) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "TMPDIR", "TEMP", "LANG", "PLAYWRIGHT_BROWSERS_PATH"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    env.HOME = directory;
    this.child = fork(new URL(entrypoint), [], {
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx/esm")],
      env,
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const m = raw as { id?: number; ok?: boolean; data?: unknown; type?: string; code?: string };
      if (m.type === "capture_sample" || m.type === "capture_gap") {
        if (this.#captureTasks.size >= 128) {
          this.#captureFailed = true;
          onLost();
          return;
        }
        let task: Promise<void>;
        try {
          // Invoke/register the producer operation synchronously at IPC receipt,
          // before any final barrier can await a reply from this same channel.
          task = Promise.resolve(onCapture(raw as Record<string, unknown>));
        } catch (error) {
          task = Promise.reject(error);
        }
        const tracked = task.catch(() => {
          this.#captureFailed = true;
        });
        this.#captureTasks.add(tracked);
        void tracked.finally(() => this.#captureTasks.delete(tracked));
        return;
      }
      if (m.type === "masking") {
        const parsed = maskingDiagnosticSchema.safeParse((raw as { event?: unknown }).event);
        onWarning(parsed.success ? parsed.data : undefined);
        return;
      }
      if (typeof m.id !== "number") return;
      const call = this.#pending.get(m.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.#pending.delete(m.id);
      if (m.ok) {
        if (call.initializes && Array.isArray(m.data))
          for (const tool of m.data.slice(0, 512))
            if (tool && typeof tool === "object" && typeof tool.name === "string")
              this.#tools.add(tool.name);
        call.resolve(m.data);
      } else
        call.reject(
          failure(m.code && adapterFailureCodes.has(m.code) ? m.code : "ADAPTER_CALL_FAILED"),
        );
    });
    const lost = () => {
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(failure("ADAPTER_LOST"));
      }
      this.#pending.clear();
      if (!this.#stopping) onLost();
    };
    this.child.on("exit", lost);
    this.child.on("error", lost);
  }
  call(message: Record<string, unknown>, timeout = 30000): Promise<unknown> {
    if (!this.child.connected) return Promise.reject(failure("ADAPTER_LOST"));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(failure("ADAPTER_TIMEOUT"));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer, initializes: message.type === "init" });
      this.child.send({ ...message, id }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(failure("ADAPTER_LOST"));
        }
      });
    });
  }
  get alive(): boolean {
    return (
      !this.#stopping &&
      this.child.connected &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }
  get supportsReadOnlyImages(): boolean {
    return this.alive && this.#tools.has("browser_take_screenshot");
  }
  async drainCapture(timeout = 5000): Promise<void> {
    await boundedCapture(
      (async () => {
        while (this.#captureTasks.size) await Promise.all([...this.#captureTasks]);
        if (this.#captureFailed) throw failure("CAPTURE_PRODUCER_FAILED");
      })(),
      timeout,
    );
  }
  stop(): Promise<void> {
    return (this.#stopPromise ??= (async () => {
      this.#stopping = true;
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      const exit = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
      this.child.kill("SIGTERM");
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
      let confirmation: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exit,
          new Promise<never>((_resolve, reject) => {
            confirmation = setTimeout(() => reject(failure("ADAPTER_STOP_UNCONFIRMED")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        clearTimeout(confirmation);
      }
    })());
  }
}

async function boundedCapture<T>(operation: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure("CAPTURE_DRAIN_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function sameEpoch(value: unknown, expected: NativeCaptureEpoch): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const epoch = value as Record<string, unknown>;
  return (
    Object.keys(epoch).length === 3 &&
    epoch.captureId === expected.captureId &&
    epoch.originalWriterGeneration === expected.originalWriterGeneration &&
    epoch.assessmentPolicyVersion === expected.assessmentPolicyVersion
  );
}
function finiteImageEvidence(value: unknown): NativeImageEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const image = value as Record<string, unknown>;
  if (
    Object.keys(image).length === 2 &&
    image.state === "available" &&
    image.assessment === "best_effort_known_candidates"
  )
    return { state: "available", assessment: "best_effort_known_candidates" };
  if (
    Object.keys(image).length === 3 &&
    image.state === "withheld" &&
    typeof image.reason === "string" &&
    Object.hasOwn(nativeImageReasons, image.reason)
  ) {
    const reason = image.reason as keyof typeof nativeImageReasons;
    if (image.recovery === nativeImageReasons[reason])
      return {
        state: "withheld",
        reason,
        recovery: nativeImageReasons[reason],
      } as NativeImageEvidence;
  }
}

/** Platform-owned execution with the official browser tool semantics. All
 * admission, queue ordering, tenancy and evidence authority stay in Scry. */
export class PraxisMcpBrowserEngine {
  #cells = new Map<string, Cell>();
  #stopping = false;
  constructor(
    private readonly commands: PraxisCommandsPort,
    private readonly effects: PraxisEffectsPort,
    private readonly evidenceService: ChronicleEvidencePort,
    private readonly protection: VeilBrowserProtectionPort,
    private readonly workerEntrypoint: string,
    private readonly runtimeOptions: PraxisRuntimeOptions = {},
  ) {}
  private cell(id: string): Cell {
    let c = this.#cells.get(id);
    if (!c) {
      const denials = createSessionDenials();
      c = {
        id,
        lane: new CommandLane(),
        supervision: new ExecutionSupervision(),
        retired: false,
        capturePolicyGeneration: 1,
        forceStopRequested: false,
        maskingPartial: false,
        diagnosticDetailAllowed: false,
        diagnosticDetailSuppressed: false,
        denials,
        lastPublishedDenialCursor: denials.cursor(),
        denialsDisposed: false,
      };
      this.#cells.set(id, c);
    }
    return c;
  }
  private active(c: Cell): void {
    if (this.#stopping || c.retired) throw failure("SESSION_CLOSING");
    c.lease?.assertActive();
  }
  private diagnosticPolicy(c: Cell, values: Record<string, string>): void {
    try {
      const protection = this.protection.nativeDiagnostics?.(values);
      c.denials.setCleaner(
        protection
          ? (value) =>
              c.diagnosticDetailAllowed && !c.diagnosticDetailSuppressed
                ? protection.sanitize(value)
                : undefined
          : undefined,
      );
    } catch {
      // Diagnostics never acquire a raw fallback or fail application execution.
      c.denials.setCleaner(undefined);
    }
  }
  private root(id: string): string {
    return path.resolve(process.env.SCRY_BROWSER_ARTIFACT_ROOT ?? "artifacts/browser", id);
  }
  private async claim(c: Cell): Promise<void> {
    await this.effects.assertCompatibleBaseline();
    this.active(c);
    const scope = await this.commands.sessionContext(c.id);
    this.active(c);
    if (
      scope.runtimeAdapter !== "playwright_mcp" ||
      process.env.SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED !== "true"
    )
      throw failure("ADAPTER_DISABLED");
    const claim = await this.effects.claimOwner(c.id, `worker:${process.pid}`, 60000);
    c.scope = { ...scope, ownerGeneration: claim.generation };
    c.lease = new PraxisOwnerLease(
      { sessionId: c.id, generation: claim.generation, leaseToken: claim.leaseToken },
      this.effects,
      claim,
    );
    c.lease.signal.addEventListener(
      "abort",
      () => {
        void this.stop(c, true).catch(() => this.runtimeOptions.onUnconfirmedRuntime?.());
      },
      { once: true },
    );
    c.lease.startHeartbeat(60000);
    this.active(c);
  }
  private async initialize(c: Cell): Promise<void> {
    await this.claim(c);
    if ((await this.commands.evidenceStatus(c.id))?.captureStarted)
      throw failure("SESSION_INTERRUPTED");
    this.active(c);
    const scope = c.scope!,
      lease = c.lease!;
    if (!this.protection.nativeEvidence) throw failure("ADAPTER_PROTECTION_UNAVAILABLE");
    c.evidence = await this.evidenceService.openSession({
      root: this.root(c.id),
      runId: scope.runId,
      sessionId: c.id,
      admission: lease,
      protection: this.protection.nativeEvidence(scope),
      maxSessionBytes: 20 * 1024 * 1024,
    });
    c.native = await c.evidence.createNativeRecording();
    this.active(c);
    await c.evidence.startCapture();
    c.capture = await c.native.reserveCaptureV2({ kind: "display", policyGeneration: 1 });
    c.recordingAssessment = { state: "pending" };
    const captureDirectory = c.capture.directory;
    c.downloadDirectory = path.join(captureDirectory, "downloads");
    this.active(c);
    // @ts-expect-error Private JavaScript transport, characterized by proxy contract tests.
    const { originProxy } = await import("./mcp-native/proxy.mjs");
    c.proxy = (await originProxy(
      scope.allowedOrigins ?? [scope.baseOrigin],
      c.denials.record,
    )) as Proxy;
    this.active(c);
    c.launch = SupervisedBrowser.launch({
      runtime: "playwright_mcp",
      headless: false,
      proxyServer: c.proxy.url,
      captureDirectory,
      sampleAuthority: () => ({ owner: lease.authoritySample(), command: c.supervision.sample() }),
      onUnconfirmedStop: () => this.runtimeOptions.onUnconfirmedRuntime?.(),
    });
    c.custody = await c.launch;
    this.active(c);
    const output = path.join(c.native.directory, "adapter");
    await mkdir(output, { recursive: true, mode: 0o700 });
    this.active(c);
    const degradedPages = new Set<string>();
    let unknownMasking = false;
    c.worker = new AdapterWorker(
      output,
      this.workerEntrypoint,
      (event) => {
        if (!event) {
          unknownMasking = true;
          c.maskingPartial = true;
          c.native?.maskingUnavailable();
          return;
        }
        if (event.state === "degraded") degradedPages.add(event.pageId);
        else degradedPages.delete(event.pageId);
        c.maskingPartial = unknownMasking || degradedPages.size > 0;
        if (!c.retired)
          try {
            c.native?.recordMasking?.(event);
          } catch (error) {
            c.native?.recordError("recorder_write_failed", error);
          }
      },
      () => {
        void this.stop(c, true).catch(() => this.runtimeOptions.onUnconfirmedRuntime?.());
      },
      (event) => {
        const capture = c.capture;
        if (
          !capture ||
          !sameEpoch(event.epoch, capture.epoch) ||
          !Number.isSafeInteger(event.sequence) ||
          (event.sequence as number) < 1
        )
          throw failure("CAPTURE_IDENTITY_MISMATCH");
        return event.type === "capture_sample"
          ? capture.graphSample({
              sequence: event.sequence as number,
              sample: event.sample as NativeCaptureSample,
            })
          : capture.graphGap({
              sequence: event.sequence as number,
              reason: event.reason as keyof typeof nativeImageReasons,
            });
      },
    );
    const secrets = await this.commands.protectedValuesForSession(c.id);
    this.active(c);
    this.diagnosticPolicy(c, secrets);
    c.policyDigest = createHash("sha256").update(JSON.stringify(secrets)).digest("hex");
    await c.worker.call(
      {
        type: "init",
        endpoint: c.custody.endpoint(),
        display: c.custody.privateDisplay(),
        secrets,
        output,
        downloadDirectory: c.downloadDirectory,
        allowedOrigins: scope.allowedOrigins ?? [scope.baseOrigin],
        privateOrigins:
          process.env.SCRY_BROWSER_WORKFLOW_V2_ENABLED === "true" ? privateNetworkOrigins() : [],
        capabilitiesEnabled: process.env.SCRY_BROWSER_WORKFLOW_V2_ENABLED === "true",
        captureEpoch: c.capture.epoch,
      },
      15000,
    );
    this.active(c);
    await c.custody.completeSetup();
  }
  private async ensure(c: Cell): Promise<void> {
    this.active(c);
    c.opening ??= this.initialize(c);
    try {
      await c.opening;
      this.active(c);
    } catch (error) {
      await this.stop(c, true);
      throw error;
    }
  }
  async open(id: string) {
    const c = this.cell(id);
    await this.ensure(c);
    return { sessionId: id, ownerGeneration: c.lease!.ownerGeneration };
  }
  /** Retire admission synchronously before waiting for a late launch. The
   * exact acquisition remains owned until browser exit AND encoder drain. */
  private stop(c: Cell, force: boolean): Promise<void> {
    c.forceStopRequested ||= force;
    if (force) c.escalateStop?.();
    c.retired = true;
    // Preserve only the active command's safe windows before releasing raw
    // endpoints and the Veil policy closure, even if physical stop later fails.
    if (!c.denialsDisposed) {
      c.diagnosticDetailAllowed = false;
      c.captureDenials?.();
      c.denials.dispose();
      c.denialsDisposed = true;
    }
    return (c.stopping ??= (async () => {
      await c.opening?.catch(() => undefined);
      let custody = c.custody;
      let acquisitionFailed = false;
      let acquisitionFailure: unknown;
      try {
        custody ??= await c.launch;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          (error as { physicalRetirement?: unknown }).physicalRetirement !== "confirmed" ||
          (error as { mayOwnResources?: unknown }).mayOwnResources !== false
        ) {
          acquisitionFailed = true;
          acquisitionFailure = error;
        }
      }
      let custodyStopping: Promise<unknown> | undefined;
      let escalation: Promise<unknown> | undefined;
      let custodyStarted = false,
        custodySettled = false,
        custodyForced = false;
      const stopCustody = (requestForce: boolean): Promise<unknown> => {
        const promote = requestForce && !custodyForced;
        custodyForced ||= requestForce;
        if (!custodyStopping) {
          // Publish the promise before invoking a resource that may reenter stop.
          custodyStopping = Promise.resolve().then(async () => {
            custodyStarted = true;
            try {
              const receipt = custody
                ? await (custodyForced ? custody.terminate() : custody.close())
                : undefined;
              if (escalation) await escalation;
              return receipt;
            } finally {
              custodySettled = true;
            }
          });
        } else if (promote && custodyStarted && !custodySettled && custody) {
          escalation = Promise.resolve().then(() => custody!.terminate());
          void escalation.catch(() => undefined);
        }
        return custodyStopping;
      };
      let workerStopping: Promise<void> | undefined;
      const stopWorker = () => (workerStopping ??= Promise.resolve().then(() => c.worker?.stop()));
      c.escalateStop = () => {
        void stopCustody(true).catch(() => undefined);
        void stopWorker().catch(() => undefined);
      };
      if (c.forceStopRequested) c.escalateStop();
      try {
        await this.finalizeCapture(c, custody);
      } finally {
        // Metadata failure cannot strand physical resources. Every exact owner
        // gets a cleanup attempt even if a sibling cleanup rejects.
        const cleanups = [
          stopWorker,
          () => stopCustody(c.forceStopRequested),
          () => c.proxy?.close(),
          () =>
            c.downloadDirectory
              ? rm(c.downloadDirectory, { recursive: true, force: true })
              : undefined,
        ];
        const results = await Promise.allSettled(
          cleanups.map((cleanup) => Promise.resolve().then<unknown>(cleanup)),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          acquisitionFailed = true;
          acquisitionFailure ??= failed.reason;
        }
      }
      if (acquisitionFailed) {
        this.runtimeOptions.onUnconfirmedRuntime?.();
        throw Object.assign(
          new Error(
            acquisitionFailure instanceof Error
              ? acquisitionFailure.message
              : "SCRY_BROWSER_OWNER_RETIREMENT_UNCONFIRMED",
            { cause: acquisitionFailure },
          ),
          {
            code: "RECORDER_RETIREMENT_UNCONFIRMED",
            physicalRetirement: "unconfirmed",
            mayOwnResources: true,
          },
        );
      }
    })());
  }
  private async finalizeCapture(c: Cell, custody: SupervisedBrowser | undefined): Promise<void> {
    const capture = c.capture;
    if (!capture) return;
    try {
      if (c.forceStopRequested || !custody || !c.worker) throw failure("CAPTURE_FINAL_UNAVAILABLE");
      c.lease!.assertActive();
      const receipt = await custody.stopCapture();
      if (receipt.coverage === "unavailable" || c.forceStopRequested)
        throw failure("CAPTURE_FINAL_UNAVAILABLE");
      const challenge = await boundedCapture(
        capture.physicalStopped({
          epoch: capture.epoch,
          started: receipt.started,
          ended: receipt.ended,
          physicalCoverage: receipt.coverage,
        }),
      );
      c.lease!.assertActive();
      if (c.forceStopRequested) throw failure("CAPTURE_FINAL_UNAVAILABLE");
      const reply = (await c.worker.call(
        { type: "close_capture_producer", epoch: capture.epoch, challenge: challenge.challenge },
        5000,
      )) as Record<string, unknown>;
      await c.worker.drainCapture();
      if (
        !reply ||
        !sameEpoch(reply.epoch, capture.epoch) ||
        !Number.isSafeInteger(reply.lastSequence) ||
        (reply.lastSequence as number) < 1 ||
        !reply.finalSample
      )
        throw failure("CAPTURE_FINAL_UNAVAILABLE");
      c.lease!.assertActive();
      if (c.forceStopRequested) throw failure("CAPTURE_FINAL_UNAVAILABLE");
      await boundedCapture(
        capture.graphSample({
          sequence: reply.lastSequence as number,
          sample: reply.finalSample as NativeCaptureSample,
        }),
      );
      c.lease!.assertActive();
      if (c.forceStopRequested) throw failure("CAPTURE_FINAL_UNAVAILABLE");
      await boundedCapture(capture.graphClosed({ lastSequence: reply.lastSequence as number }));
    } catch {
      // Missing physical/final/producer proof stays unclosed in Chronicle. It
      // withholds this capture without inventing physical-release uncertainty.
    }
    try {
      await c.worker?.drainCapture();
    } catch {
      /* No graph-close acknowledgment on a failed producer. */
    }
    try {
      const assessment = await boundedCapture(capture.seal());
      const recordingAssessment = canonicalRecordingAssessment({
        ...assessment,
        warning: "automatic_redaction_best_effort",
      });
      if (recordingAssessment) c.recordingAssessment = recordingAssessment;
      else delete c.recordingAssessment;
    } catch {
      c.recordingAssessment = {
        state: "withheld",
        reason: "native_capture_final_assessment_missing",
        warning: "automatic_redaction_best_effort",
      };
    }
  }
  private async phase<T>(
    c: Cell,
    attempt: CommandAttempt,
    limit: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const token = c.supervision.enterPhase(limit);
    try {
      await c.custody!.synchronize();
      attempt.assertActive();
      return await work();
    } finally {
      c.supervision.leavePhase(token);
      await c.custody!.synchronize();
    }
  }
  /** Explicit tools and independent observations share one native-call policy.
   * Neither path may extend the exact command's remaining lifetime. */
  private async nativeCall(c: Cell, attempt: CommandAttempt, message: Record<string, unknown>) {
    // Parent diagnostics cannot classify child-learned values. At publication,
    // use only this private finite admission fact, never transfer raw values.
    c.diagnosticDetailAllowed = false;
    try {
      const result = (await this.phase(c, attempt, 30000, () =>
        c.worker!.call(message, attempt.remainingMs(29000)),
      )) as ToolResult;
      if (result.diagnosticDetailAllowed !== true) c.diagnosticDetailSuppressed = true;
      c.diagnosticDetailAllowed = result.diagnosticDetailAllowed === true;
      return result;
    } catch (error) {
      // Missing/failed child knowledge can never be repaired by a later boolean.
      c.diagnosticDetailSuppressed = true;
      throw error;
    }
  }
  /** One durable command owns the plan; every prefix precedes later effects. */
  private async executeSequence(
    c: Cell,
    attempt: CommandAttempt,
    plan: BrowserSequenceInput,
    options: PraxisCommandOptions,
  ) {
    const receipts: Array<Record<string, unknown>> = [];
    const outcome: Record<string, unknown> = {
      contractVersion: 1,
      planId: plan.planId,
      execution: "unknown",
      businessOutcome: "unverified",
      observation: "unavailable",
      complete: false,
      receipts,
      content: [],
      masking: c.maskingPartial ? "best_effort_partial" : "best_effort",
    };
    await this.phase(c, attempt, 5000, () =>
      c.worker!.call({ type: "prepare_plan", input: plan }, attempt.remainingMs(4500)),
    );
    try {
      for (const [index, step] of plan.steps.entries()) {
        await options.assertCurrent?.();
        attempt.assertActive();
        const secret =
          step.tool === "browser_type_secret"
            ? await this.commands.protectedValueForBrowser(c.id, String(step.args.protectedValueId))
            : undefined;
        const receipt: Record<string, unknown> = {
          actionId: step.actionId,
          index,
          execution: "unknown",
          businessOutcome: "unknown",
        };
        receipts.push(receipt);
        // Linearized dispatch admission: a preceding stop refuses this step.
        // An already admitted step remains explicitly in-flight on cancellation.
        await options.persistAction?.({ ...outcome, reason: "dispatch_started" });
        attempt.assertActive();
        const response = await this.nativeCall(c, attempt, {
          type: "plan_step",
          planId: plan.planId,
          index,
          ...(secret !== undefined ? { secret } : {}),
        });
        const completed = response?.isError === false && Array.isArray(response.content);
        receipt.execution =
          response?.isError === true ? "tool_error" : completed ? "completed" : "unknown";
        receipt.businessOutcome = "unverified";
        await options.persistAction?.({ ...outcome, reason: "step_receipt" });
        if (!completed) {
          outcome.execution = receipt.execution;
          break;
        }
      }
    } finally {
      if (!c.retired) {
        try {
          await this.phase(c, attempt, 2500, () =>
            c.worker!.call(
              { type: "dispose_plan", planId: plan.planId },
              attempt.remainingMs(2000),
            ),
          );
        } catch (error) {
          await this.stop(c, true);
          throw error;
        }
      }
    }
    outcome.complete =
      receipts.length === plan.steps.length && receipts.every((r) => r.execution === "completed");
    if (outcome.complete) outcome.execution = "completed";
    try {
      const observation = await this.nativeCall(c, attempt, {
        type: "call",
        tool: "browser_snapshot",
        args: {},
      });
      if (observation.observationAvailable === false && observation.observationIssue)
        outcome.observationIssue = observation.observationIssue;
      if (!observation.isError && observation.observationAvailable !== false) {
        outcome.observation = "available";
        outcome.content = observation.content.filter((v) => v.type === "text");
        if (observation.observationId) outcome.observationId = observation.observationId;
      }
    } catch {
      outcome.warning =
        "Action receipts retained; successor observation unavailable. Inspect before continuing.";
      await this.stop(c, true);
    }
    await options.persistAction?.(outcome);
    return outcome;
  }
  async execute(
    id: string,
    command: BrowserCommand,
    options: PraxisCommandOptions = { remainingMs: 60000 },
  ): Promise<Record<string, unknown>> {
    const c = this.cell(id);
    const result = await c.lane.run(options, async (attempt) => {
      attempt.bind({ stop: () => this.stop(c, true) });
      if (c.retired && (command.kind === "close" || command.kind === "close_for_failure")) {
        // A failed phase stays terminal for browser interactions. Only confirmed
        // physical retirement permits a fresh, evidence-only cleanup attempt.
        await this.stop(c, true);
        c.supervision = new ExecutionSupervision();
      }
      c.supervision.begin(attempt, options.sampleAuthority);
      const admission = c.denials.cursor();
      // Validation can fail before this action's existing policy read. A prior
      // command's classifier may be stale; preserve counts until fresh policy is
      // already available rather than adding a query or disclosing with it.
      c.denials.setCleaner(undefined);
      c.diagnosticDetailAllowed = false;
      const priorCursor = c.lastPublishedDenialCursor;
      type SafeSnapshot = Omit<DenialSnapshot, "cursor">;
      let windows: { prior?: SafeSnapshot; current?: SafeSnapshot } = {};
      let publication = admission;
      let captured = false;
      const safe = (snapshot: DenialSnapshot): SafeSnapshot | undefined => {
        if (snapshot.denialCount === 0 && snapshot.countsExact) return;
        const { cursor: _cursor, ...value } = snapshot;
        return value;
      };
      const captureDenials = () => {
        publication = c.denials.cursor();
        const prior = safe(c.denials.snapshot(priorCursor, admission));
        const current = safe(c.denials.snapshot(admission, publication));
        windows = { ...(prior ? { prior } : {}), ...(current ? { current } : {}) };
        captured = true;
      };
      c.captureDenials = captureDenials;
      const contextual = (result: Record<string, unknown>): Record<string, unknown> => {
        if (!c.retired || !captured) captureDenials();
        return Object.keys(windows).length
          ? { ...result, scopeRestrictionObserved: true, scopeDiagnostics: windows }
          : { ...result };
      };
      let lastAction: Record<string, unknown> | undefined;
      let checkpoint: Record<string, unknown> | undefined;
      let checkpointFailed = false;
      const commandOptions: PraxisCommandOptions = {
        ...options,
        persistAction: async (result) => {
          lastAction = result;
          // Every new dispatch prefix precedes fresh child privacy admission,
          // including later steps sharing this durable sequence command.
          if (result.reason === "dispatch_started") c.diagnosticDetailAllowed = false;
          checkpoint = { ...contextual(result), readOnlyImageInspectionSupported: false };
          try {
            await options.persistAction?.(checkpoint);
          } catch (error) {
            checkpointFailed = true;
            throw error;
          }
        },
      };
      const published = (result: Record<string, unknown>) => {
        const value = lastAction === result && checkpoint ? checkpoint : contextual(result);
        // Publication advances once per final outcome, never at a dispatch or
        // step prefix. Replay returns the persisted value, not later activity.
        c.lastPublishedDenialCursor = c.retired ? c.denials.cursor() : publication;
        return value;
      };
      try {
        // Even a fail-fast validation refusal is an admitted command. Publish
        // its active sequence before it can finish, otherwise idle skips an
        // unseen sequence and the independent custodian correctly fences it.
        if (c.custody && !c.retired) await c.custody.synchronize();
        await options.assertCurrent?.();
        if (command.kind === "close" || command.kind === "close_for_failure")
          return published(await this.finish(c, command.kind === "close_for_failure"));
        if (command.kind !== "browser_tool") throw failure("ADAPTER_COMMAND_MISMATCH");
        await this.ensure(c);
        await c.lease!.checkpoint();
        await options.assertCurrent?.();
        attempt.assertActive();
        let tool = command.tool,
          args: Record<string, unknown>,
          secret: string | undefined;
        let requestBindings: Array<Record<string, unknown>> | undefined;
        if (Object.hasOwn(nativeCapabilitySchemas, tool)) {
          if (process.env.SCRY_BROWSER_WORKFLOW_V2_ENABLED !== "true")
            throw failure("WORKFLOW_DISABLED");
          args = nativeBrowserToolSchema(tool).parse(command.args);
          if (tool === "browser_scoped_request") {
            const request = scopedRequestSchema.parse(args);
            requestBindings = [];
            for (const binding of [...request.credentials, ...request.bodyBindings])
              requestBindings.push({
                ...binding,
                value: await this.commands.protectedValueForBrowser(id, binding.protectedValueId),
              });
          }
        } else if (tool === "browser_type_secret") {
          const { target, protectedValueId, submit } = command.args;
          if (
            typeof target !== "string" ||
            target.length > 20000 ||
            typeof protectedValueId !== "string" ||
            (submit !== undefined && typeof submit !== "boolean")
          )
            throw failure("INVALID_TOOL_ARGUMENTS");
          secret = await this.commands.protectedValueForBrowser(id, protectedValueId);
          tool = "browser_type";
          args = { target, text: "", ...(submit === undefined ? {} : { submit }) };
        } else if (tool === "browser_navigate_secret") {
          if (typeof command.args.protectedValueId !== "string")
            throw failure("INVALID_TOOL_ARGUMENTS");
          const url = await this.commands.protectedValueForBrowser(
            id,
            command.args.protectedValueId,
          );
          tool = "browser_navigate";
          args = { url };
        } else if (tool === "browser_sequence") {
          args = browserSequenceInputSchema.parse(command.args);
        } else if (tool === "browser_edit_text") {
          args = editBrowserTextSchema.parse(command.args);
        } else {
          if (!nativeBrowserTools.has(tool as never)) throw failure("INVALID_TOOL_ARGUMENTS");
          args = nativeBrowserToolSchema(tool).parse(command.args) as Record<string, unknown>;
        }
        if (tool === "browser_navigate") {
          const url = new URL(String(args.url));
          if (
            !(c.scope!.allowedOrigins ?? [c.scope!.baseOrigin]).includes(url.origin) ||
            url.username ||
            url.password
          )
            throw failure("ORIGIN_DENIED");
        }
        // Origin proxy enforces redirects, popups and ordinary app traffic too.
        const values = await this.commands.protectedValuesForSession(id);
        this.diagnosticPolicy(c, values);
        const revision = createHash("sha256").update(JSON.stringify(values)).digest("hex");
        if (revision !== c.policyDigest) {
          try {
            const reply = (await this.phase(c, attempt, 5000, () =>
              c.worker!.call({ type: "policy", secrets: values }, 4000),
            )) as { policyGeneration?: unknown; policyAckRequired?: unknown } | undefined;
            if (c.capture) {
              if (!reply || typeof reply.policyAckRequired !== "boolean")
                throw failure("CAPTURE_POLICY_UNCONFIRMED");
              if (reply.policyAckRequired) {
                if (reply.policyGeneration !== c.capturePolicyGeneration + 1)
                  throw failure("CAPTURE_POLICY_UNCONFIRMED");
                await c.worker!.drainCapture();
                await this.phase(c, attempt, 5000, () =>
                  boundedCapture(
                    c.capture!.policyTransition({
                      from: c.capturePolicyGeneration,
                      to: reply.policyGeneration as number,
                      acknowledged: true,
                    }),
                  ),
                );
                await this.phase(c, attempt, 5000, () =>
                  c.worker!.call(
                    { type: "policy_ack", policyGeneration: reply.policyGeneration },
                    4000,
                  ),
                );
                c.capturePolicyGeneration = reply.policyGeneration as number;
              } else if (reply.policyGeneration !== c.capturePolicyGeneration)
                throw failure("CAPTURE_POLICY_UNCONFIRMED");
            }
          } catch (error) {
            await this.stop(c, true);
            throw error;
          }
          c.policyDigest = revision;
        }
        if (tool === "browser_sequence")
          return published(
            await this.executeSequence(
              c,
              attempt,
              browserSequenceInputSchema.parse(args),
              commandOptions,
            ),
          );
        const mutating = !nativeObservationTools.has(tool);
        await commandOptions.persistAction?.({
          execution: "unknown",
          businessOutcome: mutating ? "unknown" : "not_dispatched",
          observation: "unavailable",
          reason: "dispatch_started",
        });
        const response = await this.nativeCall(c, attempt, {
          type: "call",
          tool,
          args,
          ...(secret ? { secret } : {}),
          ...(requestBindings ? { requestBindings } : {}),
        });
        const outcome: Record<string, unknown> = {
          execution:
            response.interaction?.status === "unknown"
              ? "unknown"
              : response.isError
                ? "tool_error"
                : "completed",
          businessOutcome:
            response.interaction?.status === "unknown"
              ? "unknown"
              : response.interaction?.status === "not_dispatched" &&
                  response.interaction.inputState === "not_started"
                ? "not_dispatched"
                : mutating
                  ? "unverified"
                  : "not_dispatched",
          observation: response.observationAvailable === false ? "unavailable" : "available",
          content: [],
          masking: c.maskingPartial ? "best_effort_partial" : "best_effort",
        };
        if (response.observationAvailable === false && response.observationIssue)
          outcome.observationIssue = response.observationIssue;
        if (response.interaction) outcome.inputObservation = response.interaction;
        if (response.observationId) outcome.observationId = response.observationId;
        const imageEvidence = finiteImageEvidence(response.imageEvidence);
        if (imageEvidence) outcome.imageEvidence = imageEvidence;
        else if (response.content.some((item) => item.type === "image"))
          outcome.imageEvidence = {
            state: "withheld",
            reason: "native_protection_attestation_invalid",
            recovery: "preserve_gap",
          };
        // Action truth is durable before independent observation or media IO.
        outcome.content = response.content.filter((v) => v.type === "text");
        await commandOptions.persistAction?.(outcome);
        const media: Array<{ artifactId: string }> = [];
        for (const image of response.content.filter((v) => v.type === "image")) {
          if (imageEvidence?.state !== "available") continue;
          if (
            !image.data ||
            !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType ?? "")
          )
            continue;
          const bytes = Buffer.from(image.data, "base64");
          if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw failure("MEDIA_CAPACITY");
          const extension =
            image.mimeType === "image/png"
              ? "png"
              : image.mimeType === "image/jpeg"
                ? "jpeg"
                : "webp";
          const filename = `${randomUUID()}.${extension}`;
          await writeFile(path.join(c.native!.directory, filename), bytes, {
            mode: 0o600,
            flag: "wx",
          });
          await c.native!.admitStill({
            filename,
            imageEvidence,
            timestamp: Date.now(),
            label: "page",
            ...response.evidence,
            masking: c.maskingPartial ? "best_effort_partial" : "best_effort",
          });
          media.push({ artifactId: createHash("sha256").update(bytes).digest("hex") });
        }
        if (media.length) outcome.media = media;
        if (
          !response.isError &&
          mutating &&
          tool !== "browser_handle_dialog" &&
          !Object.hasOwn(nativeCapabilitySchemas, tool)
        ) {
          try {
            const observation = await this.nativeCall(c, attempt, {
              type: "call",
              tool: "browser_snapshot",
              args: {},
            });
            outcome.observation =
              observation.isError || observation.observationAvailable === false
                ? "unavailable"
                : "available";
            if (!observation.isError && observation.observationAvailable !== false)
              outcome.content = [
                ...(outcome.content as Content[]),
                ...observation.content.filter((v) => v.type === "text"),
              ];
            if (observation.observationAvailable === false && observation.observationIssue)
              outcome.observationIssue = observation.observationIssue;
            if (observation.observationId) outcome.observationId = observation.observationId;
          } catch (error) {
            outcome.observation = "unavailable";
            outcome.warning =
              "Action result retained; subsequent observation was unavailable. Do not repeat the action without checking the app.";
            if (
              error instanceof Error &&
              /ADAPTER_(?:TIMEOUT|LOST|COMMAND_CONCURRENT)|COMMAND_PHASE_EXPIRED/u.test(
                error.message,
              )
            )
              await this.stop(c, true);
            outcome.observationIssue =
              error instanceof Error &&
              (adapterFailureCodes.has(error.message.replace(/^SCRY_BROWSER_/, "")) ||
                /^SCRY_BROWSER_(?:ADAPTER_TIMEOUT|ADAPTER_LOST|COMMAND_PHASE_EXPIRED|OWNER_FENCED)$/.test(
                  error.message,
                ))
                ? error.message
                : "SCRY_BROWSER_OBSERVATION_UNAVAILABLE";
          }
        }
        await commandOptions.persistAction?.(outcome);
        return published(outcome);
      } catch (error) {
        try {
          if (
            error instanceof Error &&
            /ADAPTER_(?:TIMEOUT|LOST|COMMAND_CONCURRENT)|COMMAND_PHASE_EXPIRED/u.test(error.message)
          )
            await this.stop(c, true);
        } finally {
          const preserved = contextual(
            lastAction
              ? {
                  ...lastAction,
                  ...(lastAction.execution === "unknown" &&
                  lastAction.businessOutcome !== "not_dispatched"
                    ? { businessOutcome: "unknown" }
                    : {}),
                }
              : // No action checkpoint means this command never reached native
                // dispatch. Context from an idle denial must not invent an
                // uncertain effect and quarantine otherwise valid successors.
                {
                  execution: "not_dispatched",
                  businessOutcome: "not_dispatched",
                  observation: "unavailable",
                },
          );
          if (preserved.scopeDiagnostics && !checkpointFailed) {
            // Existing claim-bound persistence only; no diagnostic query, IPC,
            // extra observation, retry budget or dependency request is added.
            await options
              .persistAction?.(preserved)
              .then(() => {
                c.lastPublishedDenialCursor = c.retired ? c.denials.cursor() : publication;
              })
              .catch(() => undefined);
          }
        }
        throw error;
      } finally {
        if (c.captureDenials === captureDenials) delete c.captureDenials;
        c.supervision.finish(c.retired);
        // Ending a local attempt is not an acknowledged custodian transition.
        // Publish idle before the lane can admit a different command sequence.
        if (c.custody && !c.retired) await c.custody.synchronize();
      }
    });
    // Publication occurs only after CommandLane has completely settled. A tool
    // catalog, run ID, in-flight checkpoint, or former owner is not capability.
    let readOnlyImageInspectionSupported = false;
    try {
      c.lease?.assertActive();
      readOnlyImageInspectionSupported =
        !!c.lease &&
        !this.#stopping &&
        !c.retired &&
        !c.stopping &&
        c.lane.available &&
        c.custody?.terminationState === "active" &&
        c.custody.exitConfirmed === false &&
        c.worker?.alive === true &&
        c.worker.supportsReadOnlyImages === true;
    } catch {
      /* A revoked/expired lease cannot advertise a recovery capability. */
    }
    const recordingAssessment = canonicalRecordingAssessment(
      result.recordingAssessment ?? c.recordingAssessment,
    );
    return {
      ...result,
      ...(recordingAssessment ? { recordingAssessment } : {}),
      readOnlyImageInspectionSupported,
    };
  }
  private async finish(c: Cell, forFailure: boolean): Promise<Record<string, unknown>> {
    if (c.sealed) return c.sealed;
    // A recovered close adopts only admitted recording reservations. It never
    // starts a replacement browser or repeats a possibly applied action.
    if (!c.lease || c.lease.signal.aborted) {
      if (c.launch) await this.stop(c, true);
      c.retired = false;
      delete c.stopping;
      delete c.escalateStop;
      delete c.evidence;
      delete c.native;
      delete c.capture;
      delete c.recordingAssessment;
      delete c.launch;
      delete c.custody;
      delete c.worker;
      delete c.proxy;
      c.forceStopRequested = false;
      c.capturePolicyGeneration = 1;
      await this.claim(c);
    }
    const lease = c.lease!,
      scope = c.scope!;
    await lease.checkpoint();
    if (forFailure) await this.effects.prepareFailureFinalization(c.id, lease.ownerGeneration);
    const healthy = !!c.launch && !c.retired;
    if (c.launch) await this.stop(c, false);
    const status = await this.commands.evidenceStatus(c.id);
    if (lease.signal.aborted) throw failure("OWNER_FENCED");
    // A new process needs a capture writer only if there is an unsealed prefix
    // into which a finalized native-file receipt can still be admitted.
    if (status?.captureStopped) {
      c.evidence = await this.evidenceService.openSession({
        purpose: "closure",
        root: this.root(c.id),
        runId: scope.runId,
        sessionId: c.id,
        admission: lease,
        protection: this.protection.readEvidence(scope),
        maxSessionBytes: 20 * 1024 * 1024,
      });
    } else {
      if (!c.evidence) {
        if (!this.protection.nativeEvidence) throw failure("ADAPTER_PROTECTION_UNAVAILABLE");
        c.evidence = await this.evidenceService.openSession({
          root: this.root(c.id),
          runId: scope.runId,
          sessionId: c.id,
          admission: lease,
          protection: this.protection.nativeEvidence(scope),
          maxSessionBytes: 20 * 1024 * 1024,
        });
      }
      if (!c.native) c.native = await c.evidence.createNativeRecording();
      const recovered = await c.evidence.recoverNativeCaptures!(c.native);
      await c.evidence.stopCapture({
        browserStopped: true,
        recordingDrained: true,
        recordingComplete:
          healthy &&
          recovered.admitted > 0 &&
          recovered.recordingAssessment?.state === "best_effort_assessed",
      });
      const recordingAssessment = canonicalRecordingAssessment(recovered.recordingAssessment);
      if (recordingAssessment) c.recordingAssessment = recordingAssessment;
      else delete c.recordingAssessment;
    }
    const completion = await c.evidence.seal({
      failureClosure: forFailure,
      renderVideo: false,
      actionLedger: () => this.commands.safeActionLedger(c.id),
    });
    await this.effects.completeEvidence(lease.identity, completion);
    await this.effects.retireOwner({
      owner: lease.identity,
      browserStopped: true,
      recordingDrained: true,
    });
    lease.revoke();
    c.sealed = {
      closed: true,
      ownerGeneration: lease.ownerGeneration,
      evidenceState: completion.state,
      ...(completion.issue ? { evidenceIssue: completion.issue } : {}),
      ...(canonicalRecordingAssessment(completion.recordingAssessment ?? c.recordingAssessment)
        ? {
            recordingAssessment: canonicalRecordingAssessment(
              completion.recordingAssessment ?? c.recordingAssessment,
            ),
          }
        : {}),
    };
    // Keep only a small idempotent tombstone. A completed Run must not retain
    // child transports, browser channels, recorder stores or secret policy state.
    delete c.worker;
    delete c.custody;
    delete c.launch;
    delete c.proxy;
    delete c.evidence;
    delete c.native;
    delete c.capture;
    delete c.lease;
    delete c.opening;
    delete c.stopping;
    delete c.escalateStop;
    delete c.policyDigest;
    return c.sealed;
  }
  async closeAll(): Promise<void> {
    this.#stopping = true;
    const results = await Promise.allSettled(
      [...this.#cells.values()].map(async (c) => {
        await this.stop(c, true);
        if (c.lease && !c.lease.signal.aborted) {
          await this.effects.retireOwner({
            owner: c.lease.identity,
            browserStopped: true,
            recordingDrained: true,
          });
          c.lease.revoke();
        }
      }),
    );
    if (results.some((r) => r.status === "rejected")) throw failure("OWNER_RETIREMENT_UNCONFIRMED");
  }
}
