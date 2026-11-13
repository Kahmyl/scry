import { chromium } from "playwright-mcp-runtime";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, realpath, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import { BestEffortTasks } from "./best-effort-tasks.mjs";
import { installCaptureBinding } from "./capture-binding.mjs";
import { createCaptureProducer } from "./capture-producer.mjs";
import { refreshNativeProtection } from "./protection-refresh.mjs";
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
  let producer, captureEpoch;
  const pageIds = new WeakMap(),
    scriptRevisions = new WeakMap(),
    installedSessions = new WeakSet();
  let nextPageId = 0;
  const pageId = (page) => {
    if (!pageIds.has(page)) pageIds.set(page, nextPageId++);
    return pageIds.get(page);
  };
  const sendCapture = (event) =>
    new Promise((resolve, reject) => {
      if (!process.connected) return reject(Error("NATIVE_CAPTURE_SEND_UNCONFIRMED"));
      process.send(event, (error) =>
        error ? reject(Error("NATIVE_CAPTURE_SEND_UNCONFIRMED")) : resolve(),
      );
    });
  const emitGaps = () => {
    for (const reason of protection?.drainGaps() ?? []) producer?.gap(reason);
  };
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
  const maskTasks = new BestEffortTasks((reason, page) => masking.degrade(page, reason), 200);
  const pixelTasks = new BestEffortTasks((reason, page) => masking.degrade(page, reason), 200);
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
      pixelTasks.forget(page);
      masking.forget(page);
      for (const [dialog, owner] of dialogs) if (owner === page) dialogs.delete(dialog);
    });
    page.once("crash", () => {
      sessions.delete(page);
      maskTasks.forget(page);
      pixelTasks.forget(page);
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
    await installCaptureBinding(session, protection, (reason) => producer?.gap(reason));
    const source = protection.script,
      revision = protection.scriptRevision;
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source,
      worldName: "scry-native-protection",
      runImmediately: true,
    });
    installedSessions.add(session);
    scriptRevisions.set(session, revision);
    await syncDocuments();
  }
  async function syncDocuments() {
    await Promise.all(
      [...sessions].map(async ([page, session]) => {
        if (!installedSessions.has(session) || page.isClosed()) return;
        for (const update of protection.documentUpdatesSince(scriptRevisions.get(session) ?? 0)) {
          try {
            await session.send("Page.addScriptToEvaluateOnNewDocument", {
              source: update.script,
              worldName: "scry-native-protection",
              runImmediately: true,
            });
            scriptRevisions.set(session, update.revision);
          } catch {
            maskingWarning(page);
            break;
          }
        }
      }),
    );
  }
  async function maskReady(options = {}) {
    await syncDocuments();
    const alive = context.pages().filter((page) => !page.isClosed()),
      selected =
        options.selectedPage ??
        interactions?.cachedActivePage() ??
        (alive.length === 1 ? alive[0] : null);
    const read = await refreshNativeProtection({
      protection,
      sessions,
      pages: context.pages(),
      pageId,
      selectedPage: selected,
      finalReadChallenge: options.challenge,
      dialogs,
      maskTasks,
      pixelTasks,
      recovered: (page) => masking.recovered(page),
      degrade: (page, reason) => masking.degrade(page, reason),
      phase: (phase) => process.send?.({ type: "phase", phase }),
    });
    await syncDocuments();
    emitGaps();
    if (options.record !== false && protection.captureSample().readId === read) producer?.sample();
    return read;
  }
  async function normalize(result, tool) {
    const content = [];
    protection.prelearn(
      (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text),
    );
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
      content.push({ type: "text", text });
    }
    return {
      content: (() => {
        const snapshot =
          tool === "browser_snapshot" ||
          content.some(
            (item) =>
              item.type === "text" &&
              /Snapshot:\s*\n|```yaml|Page [Ss]napshot:/u.test(item.text ?? ""),
          );
        const cleaned = protection.cleanTextContent(content, snapshot);
        const image = protection.imageEvidence();
        return image.state === "withheld"
          ? cleaned.filter((item) => item.type !== "image")
          : cleaned;
      })(),
      ...((result.content ?? []).some((item) => item.type === "image")
        ? { imageEvidence: protection.imageEvidence() }
        : {}),
      isError: result.isError ?? false,
      observationAvailable: protection.observationAvailable(),
      ...(protection.observationAvailable()
        ? {}
        : { observationIssue: protection.observationIssue() }),
      diagnosticDetailAllowed: protection.diagnosticDetailAllowed(),
    };
  }
  async function close() {
    return (closing ??= (async () => {
      producer?.abandon();
      protection?.dispose();
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
    let pendingObservation, imageCaptureToken;
    try {
      if (message.type === "init") {
        captureEpoch = message.captureEpoch;
        protection = makeProtector(message.secrets, captureEpoch ? { captureEpoch } : {});
        if (captureEpoch)
          producer = createCaptureProducer({
            epoch: captureEpoch,
            send: sendCapture,
            sample: () => protection.captureSample(),
          });
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
      } else if (message.type === "close_capture_producer") {
        if (!producer) throw Error("NATIVE_CAPTURE_PRODUCER_UNCONFIRMED");
        const data = await producer.close(message, async (challenge) => {
          await maskReady({ challenge, record: false });
          emitGaps();
        });
        process.send({ id: message.id, ok: true, data });
      } else if (message.type === "policy_ack") {
        if (message.policyGeneration !== protection.policyGeneration)
          throw Error("NATIVE_POLICY_ACK_UNCONFIRMED");
        producer?.resumeSamples();
        process.send({
          id: message.id,
          ok: true,
          data: { policyGeneration: protection.policyGeneration },
        });
      } else if (message.type === "policy") {
        producer?.pauseSamples();
        const previous = protection.policyGeneration;
        protection.updateSecrets(message.secrets);
        await syncDocuments();
        const changed = previous !== protection.policyGeneration;
        if (!changed) producer?.resumeSamples();
        process.send({
          id: message.id,
          ok: true,
          data: { policyGeneration: protection.policyGeneration, policyAckRequired: changed },
        });
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
          const alive = context.pages().filter((page) => !page.isClosed()),
            selected =
              interactions.cachedActivePage() ?? (alive.length === 1 ? alive[0] : undefined);
          imageCaptureToken = protection.beginImageCapture(selected ? pageId(selected) : undefined);
        }
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
        if (tool === "browser_tabs" && !result.isError) interactions.noteTabState(result);
        if (inPlan) {
          await plan.binding.after(message.index);
          plan.next++;
        }
        if (tool === "browser_handle_dialog" && !result.isError) {
          const page = await interactions.activePage();
          for (const [dialog, owner] of dialogs)
            if (owner === page || owner.isClosed()) dialogs.delete(dialog);
        }
        await maskReady({ selectedPage: snapshotPage });
        process.send?.({ type: "phase", phase: "normalize:" + tool });
        const normalized = await normalize(result, tool);
        emitGaps();
        await syncDocuments();
        if (snapshotGuard) {
          if (!result.isError && normalized.observationAvailable && (await snapshotGuard.valid())) {
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
      if (imageCaptureToken !== undefined) protection?.endImageCapture(imageCaptureToken);
      handling = false;
    }
  });
}
