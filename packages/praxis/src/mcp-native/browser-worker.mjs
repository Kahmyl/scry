import { chromium } from "playwright-mcp-runtime";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, realpath, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import { BestEffortTasks } from "./best-effort-tasks.mjs";
import { MaskingDiagnostics } from "./masking-diagnostics.mjs";
import { displayLayout } from "./display-layout.mjs";
import { NativeInteractions, privateClipboard } from "./native-interactions.mjs";
import {
  editBrowserTextSchema,
  screenshotPresentationSchema,
  browserSequenceInputSchema,
  nativeCapabilitySchemas,
  viewportProfiles,
} from "@scry/contracts";
import { bindKnownControls, observeControlState } from "./known-controls.mjs";
import { scopedHttp } from "./scoped-http.mjs";
import { DownloadTracker } from "./downloads.mjs";
export function startBrowserAdapter(makeProtector) {
  let browser, context, client, upstream, protection, output, closing, validators, interactions;
  let handling = false;
  let plan;
  let observation;
  let capabilitiesEnabled = false,
    allowedOrigins = [],
    privateOrigins = [],
    viewport = { ...displayLayout.viewport },
    downloads,
    downloadSession,
    downloadContext,
    downloadDirectory;
  const sessions = new Map();
  const dialogs = new Map();
  const masking = new MaskingDiagnostics((event) => process.send?.({ type: "masking", event }));
  const maskingWarning = (page) => masking.degrade(page, "installation_failed");
  const maskTasks = new BestEffortTasks(
    (reason, page) => masking.degrade(page, reason),
    200,
    (page) => masking.recovered(page),
  );
  async function install(page) {
    masking.degrade(page, "installation_pending");
    page.on("dialog", (dialog) => dialogs.set(dialog, page));
    downloads?.attach(page);
    await page.setViewportSize(viewport);
    const session = await context.newCDPSession(page);
    sessions.set(page, session);
    page.once("close", () => {
      sessions.delete(page);
      maskTasks.forget(page);
      masking.forget(page);
      for (const [dialog, owner] of dialogs) if (owner === page) dialogs.delete(dialog);
    });
    page.once("crash", () => {
      sessions.delete(page);
      maskTasks.forget(page);
      masking.forget(page);
      for (const [dialog, owner] of dialogs) if (owner === page) dialogs.delete(dialog);
      process.send?.({ type: "browserEvent", event: "page_crashed" });
    });
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      if (downloadSession && !downloadContext) {
        downloadContext = targetInfo.browserContextId;
        await downloadSession.send("Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          browserContextId: downloadContext,
          downloadPath: downloadDirectory,
          eventsEnabled: true,
        });
      }
      const { windowId } = await session.send("Browser.getWindowForTarget", {
        targetId: targetInfo.targetId,
      });
      await session.send("Browser.setWindowBounds", { windowId, bounds: displayLayout.window });
    } catch {
      if (!page.isClosed())
        process.send?.({ type: "browserEvent", event: "viewport_alignment_unavailable" });
    }
    await session.send("Page.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: protection.script,
      worldName: "scry-native-protection",
      runImmediately: true,
    });
  }
  async function maskReady() {
    // JavaScript execution is paused by native dialogs. The installed overlay
    // continues to be best effort; a refresh must never block dialog handling.
    const blocked = new Set(dialogs.values());
    for (const page of blocked) masking.degrade(page, "dialog_refresh_deferred");
    await maskTasks.run(
      [...sessions]
        .filter(([page]) => !page.isClosed() && !blocked.has(page))
        .map(([page, session], index) => [
          page,
          async () => {
            process.send?.({ type: "phase", phase: "mask_frame_tree:page" + index });
            const { frameTree } = await session.send("Page.getFrameTree");
            process.send?.({ type: "phase", phase: "mask_world" });
            const world = await session.send("Page.createIsolatedWorld", {
              frameId: frameTree.frame.id,
              worldName: "scry-native-protection",
              grantUniveralAccess: false,
            });
            process.send?.({ type: "phase", phase: "mask_refresh" });
            const refreshed = await session.send("Runtime.evaluate", {
              contextId: world.executionContextId,
              expression:
                "new Promise((resolve,reject)=>{if(typeof globalThis.__scryNativeRefresh!=='function'){reject(new Error('mask_not_installed'));return;}globalThis.__scryNativeRefresh();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));setTimeout(()=>resolve(true),100);})",
              awaitPromise: true,
            });
            if (refreshed.exceptionDetails || refreshed.result?.value !== true)
              throw Error("MASK_REFRESH_UNCONFIRMED");
          },
        ]),
    );
  }
  async function normalize(result) {
    const content = [];
    for (const item of result.content ?? []) {
      if (item.type !== "text") {
        if (item.type === "image") content.push(item);
        continue;
      }
      let text = item.text;
      // The upstream screenshot file is a private transport scratch copy. The
      // returned image bytes go to Chronicle; retaining this extra copy per call
      // would defeat the platform's screenshot deduplication/storage limits.
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+\.(?:png|jpeg|webp))\)/g)) {
        const file = await realpath(path.resolve(process.cwd(), match[1])).catch(() => null);
        if (file?.startsWith(output + path.sep)) await unlink(file).catch(() => {});
      }
      // Upstream output locations are private implementation details, never customer prerequisites.
      for (const match of text.matchAll(/\[Snapshot\]\(([^)]+\.yml)\)/g)) {
        const file = await realpath(path.resolve(process.cwd(), match[1])).catch(() => null);
        if (file && file.startsWith(output + path.sep)) {
          const bytes = await readFile(file);
          if (bytes.length > 1024 * 1024) throw new Error("SNAPSHOT_CAPACITY");
          text = text.replace(match[0], "Snapshot:\n" + bytes.toString("utf8"));
          await unlink(file);
        } else text = text.replace(match[0], "Snapshot unavailable");
      }
      // Hide generated code and local artifact paths; keep browser state and typed errors.
      text = text
        .replace(/### Ran Playwright code[\s\S]*?(?=### |$)/g, "")
        .replaceAll(output, "[private-artifacts]");
      text = text
        .replace(/\[([^\]]+)\]\([^)]*\[private-artifacts\][^)]*\)/g, "$1 (returned with this tool)")
        .replace(
          /\[([^\]]+)\]\(\.\/page-[^)]+\.(?:png|jpeg|webp)\)/g,
          "$1 (returned with this tool)",
        )
        .replace(
          /^.*New console entries:.*$/gm,
          "Additional console messages omitted from this result.",
        );
      content.push({ type: "text", text: protection.clean(text) });
    }
    return { content, isError: result.isError ?? false };
  }
  async function close() {
    return (closing ??= (async () => {
      await plan?.binding.dispose().catch(() => {});
      plan = undefined;
      await observation?.guard.dispose().catch(() => {});
      observation = undefined;
      await downloads?.close();
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await client?.close().catch(() => {});
      await upstream?.close().catch(() => {});
    })());
  }
  function terminate() {
    const timer = setTimeout(() => {
      process.exit(1);
    }, 2500);
    timer.unref();
    void close().finally(() => process.exit(0));
  }
  process.on("disconnect", terminate);
  process.on("SIGTERM", terminate);
  process.on("message", async (message) => {
    if (handling) {
      process.send?.({ id: message.id, ok: false, code: "ADAPTER_COMMAND_CONCURRENT" });
      return;
    }
    handling = true;
    let pendingObservation;
    try {
      if (message.type === "init") {
        protection = makeProtector(message.secrets);
        output = message.output;
        capabilitiesEnabled = message.capabilitiesEnabled === true;
        downloadDirectory = message.downloadDirectory;
        allowedOrigins = message.allowedOrigins ?? [];
        privateOrigins = message.privateOrigins ?? [];
        if (capabilitiesEnabled)
          downloads = new DownloadTracker((value) => protection.clean(value));
        await mkdir(output, { recursive: true, mode: 0o700 });
        // The existing independent platform custodian owns the exact browser.
        // This worker has only its private connection, never ownership authority.
        browser = await chromium.connect(message.endpoint);
        if (capabilitiesEnabled) {
          downloadSession = await browser.newBrowserCDPSession();
          downloadSession.on("Browser.downloadProgress", (event) =>
            downloads.progress(event, (guid) =>
              downloadSession.send("Browser.cancelDownload", {
                guid,
                browserContextId: downloadContext,
              }),
            ),
          );
        }
        context = await browser.newContext({
          viewport: displayLayout.viewport,
          acceptDownloads: capabilitiesEnabled,
        });
        context.on("page", (page) => void install(page).catch(() => maskingWarning(page)));
        context.on("request", (r) =>
          process.send?.({
            type: "network",
            method: r.method(),
            origin: new URL(r.url()).origin,
            resource: r.resourceType(),
          }),
        );
        upstream = await createConnection(
          {
            browser: { browserName: "chromium" },
            webmcp: false,
            capabilities: ["core", "vision"],
            imageResponses: "allow",
            outputDir: output,
            outputMaxSize: 32 * 1024 * 1024,
            snapshot: { mode: "none" },
            timeouts: { action: 4000, navigation: 20000, settle: 350, idle: 0 },
          },
          async () => context,
        );
        const [a, b] = InMemoryTransport.createLinkedPair();
        await upstream.connect(b);
        client = new Client({ name: "scry-private-browser-adapter", version: "baseline" });
        await client.connect(a);
        const call = async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          if (result.isError) throw Error("NATIVE_INPUT_FAILED");
          return result;
        };
        interactions = new NativeInteractions(context, call, privateClipboard(message.display));
        const definitions = (await client.listTools()).tools;
        const ajv = new Ajv({ strict: false, useDefaults: true });
        validators = new Map(definitions.map((t) => [t.name, ajv.compile(t.inputSchema)]));
        process.send({ id: message.id, ok: true, data: definitions });
      } else if (message.type === "policy") {
        protection = makeProtector(message.secrets);
        // The isolated-world policy extends existing targets without replacing UI.
        // One revision is installed only when the bound protected values change.
        await Promise.all(
          [...sessions].map(([page, session]) =>
            session
              .send("Page.addScriptToEvaluateOnNewDocument", {
                source: protection.script,
                worldName: "scry-native-protection",
                runImmediately: true,
              })
              .catch(() => maskingWarning(page)),
          ),
        );
        process.send({ id: message.id, ok: true });
      } else if (message.type === "call" && Object.hasOwn(nativeCapabilitySchemas, message.tool)) {
        if (!capabilitiesEnabled || plan) throw Error("INVALID_TOOL_ARGUMENTS");
        const input = nativeCapabilitySchemas[message.tool].parse(message.args);
        let facts;
        if (message.tool === "browser_scoped_request") {
          const raw = await scopedHttp(
            input,
            { allowedOrigins, privateOrigins },
            message.requestBindings ?? [],
          );
          const { secretVariants = [], ...result } = raw;
          facts = makeProtector(
            Object.fromEntries(secretVariants.map((v, i) => ["request_" + i, v])),
          ).cleanApi(protection.cleanApi(result));
        } else if (message.tool === "browser_list_downloads")
          facts = {
            items: downloads.list(),
            capacityRejected: downloads.rejected ?? 0,
            capacityCancellationRequests: downloads.capacityCancellationRequests,
          };
        else if (message.tool === "browser_verify_download") {
          await downloads.wait(input.downloadId, input.waitSeconds * 1000);
          facts = downloads.verify(input.downloadId, input.expected);
        } else {
          await observation?.guard.dispose();
          observation = undefined;
          viewport = { ...viewportProfiles[input.profile] };
          for (const [page, session] of sessions) {
            await page.setViewportSize(viewport);
            const { targetInfo } = await session.send("Target.getTargetInfo");
            const { windowId } = await session.send("Browser.getWindowForTarget", {
              targetId: targetInfo.targetId,
            });
            await session.send("Browser.setWindowBounds", {
              windowId,
              bounds: displayLayout.window,
            });
          }
          const page = await interactions.activePage();
          const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          if (actual.width !== viewport.width || actual.height !== viewport.height)
            throw Error("VIEWPORT_UNCONFIRMED");
          await maskReady();
          facts = {
            profile: input.profile,
            actual,
            recordingCanvas: displayLayout.viewport,
            padding: actual.width < 1280 || actual.height < 720,
            deviceEmulation: false,
          };
        }
        process.send({
          id: message.id,
          ok: true,
          data: {
            isError: facts.execution === "unknown" || facts.execution === "not_dispatched",
            content: [{ type: "text", text: JSON.stringify(protection.clean(facts)) }],
            ...(facts.execution === "unknown" || facts.execution === "not_dispatched"
              ? {
                  interaction: {
                    status: facts.execution === "unknown" ? "unknown" : "not_dispatched",
                    inputState: facts.execution === "unknown" ? "unknown" : "not_started",
                    reason: facts.reason,
                    intent: "scoped_http",
                    method: input.method,
                  },
                }
              : {}),
          },
        });
      } else if (message.type === "prepare_plan") {
        const input = browserSequenceInputSchema.parse(message.input);
        await plan?.binding.dispose();
        plan = undefined;
        const page = await interactions.activePage();
        if (
          !observation ||
          input.observationId !== observation.id ||
          page !== observation.page ||
          !(await observation.guard.valid())
        )
          throw Error("OBSERVATION_INVALIDATED");
        const binding = await bindKnownControls(page, input.steps, (p, target) =>
          interactions.bind(p, target),
        );
        plan = { input, page, binding, next: 0 };
        process.send({ id: message.id, ok: true, data: { contractVersion: 1 } });
      } else if (message.type === "dispose_plan") {
        if (plan && plan.input.planId === message.planId) {
          await plan.binding.dispose();
          plan = undefined;
        }
        process.send({ id: message.id, ok: true });
      } else if (message.type === "call" || message.type === "plan_step") {
        const inPlan = message.type === "plan_step";
        let tool = message.tool,
          rawArgs = message.args;
        if (inPlan) {
          if (
            !plan ||
            message.planId !== plan.input.planId ||
            message.index !== plan.next ||
            !plan.input.steps[message.index]
          )
            throw Error("INVALID_PLAN_STATE");
          const step = plan.input.steps[message.index];
          tool = step.tool;
          rawArgs = step.args;
          if (tool === "browser_type_secret") {
            if (typeof message.secret !== "string") throw Error("INVALID_PLAN_STATE");
            tool = "browser_type";
            rawArgs = { target: step.args.target, text: "" };
          }
          if (tool === "browser_press_key") rawArgs = { key: step.args.key };
        } else if (plan) throw Error("INVALID_PLAN_STATE");
        const args = { ...rawArgs };
        if (tool === "browser_edit_text") editBrowserTextSchema.parse(args);
        const evidence = {};
        if (tool === "browser_take_screenshot") {
          screenshotPresentationSchema.parse(args);
          for (const key of ["evidenceTitle", "evidenceDescription"]) {
            if (args[key] !== undefined)
              evidence[key === "evidenceTitle" ? "title" : "description"] = protection.clean(
                args[key],
              );
            delete args[key];
          }
        }
        if (message.secret) {
          args.text = message.secret;
        }
        if (tool !== "browser_edit_text" && !validators.get(tool)?.(args))
          throw new Error("INVALID_TOOL_ARGUMENTS");
        await maskReady();
        let snapshotGuard, snapshotPage;
        if (tool === "browser_snapshot") {
          await observation?.guard.dispose();
          observation = undefined;
          snapshotPage = await interactions.activePage();
          snapshotGuard = await observeControlState(snapshotPage);
          pendingObservation = snapshotGuard;
        } else if (
          !inPlan &&
          !["browser_find", "browser_wait_for", "browser_take_screenshot"].includes(tool)
        ) {
          await observation?.guard.dispose();
          observation = undefined;
        }
        if (inPlan) {
          if ((await interactions.activePage()) !== plan.page)
            throw Error("OBSERVATION_INVALIDATED");
          if (!observation || !(await observation.guard.valid()))
            throw Error("OBSERVATION_INVALIDATED");
          await plan.binding.before(message.index, tool === "browser_press_key");
        }
        process.send?.({ type: "phase", phase: "upstream:" + tool });
        if (tool === "browser_drag" && /^(f\d+)?e\d+$/.test(args.startTarget)) {
          const page = await interactions.activePage(),
            binding = await interactions.bind(page, args.startTarget);
          try {
            if (!(await interactions.preparePointer(binding.locator)) || !(await binding.valid()))
              throw Error("TARGET_NOT_READY");
          } finally {
            await binding.handle.dispose();
          }
        }
        const result =
          tool === "browser_edit_text"
            ? await interactions.edit(args)
            : await client.callTool({ name: tool, arguments: args });
        if (inPlan) {
          await plan.binding.after(message.index);
          plan.next++;
        }
        if (tool === "browser_handle_dialog" && !result.isError) {
          const page = await interactions.activePage();
          for (const [dialog, owner] of dialogs)
            if (owner === page || owner.isClosed()) dialogs.delete(dialog);
        }
        await maskReady();
        process.send?.({ type: "phase", phase: "normalize:" + tool });
        const normalized = await normalize(result);
        if (snapshotGuard) {
          if (!result.isError && (await snapshotGuard.valid())) {
            observation = { id: randomUUID(), guard: snapshotGuard, page: snapshotPage };
            normalized.observationId = observation.id;
          } else await snapshotGuard.dispose();
          pendingObservation = undefined;
        }
        if (result.interaction) normalized.interaction = result.interaction;
        if (Object.keys(evidence).length) normalized.evidence = evidence;
        if (Buffer.byteLength(JSON.stringify(normalized)) > 24 * 1024 * 1024)
          throw new Error("TOOL_OUTPUT_CAPACITY");
        process.send({ id: message.id, ok: true, data: normalized });
      } else if (message.type === "close") {
        await close();
        process.send({ id: message.id, ok: true });
        process.exit(0);
      }
    } catch (error) {
      await pendingObservation?.dispose().catch(() => {});
      process.send?.({
        id: message.id,
        ok: false,
        code:
          {
            INVALID_TOOL_ARGUMENTS: "ADAPTER_INVALID_TOOL_ARGUMENTS",
            SNAPSHOT_CAPACITY: "ADAPTER_SNAPSHOT_CAPACITY",
            TOOL_OUTPUT_CAPACITY: "ADAPTER_OUTPUT_CAPACITY",
            TARGET_NOT_READY: "ADAPTER_TARGET_NOT_READY",
            REFERENCE_UNAVAILABLE: "ADAPTER_REFERENCE_UNAVAILABLE",
            CLIPBOARD_UNAVAILABLE: "ADAPTER_CLIPBOARD_UNAVAILABLE",
            OBSERVATION_INVALIDATED: "ADAPTER_OBSERVATION_INVALIDATED",
            INVALID_PLAN_STATE: "ADAPTER_INVALID_PLAN_STATE",
          }[error?.message] ?? "ADAPTER_CALL_FAILED",
      });
    } finally {
      handling = false;
    }
  });
}
