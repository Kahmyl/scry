import { chromium } from "playwright-mcp-runtime";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, realpath, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import { BestEffortTasks } from "./best-effort-tasks.mjs";
import { displayLayout } from "./display-layout.mjs";
import { NativeInteractions, privateClipboard } from "./native-interactions.mjs";
import { editBrowserTextSchema, screenshotPresentationSchema } from "@scry/contracts";
export function startBrowserAdapter(makeProtector) {
  let browser, context, client, upstream, protection, output, closing, validators, interactions;
  let handling = false;
  const sessions = new Map();
  const dialogs = new Set();
  const maskingWarning = () => process.send?.({ type: "masking", state: "best_effort_partial" });
  const maskTasks = new BestEffortTasks(maskingWarning);
  async function install(page) {
    page.on("dialog", (dialog) => dialogs.add(dialog));
    const session = await context.newCDPSession(page);
    sessions.set(page, session);
    page.once("close", () => {
      sessions.delete(page);
      maskTasks.forget(page);
    });
    page.once("crash", () => {
      sessions.delete(page);
      maskTasks.forget(page);
      dialogs.clear();
      process.send?.({ type: "browserEvent", event: "page_crashed" });
    });
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
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
    if (dialogs.size) return;
    await maskTasks.run(
      [...sessions]
        .filter(([page]) => !page.isClosed())
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
            await session.send("Runtime.evaluate", {
              contextId: world.executionContextId,
              expression:
                "new Promise(r=>{globalThis.__scryNativeRefresh?.();requestAnimationFrame(()=>requestAnimationFrame(r));setTimeout(r,100);})",
              awaitPromise: true,
            });
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
    try {
      if (message.type === "init") {
        protection = makeProtector(message.secrets);
        output = message.output;
        await mkdir(output, { recursive: true, mode: 0o700 });
        // The existing independent platform custodian owns the exact browser.
        // This worker has only its private connection, never ownership authority.
        browser = await chromium.connect(message.endpoint);
        context = await browser.newContext({
          viewport: displayLayout.viewport,
          acceptDownloads: false,
        });
        context.on(
          "page",
          (page) =>
            void install(page).catch(() =>
              process.send?.({ type: "masking", state: "best_effort_partial" }),
            ),
        );
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
          [...sessions.values()].map((session) =>
            session
              .send("Page.addScriptToEvaluateOnNewDocument", {
                source: protection.script,
                worldName: "scry-native-protection",
                runImmediately: true,
              })
              .catch(maskingWarning),
          ),
        );
        process.send({ id: message.id, ok: true });
      } else if (message.type === "call") {
        const args = { ...message.args };
        if (message.tool === "browser_edit_text") editBrowserTextSchema.parse(args);
        const evidence = {};
        if (message.tool === "browser_take_screenshot") {
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
        if (message.tool !== "browser_edit_text" && !validators.get(message.tool)?.(args))
          throw new Error("INVALID_TOOL_ARGUMENTS");
        await maskReady();
        process.send?.({ type: "phase", phase: "upstream:" + message.tool });
        if (message.tool === "browser_drag" && /^(f\d+)?e\d+$/.test(args.startTarget)) {
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
          message.tool === "browser_edit_text"
            ? await interactions.edit(args)
            : await client.callTool({ name: message.tool, arguments: args });
        if (message.tool === "browser_handle_dialog") dialogs.clear();
        await maskReady();
        process.send?.({ type: "phase", phase: "normalize:" + message.tool });
        const normalized = await normalize(result);
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
          }[error?.message] ?? "ADAPTER_CALL_FAILED",
      });
    } finally {
      handling = false;
    }
  });
}
