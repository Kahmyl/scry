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
  scope?: PraxisSessionScope;
  lease?: PraxisOwnerLease;
  evidence?: ChronicleEvidenceSessionPort;
  native?: ChronicleNativeRecordingPort;
  launch?: Promise<SupervisedBrowser>;
  custody?: SupervisedBrowser;
  worker?: AdapterWorker;
  proxy?: Proxy;
  downloadDirectory?: string;
  policyDigest?: string;
  maskingPartial: boolean;
  sealed?: Record<string, unknown>;
};

/** An IPC-only official adapter. No API credentials, database, lease, or
 * encryption key enters this process. Its browser is independently supervised. */
class AdapterWorker {
  readonly child: ChildProcess;
  #sequence = 0;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    directory: string,
    entrypoint: string,
    onWarning: (event?: MaskingDiagnostic) => void,
    onLost: () => void,
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
      if (m.ok) call.resolve(m.data);
      else
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
      onLost();
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
      this.#pending.set(id, { resolve, reject, timer });
      this.child.send({ ...message, id }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(failure("ADAPTER_LOST"));
        }
      });
    });
  }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
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
      c = {
        id,
        lane: new CommandLane(),
        supervision: new ExecutionSupervision(),
        retired: false,
        maskingPartial: false,
      };
      this.#cells.set(id, c);
    }
    return c;
  }
  private active(c: Cell): void {
    if (this.#stopping || c.retired) throw failure("SESSION_CLOSING");
    c.lease?.assertActive();
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
    if (!c.native.reserveCapture) throw failure("ADAPTER_CAPTURE_UNAVAILABLE");
    await c.evidence.startCapture();
    const captureDirectory = await c.native.reserveCapture();
    c.downloadDirectory = path.join(captureDirectory, "downloads");
    this.active(c);
    // @ts-expect-error Private JavaScript transport, characterized by proxy contract tests.
    const { originProxy } = await import("./mcp-native/proxy.mjs");
    c.proxy = (await originProxy(scope.allowedOrigins ?? [scope.baseOrigin])) as Proxy;
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
    );
    const secrets = await this.commands.protectedValuesForSession(c.id);
    this.active(c);
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
    c.retired = true;
    return (c.stopping ??= (async () => {
      await c.opening?.catch(() => undefined);
      try {
        const custody = c.custody ?? (await c.launch);
        if (custody) await (force ? custody.terminate() : custody.close());
        await c.worker?.stop();
        await c.proxy?.close();
        if (c.downloadDirectory) await rm(c.downloadDirectory, { recursive: true, force: true });
      } catch (error) {
        this.runtimeOptions.onUnconfirmedRuntime?.();
        throw error;
      }
    })());
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
  private nativeCall(c: Cell, attempt: CommandAttempt, message: Record<string, unknown>) {
    return this.phase(c, attempt, 30000, () =>
      c.worker!.call(message, attempt.remainingMs(29000)),
    ) as Promise<ToolResult>;
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
      if (!observation.isError) {
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
    return c.lane.run(options, async (attempt) => {
      attempt.bind({ stop: () => this.stop(c, true) });
      if (c.retired && (command.kind === "close" || command.kind === "close_for_failure")) {
        // A failed phase stays terminal for browser interactions. Only confirmed
        // physical retirement permits a fresh, evidence-only cleanup attempt.
        await this.stop(c, true);
        c.supervision = new ExecutionSupervision();
      }
      c.supervision.begin(attempt, options.sampleAuthority);
      try {
        // Even a fail-fast validation refusal is an admitted command. Publish
        // its active sequence before it can finish, otherwise idle skips an
        // unseen sequence and the independent custodian correctly fences it.
        if (c.custody && !c.retired) await c.custody.synchronize();
        await options.assertCurrent?.();
        if (command.kind === "close" || command.kind === "close_for_failure")
          return await this.finish(c, command.kind === "close_for_failure");
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
        const revision = createHash("sha256").update(JSON.stringify(values)).digest("hex");
        if (revision !== c.policyDigest) {
          await this.phase(c, attempt, 5000, () =>
            c.worker!.call({ type: "policy", secrets: values }, 4000),
          );
          c.policyDigest = revision;
        }
        if (tool === "browser_sequence")
          return await this.executeSequence(
            c,
            attempt,
            browserSequenceInputSchema.parse(args),
            options,
          );
        const mutating = !nativeObservationTools.has(tool);
        await options.persistAction?.({
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
          observation: "available",
          content: [],
          masking: c.maskingPartial ? "best_effort_partial" : "best_effort",
        };
        if (response.interaction) outcome.inputObservation = response.interaction;
        if (response.observationId) outcome.observationId = response.observationId;
        // Action truth is durable before independent observation or media IO.
        outcome.content = response.content.filter((v) => v.type === "text");
        await options.persistAction?.(outcome);
        const media: Array<{ artifactId: string }> = [];
        for (const image of response.content.filter((v) => v.type === "image")) {
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
          await c.native!.admit({
            filename,
            kind: "screenshot",
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
            outcome.observation = observation.isError ? "unavailable" : "available";
            if (!observation.isError)
              outcome.content = [
                ...(outcome.content as Content[]),
                ...observation.content.filter((v) => v.type === "text"),
              ];
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
        await options.persistAction?.(outcome);
        return outcome;
      } catch (error) {
        if (
          error instanceof Error &&
          /ADAPTER_(?:TIMEOUT|LOST|COMMAND_CONCURRENT)|COMMAND_PHASE_EXPIRED/u.test(error.message)
        )
          await this.stop(c, true);
        throw error;
      } finally {
        c.supervision.finish(c.retired);
        // Ending a local attempt is not an acknowledged custodian transition.
        // Publish idle before the lane can admit a different command sequence.
        if (c.custody && !c.retired) await c.custody.synchronize();
      }
    });
  }
  private async finish(c: Cell, forFailure: boolean): Promise<Record<string, unknown>> {
    if (c.sealed) return c.sealed;
    // A recovered close adopts only admitted recording reservations. It never
    // starts a replacement browser or repeats a possibly applied action.
    if (!c.lease || c.lease.signal.aborted) {
      if (c.launch) await this.stop(c, true);
      c.retired = false;
      delete c.stopping;
      delete c.evidence;
      delete c.native;
      delete c.launch;
      delete c.custody;
      delete c.worker;
      delete c.proxy;
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
        recordingComplete: healthy && recovered > 0,
      });
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
    };
    // Keep only a small idempotent tombstone. A completed Run must not retain
    // child transports, browser channels, recorder stores or secret policy state.
    delete c.worker;
    delete c.custody;
    delete c.launch;
    delete c.proxy;
    delete c.evidence;
    delete c.native;
    delete c.lease;
    delete c.opening;
    delete c.stopping;
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
