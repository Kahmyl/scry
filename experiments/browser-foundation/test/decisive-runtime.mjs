// Experiment-only shared interaction implementation. No application names,
// framework APIs, CSS editor classes or per-site behavior are permitted here.
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const { createConnection } = require("@playwright/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
export async function privateBrowser() {
  const xvfb = spawn(
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1320x820x24", "-nolisten", "tcp"],
    { stdio: ["ignore", "ignore", "ignore", "pipe"] },
  );
  const display = await new Promise((resolve, reject) => {
    let value = "";
    xvfb.once("error", reject);
    xvfb.once("exit", () => reject(new Error("Display exited")));
    xvfb.stdio[3].on("data", (b) => {
      value += b;
      if (value.includes("\n")) resolve(":" + value.trim());
    });
  });
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox"],
    env: { ...process.env, DISPLAY: display },
  });
  const clipboard = {
    write: (value) =>
      new Promise((resolve, reject) => {
        const child = spawn("xclip", ["-display", display, "-selection", "clipboard", "-in"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("Clipboard write failed")),
        );
        child.stdin.end(value);
      }),
    read: async () =>
      (
        await exec("xclip", ["-display", display, "-selection", "clipboard", "-out"], {
          timeout: 1500,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
  };
  return {
    browser,
    display,
    clipboard,
    close: async () => {
      await browser.close().catch(() => {});
      xvfb.kill("SIGTERM");
    },
  };
}
export async function sharedRuntime(context, clipboard) {
  const server = await createConnection(
    {
      browser: { browserName: "chromium" },
      snapshot: { mode: "none" },
      timeouts: { action: 6000, navigation: 12000, settle: 350, idle: 0 },
    },
    async () => context,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "shared-interaction-experiment", version: "baseline" });
  await client.connect(a);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError)
      throw new Error(
        r.content
          ?.filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n") ?? "Tool error",
      );
    return r;
  };
  await call("browser_snapshot", {});
  const epochs = new WeakMap();
  for (const page of context.pages())
    page.on("framenavigated", (frame) => epochs.set(frame, (epochs.get(frame) ?? 0) + 1));
  const normal = (s) => s.replace(/\r\n/g, "\n");
  async function replace({
    page,
    target,
    text,
    strategy = "native-paste-with-native-copy-readback",
  }) {
    const started = Date.now();
    let dispatched = false,
      handle,
      scopeHandle,
      frame,
      epoch;
    const trace = [];
    const result = (status, reason, extra = {}) => ({
      status,
      reason,
      dispatched,
      elapsedMs: Date.now() - started,
      trace,
      ...extra,
    });
    try {
      const index = context.pages().indexOf(page);
      if (index < 0) return result("not-dispatched", "page_gone");
      await call("browser_tabs", { action: "select", index });
      const locator = page.locator(target);
      if ((await locator.count()) !== 1)
        return result("not-dispatched", "ambiguous_or_missing_target");
      const nativeKeys = strategy === "native-control-keyboard";
      const nativeAll = strategy === "native-control-scope-all" || nativeKeys;
      const scoped = strategy === "native-control-scope" || nativeAll;
      const nativeEditContext = await locator.evaluate(
        (e) =>
          !!e.editContext &&
          e.getAttribute("aria-readonly") !== "true" &&
          e.getAttribute("aria-disabled") !== "true",
      );
      const directControl = await locator.evaluate(
        (e) => e.matches("input,textarea,select") || e.isContentEditable || !!e.editContext,
      );
      if (!directControl || (!nativeEditContext && !(await locator.isEditable()))) {
        if (
          !scoped ||
          !(await locator.evaluate((e) =>
            [
              ...e.querySelectorAll(
                'input,textarea,[contenteditable="true"],[role="textbox"],[tabindex]',
              ),
            ].some(
              (n) =>
                !n.disabled &&
                !n.readOnly &&
                n.getAttribute("aria-readonly") !== "true" &&
                n.getAttribute("aria-disabled") !== "true" &&
                (n.matches("input,textarea") || n.isContentEditable || !!n.editContext),
            ),
          ))
        )
          return result("not-dispatched", "not_editable");
      }
      // Prepare the native clipboard before activation. No helper page/focus hop.
      if (strategy !== "official-fill") await clipboard.write(text);
      await call("browser_click", { target });
      trace.push("native_activation_completed");
      if ((await locator.count()) !== 1)
        return result("not-dispatched", "target_changed_during_activation");
      scopeHandle = await locator.elementHandle();
      handle = scopeHandle;
      if (scoped) {
        const active = await scopeHandle.evaluateHandle((e) => {
          let a = e.ownerDocument.activeElement;
          while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
          return (e === a || e.contains(a)) &&
            (a?.matches("input,textarea") || a?.isContentEditable || a?.editContext)
            ? a
            : null;
        });
        const receiver = active.asElement();
        if (!receiver) {
          await active.dispose();
          return result("not-dispatched", "no_owned_text_receiver");
        }
        handle = receiver;
      }
      frame = await handle.ownerFrame();
      epoch = epochs.get(frame) ?? 0;
      const state = await handle.evaluate((e) => ({
        connected: e.isConnected,
        editable:
          !e.disabled &&
          !e.readOnly &&
          e.getAttribute("aria-readonly") !== "true" &&
          e.getAttribute("aria-disabled") !== "true" &&
          (e.matches("input,textarea") || e.isContentEditable || !!e.editContext),
        focused: (() => {
          let active = e.ownerDocument.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          return e === active || e.contains(active);
        })(),
      }));
      if (!state.connected || !state.editable || !state.focused)
        return result("not-dispatched", "target_not_active");
      if (frame.isDetached() || (epochs.get(frame) ?? 0) !== epoch)
        return result("not-dispatched", "document_changed");
      dispatched = true; // From this point, never try a second input strategy.
      const bounded = strategy === "bounded-range-paste" || scoped;
      const guarded = strategy === "guarded-native-paste" || bounded;
      const verifyFocus = () =>
        handle.evaluate((e) => {
          let a = e.ownerDocument.activeElement;
          while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
          return e.isConnected && (e === a || e.contains(a));
        });
      const select = async () => {
        const contentEditable = await handle.evaluate((e) => e.isContentEditable);
        if (nativeAll) await call("browser_press_key", { key: "ControlOrMeta+A" });
        else if (bounded && contentEditable)
          await handle.evaluate((e) => {
            const doc = e.ownerDocument;
            const walk = doc.createTreeWalker(e, NodeFilter.SHOW_TEXT, {
              acceptNode: (n) =>
                n.textContent.length && n.parentElement.isContentEditable
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT,
            });
            const texts = [];
            let n;
            while ((n = walk.nextNode())) texts.push(n);
            const range = doc.createRange();
            if (texts.length) {
              range.setStart(texts[0], 0);
              const last = texts.at(-1);
              range.setEnd(last, last.textContent.length);
            } else {
              range.selectNodeContents(e);
              range.collapse(true);
            }
            const s = doc.getSelection();
            s.removeAllRanges();
            s.addRange(range);
          });
        else if (guarded && contentEditable) await handle.selectText({ timeout: 2000 });
        else await call("browser_press_key", { key: "ControlOrMeta+A" });
        if (guarded && !(await stillCurrent())) return false;
        if (scoped && contentEditable)
          return await handle.evaluate((e) => {
            const s = e.ownerDocument.getSelection();
            return (
              !!s &&
              s.rangeCount === 1 &&
              (s.getRangeAt(0).commonAncestorContainer === e ||
                e.contains(s.getRangeAt(0).commonAncestorContainer))
            );
          });
        return true;
      };
      const stillCurrent = async () =>
        !frame.isDetached() && (epochs.get(frame) ?? 0) === epoch && (await verifyFocus());
      if (strategy === "official-fill") await call("browser_type", { target, text });
      else {
        if (!(await select()))
          return result("unknown", "focus_or_document_changed_before_text_input");
        if (nativeKeys) {
          await call("browser_press_key", { key: "Backspace" });
          if (!(await stillCurrent()))
            return result("unknown", "focus_or_document_changed_after_clear");
          await page.keyboard.type(text);
        } else if (text === "") await call("browser_press_key", { key: "Backspace" });
        else await call("browser_press_key", { key: "ControlOrMeta+V" });
      }
      trace.push("input_dispatched_once");
      // Readback is an observation, not permission to retry the mutation.
      const readDom = () =>
        handle.evaluate((e) => (e.matches("input,textarea") ? e.value : e.innerText));
      const stillBound = async () =>
        !frame.isDetached() &&
        (epochs.get(frame) ?? 0) === epoch &&
        (await handle.evaluate((e) => e.isConnected));
      if (!(await stillBound()))
        return result("unknown", "document_or_target_changed_after_dispatch");
      let actual;
      if ((strategy !== "native-paste-with-native-copy-readback" && !guarded) || text === "")
        actual = await readDom();
      else {
        // A sentinel is essential: otherwise failed Copy would leave our intended
        // paste text on the clipboard and falsely "verify" the edit.
        const sentinel = "scry-observation-" + randomUUID();
        await clipboard.write(sentinel);
        if (!(await select())) return result("unknown", "focus_or_document_changed_before_copy");
        await call("browser_press_key", { key: "ControlOrMeta+C" });
        actual = await clipboard.read();
        if (actual === sentinel) return result("unverified", "copy_not_available");
        await call("browser_press_key", { key: "ArrowRight" });
      }
      if (!(await stillBound()))
        return result("unknown", "document_or_target_changed_during_readback");
      trace.push("readback_observed");
      return result(
        normal(actual) === normal(text) ? "accepted" : "mismatch",
        "observed_at_return_not_persisted",
        { actual },
      );
    } catch (e) {
      return result(dispatched ? "unknown" : "not-dispatched", String(e.message).slice(0, 1500));
    } finally {
      await handle?.dispose().catch(() => {});
      if (scopeHandle && scopeHandle !== handle) await scopeHandle.dispose().catch(() => {});
    }
  }
  return {
    call,
    replace,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
