import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { originProxy } from "./proxy.mjs";
import { recording, inspectRecording } from "./recording.mjs";
import { protector } from "./protection.mjs";
import { PolicyDiagnostics } from "./policy-diagnostics.mjs";
import { observationTools } from "./action-kind.mjs";

export const allowedTools = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_find",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_drag",
  "browser_hover",
  "browser_tabs",
  "browser_handle_dialog",
  "browser_take_screenshot",
  "browser_mouse_move_xy",
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_down",
  "browser_mouse_up",
  "browser_mouse_wheel",
  "browser_wait_for",
]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export class Coordinator {
  constructor({ root, environments, workspace = "isolated", deadlineMs = 35000 }) {
    this.root = root;
    this.environments = environments;
    this.workspace = workspace;
    this.deadlineMs = deadlineMs;
    this.store = new Store(root);
    this.live = new Map();
  }
  async recover() {
    for (const row of this.store.db
      .prepare("SELECT id FROM runs WHERE state='interrupted' AND evidence IS NULL")
      .all()) {
      const directory = path.join(this.root, row.id);
      await delay(250);
      const media = await inspectRecording(directory);
      this.store.finish(row.id, this.workspace, "interrupted", {
        ...media,
        coverage: media.unavailable ? "unavailable" : "partial",
        reason: "parent_restarted",
        masking: "best_effort",
      });
    }
  }
  async start(environment) {
    const policy = this.environments[environment];
    if (!policy?.allowTesting) throw new Error("ENVIRONMENT_NOT_AUTHORIZED");
    if (this.live.size >= 2) throw new Error("CANDIDATE_CAPACITY");
    const row = this.store.create(this.workspace, environment),
      secrets = this.store.secrets(environment),
      protection = protector(secrets);
    const directory = path.join(this.root, row.id);
    await mkdir(directory, { mode: 0o700 });
    const runtime = {
      row,
      protection,
      tail: Promise.resolve(),
      pending: new Map(),
      network: 0,
      pageCrashes: 0,
      policyDiagnostics: new PolicyDiagnostics(),
      masking: "best_effort",
      directory,
    };
    this.live.set(row.id, runtime);
    try {
      runtime.proxy = await originProxy(policy.origins, (event) => {
        runtime.policyDiagnostics.record(event);
      });
      runtime.recorder = await recording(directory, policy.recording);
      const output = path.join(os.tmpdir(), "scry-browser-output-" + row.id);
      runtime.output = output;
      const env = {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: os.tmpdir(),
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH
          ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
          : {}),
      };
      runtime.child = fork(fileURLToPath(new URL("./browser-worker.mjs", import.meta.url)), [], {
        env,
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      runtime.child.stderr.on("data", () => {});
      runtime.child.on("message", (message) => {
        if (message.type === "browserEvent" && message.event === "viewport_alignment_unavailable") {
          runtime.captureIssue = true;
          return;
        }
        if (message.type === "browserEvent" && message.event === "page_crashed") {
          runtime.pageCrashes++;
          this.store.finding(row.id, this.workspace, {
            classification: "scry_failure",
            summary:
              "A browser tab crashed. Inspect its application state; do not assume an in-flight change failed or retry it automatically.",
          });
          return;
        }
        if (message.type === "phase") {
          runtime.phase = message.phase;
          return;
        }
        if (message.type === "browserPid") {
          runtime.browserPid = message.pid;
          return;
        }
        if (message.type === "network") {
          runtime.network++;
          return;
        }
        if (message.type === "masking") {
          runtime.masking = message.state;
          return;
        }
        const pending = runtime.pending.get(message.id);
        if (!pending) return;
        runtime.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new Error(message.error));
      });
      runtime.child.on("exit", () => {
        runtime.lost = true;
        for (const pending of runtime.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("BROWSER_WORKER_LOST"));
        }
        runtime.pending.clear();
      });
      runtime.tools = await this.rpc(
        runtime,
        {
          type: "init",
          secrets,
          output,
          proxy: runtime.proxy.url,
          display: runtime.recorder.display,
        },
        25000,
      );
      return {
        runId: row.id,
        state: "active",
        environment,
        availableSecretIds: Object.keys(secrets),
        warning:
          "Testing may change the application. Automatic masking is best effort; review evidence before sharing.",
      };
    } catch (error) {
      await this.teardown(runtime, "setup_failed");
      throw new Error(protection.clean(error.message));
    }
  }
  rpc(runtime, message, timeout = this.deadlineMs) {
    if (runtime.lost || !runtime.child?.connected)
      return Promise.reject(new Error("BROWSER_WORKER_LOST"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(id);
        reject(new Error("BROWSER_HARD_DEADLINE"));
      }, timeout);
      runtime.pending.set(id, { resolve, reject, timer });
      runtime.child.send({ ...message, id }, (error) => {
        if (error) {
          clearTimeout(timer);
          runtime.pending.delete(id);
          reject(new Error("BROWSER_WORKER_LOST"));
        }
      });
    });
  }
  status(runId) {
    const row = this.store.run(runId, this.workspace);
    const { generation, workspace, ...publicRow } = row;
    return {
      ...publicRow,
      evidence: row.evidence ?? this.live.get(runId)?.recorder?.status ?? null,
      runId: row.id,
      actions: this.store.actions(runId).map(({ generation, result, ...receipt }) => receipt),
    };
  }
  async action(runId, actionId, tool, args) {
    const row = this.store.run(runId, this.workspace),
      runtime = this.live.get(runId);
    if (!allowedTools.has(tool) && tool !== "browser_type_secret")
      throw new Error("TOOL_NOT_ALLOWED");
    if ("filename" in args || "code" in args || "function" in args)
      throw new Error("UNSUPPORTED_ARGUMENT");
    if (
      tool === "browser_wait_for" &&
      args.time !== undefined &&
      (!Number.isFinite(args.time) || args.time < 0 || args.time > 10)
    )
      throw new Error("INVALID_TOOL_ARGUMENTS");
    if (
      tool === "browser_navigate" &&
      !this.environments[row.environment].origins.includes(new URL(args.url).origin)
    )
      throw new Error("ORIGIN_NOT_ALLOWED");
    if (runtime && (runtime.queued ?? 0) >= 32) throw new Error("ACTION_QUEUE_CAPACITY");
    const protection = runtime?.protection ?? protector(this.store.secrets(row.environment));
    const admitted = this.store.admit(row, actionId, tool, args, protection.clean(args));
    if (admitted.replay) return { receipt: admitted.receipt, replay: true };
    if (!runtime) throw new Error("RUN_NOT_ACTIVE");
    runtime.queued = (runtime.queued ?? 0) + 1;
    const operation = runtime.tail.then(async () => {
      let receipt = {
        ...admitted.receipt,
        execution: "running",
        started: Date.now(),
        observation: "pending",
      };
      this.store.update(runId, actionId, receipt);
      const before = runtime.network,
        blocked = runtime.policyDiagnostics.checkpoint();
      let dispatchAttempted = false;
      try {
        const active = this.store.run(runId, this.workspace);
        if (active.state !== "active" || active.generation !== row.generation || runtime.lost)
          throw new Error("BROWSER_WORKER_LOST");
        let upstreamTool = tool,
          upstreamArgs = { ...args },
          secret;
        if (tool === "browser_type_secret") {
          secret = this.store.secrets(row.environment)[args.secretId];
          if (!secret) throw new Error("SECRET_NOT_FOUND");
          upstreamTool = "browser_type";
          upstreamArgs = {
            target: args.target,
            text: "",
            ...(args.submit ? { submit: true } : {}),
          };
        }
        dispatchAttempted = true;
        const result = await this.rpc(runtime, {
          type: "call",
          tool: upstreamTool,
          args: upstreamArgs,
          secret,
        });
        receipt = {
          ...receipt,
          execution: result.isError ? "failed" : "succeeded",
          finished: Date.now(),
          observation: "pending",
          reason: result.isError ? "browser_action_error" : undefined,
          networkRequests: runtime.network - before,
          policyBlocks: runtime.policyDiagnostics.since(blocked),
          browserPageCrashes: runtime.pageCrashes,
          result: protection.clean(result.content.filter((c) => c.type === "text")),
        };
        if (result.isError) {
          const details = receipt.result
            .map((c) => c.text)
            .join("\n")
            .slice(0, 5000);
          receipt.error = {
            category: /Timeout|timed out/i.test(details)
              ? "actionability_timeout"
              : /Ref .*not found|does not match/i.test(details)
                ? "stale_or_missing_target"
                : "browser_tool_error",
            details,
          };
          if (receipt.error.category === "actionability_timeout" && !observationTools.has(tool))
            receipt.businessOutcome = "unknown";
        }
        // Persist action truth BEFORE independent observation, not afterward.
        this.store.update(runId, actionId, receipt);
        const images = result.content.filter((c) => c.type === "image");
        if (images.length)
          try {
            receipt.media = [];
            for (const image of images) {
              const bytes = Buffer.from(image.data, "base64");
              if (bytes.length > 16 * 1024 * 1024) throw new Error("SCREENSHOT_CAPACITY");
              const hash = createHash("sha256").update(bytes).digest("hex");
              const filename =
                hash +
                "." +
                (image.mimeType === "image/jpeg"
                  ? "jpg"
                  : image.mimeType === "image/webp"
                    ? "webp"
                    : "png");
              const handle = await open(path.join(runtime.directory, filename), "w", 0o600);
              try {
                await handle.writeFile(bytes);
                await handle.sync();
              } finally {
                await handle.close();
              }
              receipt.media.push({
                kind: "screenshot",
                artifactId: hash,
                filename,
                bytes: bytes.length,
                mimeType: image.mimeType,
              });
            }
          } catch {
            receipt.evidenceIssue = "screenshot_admission_failed";
          }
        let observation, observationFatal;
        try {
          observation = ["browser_snapshot", "browser_find"].includes(tool)
            ? result
            : await this.rpc(runtime, { type: "call", tool: "browser_snapshot", args: {} });
          receipt.observation = observation.isError ? "unavailable" : "available";
        } catch (error) {
          receipt.observation = "unavailable";
          receipt.observationReason = "observation_failed";
          receipt.observationPhase = runtime.phase;
          if (["BROWSER_HARD_DEADLINE", "BROWSER_WORKER_LOST"].includes(error.message))
            observationFatal = error.message;
        }
        this.store.update(runId, actionId, receipt);
        if (observationFatal) await this.teardown(runtime, observationFatal);
        return {
          receipt,
          content: [
            ...result.content.filter((c) => c.type !== "image"),
            ...(["browser_snapshot", "browser_find"].includes(tool)
              ? []
              : (observation?.content ?? [])),
            ...images,
          ],
          isError: result.isError,
          warning:
            receipt.businessOutcome === "unknown"
              ? "The tool timed out after dispatch. The application may already have changed. Inspect its state; do not retry automatically."
              : observationFatal
                ? "The action finished, but its resulting view could not be observed and this browser was retired. Inspect test status; do not repeat the action automatically."
                : runtime.pageCrashes
                  ? "A browser tab crashed. Inspect tabs and application state before continuing; do not retry uncertain changes."
                  : runtime.masking !== "best_effort"
                    ? "Automatic masking could not be confirmed for every view. Review evidence."
                    : undefined,
        };
      } catch (error) {
        const reason = ["BROWSER_HARD_DEADLINE", "BROWSER_WORKER_LOST"].includes(error.message)
          ? error.message
          : "browser_adapter_error";
        receipt = {
          ...receipt,
          execution: dispatchAttempted ? "unknown" : "failed",
          businessOutcome:
            dispatchAttempted && !observationTools.has(tool) ? "unknown" : "not_inferred",
          observation: "unavailable",
          finished: Date.now(),
          reason: dispatchAttempted ? reason : "not_dispatched",
          diagnostic: protection.clean(error.message),
          phase: runtime.phase,
          networkRequests: runtime.network - before,
          policyBlocks: runtime.policyDiagnostics.since(blocked),
          browserPageCrashes: runtime.pageCrashes,
        };
        this.store.update(runId, actionId, receipt);
        if (reason === "BROWSER_HARD_DEADLINE" || reason === "BROWSER_WORKER_LOST")
          await this.teardown(runtime, reason);
        return {
          receipt,
          isError: true,
          content: [
            {
              type: "text",
              text: dispatchAttempted
                ? observationTools.has(tool)
                  ? "The browser observation did not finish reliably. Inspect test status before continuing."
                  : "The browser action did not finish reliably. Its application outcome is unknown. Inspect status; do not retry automatically."
                : "This action was not dispatched to the browser. Check the receipt for the rejected precondition.",
            },
          ],
        };
      }
    });
    runtime.tail = operation.catch(() => {});
    return operation.finally(() => {
      runtime.queued--;
    });
  }
  async finish(runId, outcome = "completed") {
    this.store.run(runId, this.workspace);
    const runtime = this.live.get(runId);
    if (!runtime) return this.status(runId);
    await runtime.tail;
    await this.teardown(runtime, outcome === "completed" ? "complete" : outcome, true);
    return this.status(runId);
  }
  async cancel(runId) {
    this.store.run(runId, this.workspace);
    const runtime = this.live.get(runId);
    if (runtime) await this.teardown(runtime, "cancelled");
    return this.status(runId);
  }
  async teardown(runtime, reason, graceful = false) {
    if (runtime.closing) return runtime.closing;
    runtime.closing = (async () => {
      if (runtime.child?.connected)
        await this.rpc(runtime, { type: "close" }, 2500).catch(() => {});
      // Kill only the process groups belonging to this Run; never another browser/session.
      for (const pid of [runtime.browserPid, runtime.child?.pid])
        if (pid)
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
      const evidence = runtime.recorder
        ? await runtime.recorder.close(graceful ? "complete" : reason)
        : { coverage: "unavailable", reason };
      evidence.masking = runtime.masking;
      if (runtime.captureIssue) {
        evidence.coverage = evidence.coverage === "unavailable" ? "unavailable" : "partial";
        evidence.reason = "viewport_alignment_unavailable";
      }
      await runtime.proxy?.close();
      if (runtime.output) await rm(runtime.output, { recursive: true, force: true });
      this.store.finish(
        runtime.row.id,
        this.workspace,
        reason === "complete" ? "completed" : reason,
        evidence,
      );
      this.live.delete(runtime.row.id);
    })();
    return runtime.closing;
  }
  async close() {
    await Promise.all([...this.live.values()].map((r) => this.teardown(r, "server_stopped")));
    this.store.close();
  }
}
