import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);

/** One private X display per browser incarnation. No host clipboard or tab hop. */
export function privateClipboard(display) {
  if (typeof display !== "string" || !/^:\d+$/.test(display)) throw Error("CLIPBOARD_UNAVAILABLE");
  return {
    write: (value) =>
      new Promise((resolve, reject) => {
        const child = spawn("xclip", ["-display", display, "-selection", "clipboard", "-in"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("CLIPBOARD_UNAVAILABLE"));
        }, 1500);
        child.once("error", () => {
          clearTimeout(timer);
          reject(Error("CLIPBOARD_UNAVAILABLE"));
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(Error("CLIPBOARD_UNAVAILABLE"));
        });
        child.stdin.on("error", () => {});
        child.stdin.end(value);
      }),
    read: async () => {
      try {
        return (
          await exec("xclip", ["-display", display, "-selection", "clipboard", "-out"], {
            timeout: 1500,
            maxBuffer: 256 * 1024,
          })
        ).stdout;
      } catch {
        throw Error("CLIPBOARD_UNAVAILABLE");
      }
    },
  };
}

export class NativeInteractions {
  #epochs = new WeakMap();
  constructor(context, call, clipboard) {
    this.context = context;
    this.call = call;
    this.clipboard = clipboard;
    const install = (page) =>
      page.on("framenavigated", (frame) =>
        this.#epochs.set(frame, (this.#epochs.get(frame) ?? 0) + 1),
      );
    context.pages().forEach(install);
    context.on("page", install);
  }
  async activePage() {
    const result = await this.call("browser_tabs", { action: "list" });
    const text =
      result.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "";
    const matches = [...text.matchAll(/^- (\d+): \(current\)/gm)];
    if (matches.length !== 1) throw Error("REFERENCE_UNAVAILABLE");
    const page = this.context.pages()[Number(matches[0][1])];
    if (!page || page.isClosed()) throw Error("REFERENCE_UNAVAILABLE");
    return page;
  }
  async bind(page, target) {
    // Same native resolver engine as the pinned official MCP; no ref registry.
    if (!/^(f\d+)?e\d+$/.test(target)) throw Error("REFERENCE_UNAVAILABLE");
    const locator = page.locator("aria-ref=" + target),
      handle = await locator.elementHandle({ timeout: 1500 });
    if (!handle) throw Error("REFERENCE_UNAVAILABLE");
    const frame = await handle.ownerFrame();
    if (!frame) {
      await handle.dispose();
      throw Error("REFERENCE_UNAVAILABLE");
    }
    const epoch = this.#epochs.get(frame) ?? 0;
    return {
      locator,
      handle,
      frame,
      valid: async () =>
        !page.isClosed() &&
        !frame.isDetached() &&
        (this.#epochs.get(frame) ?? 0) === epoch &&
        (await handle.evaluate((e) => e.isConnected).catch(() => false)),
    };
  }
  async preparePointer(locator) {
    // Native hover can itself change layout. Reconfirm the actual target point;
    // no force-click, synthetic event or application-specific selector is used.
    const start = Date.now();
    for (let n = 0; n < 3 && Date.now() - start < 2000; n++) {
      await locator.hover({ timeout: Math.max(1, 2000 - (Date.now() - start)) });
      let timer;
      const state = await Promise.race([
        locator.evaluate(async (e) => {
          const rect = () => {
            const r = e.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          };
          const a = rect();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const b = rect(),
            hit = e.getRootNode().elementFromPoint?.(b[0] + b[2] / 2, b[1] + b[3] / 2);
          return (
            e.isConnected &&
            a.every((v, i) => Math.abs(v - b[i]) < 0.5) &&
            (hit === e || e.contains(hit))
          );
        }),
        new Promise(
          (r) => (timer = setTimeout(() => r(false), Math.max(1, 2000 - (Date.now() - start)))),
        ),
      ]);
      clearTimeout(timer);
      if (state) return true;
    }
    return false;
  }
  async edit({ target, text, intent, method }) {
    let binding,
      receiver,
      phase = "not_started";
    const result = (status, reason) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status,
            reason,
            intent,
            method,
            inputState: phase,
            meaning:
              "Input observation only; verify the application and saved state separately. No automatic retry was performed.",
          }),
        },
      ],
      isError: ["unknown", "mismatch", "not_dispatched"].includes(status),
      interaction: { status, reason, intent, method, inputState: phase },
    });
    try {
      const page = await this.activePage();
      binding = await this.bind(page, target);
      const eligible = await binding.handle.evaluate((e) =>
        [
          e,
          ...e.querySelectorAll("input,textarea,[contenteditable=true],[role=textbox],[tabindex]"),
        ].some(
          (n) =>
            !n.disabled &&
            !n.readOnly &&
            n.getAttribute("aria-readonly") !== "true" &&
            n.getAttribute("aria-disabled") !== "true" &&
            (n.matches("input,textarea") || n.isContentEditable || !!n.editContext),
        ),
      );
      if (!eligible) return result("not_dispatched", "target_not_editable");
      if (method === "paste") await this.clipboard.write(text);
      phase = "activation_only";
      await this.call("browser_click", { target });
      if (!(await binding.valid())) return result("unknown", "target_changed_during_activation");
      const active = await binding.handle.evaluateHandle((e) => {
        let a = e.ownerDocument.activeElement;
        while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
        return (a === e || e.contains(a)) &&
          (a.matches("input,textarea") || a.isContentEditable || a.editContext)
          ? a
          : null;
      });
      receiver = active.asElement();
      if (!receiver) {
        await active.dispose();
        return result("unknown", "no_owned_text_receiver");
      }
      const focused = async () =>
        (await this.activePage()) === page &&
        (await binding.valid()) &&
        (await receiver
          .evaluate((e) => {
            let a = e.ownerDocument.activeElement;
            while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
            return (
              e.isConnected &&
              a === e &&
              !e.disabled &&
              !e.readOnly &&
              e.getAttribute("aria-readonly") !== "true" &&
              e.getAttribute("aria-disabled") !== "true" &&
              (e.matches("input,textarea") || e.isContentEditable || !!e.editContext)
            );
          })
          .catch(() => false));
      const native = await receiver.evaluate((e) => e.matches("input,textarea"));
      const before = native
        ? await receiver.evaluate((e) => ({
            value: e.value,
            start: e.selectionStart,
            end: e.selectionEnd,
          }))
        : null;
      const select = async () => {
        if (!(await focused())) return false;
        const ce = await receiver.evaluate((e) => e.isContentEditable);
        if (method === "paste" && ce)
          await receiver.evaluate((e) => {
            const d = e.ownerDocument,
              w = d.createTreeWalker(e, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) =>
                  n.textContent.length && n.parentElement.isContentEditable
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT,
              }),
              nodes = [];
            let n;
            while ((n = w.nextNode())) nodes.push(n);
            const r = d.createRange();
            if (nodes.length) {
              r.setStart(nodes[0], 0);
              const last = nodes.at(-1);
              r.setEnd(last, last.textContent.length);
            } else {
              r.selectNodeContents(e);
              r.collapse(true);
            }
            const s = d.getSelection();
            s.removeAllRanges();
            s.addRange(r);
          });
        else await this.call("browser_press_key", { key: "ControlOrMeta+A" });
        if (!(await focused())) return false;
        if (ce)
          return await receiver.evaluate((e) => {
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
      if (!(await focused())) return result("unknown", "focus_changed_before_input");
      phase = "text_started"; // Selection shortcuts can invoke app handlers too.
      if (intent === "replace" && !(await select()))
        return result("unknown", "focus_changed_during_selection");
      if (method === "keyboard") {
        if (intent === "replace") {
          await this.call("browser_press_key", { key: "Backspace" });
          if (!(await focused())) return result("unknown", "focus_changed_after_clear");
        }
        await page.keyboard.type(text);
      } else if (text.length) await this.call("browser_press_key", { key: "ControlOrMeta+V" });
      else if (intent === "replace") await this.call("browser_press_key", { key: "Backspace" });
      if (!(await focused())) return result("unknown", "target_changed_after_input");
      let actual, expected;
      if (intent === "insert") {
        if (!before || before.start === null || before.end === null)
          return result("unverified", "insertion_sent_inspect_current_state");
        expected = before.value.slice(0, before.start) + text + before.value.slice(before.end);
        actual = await receiver.evaluate((e) => e.value);
      } else {
        expected = text;
        if (text === "")
          actual = await receiver.evaluate((e) =>
            e.matches("input,textarea") ? e.value : e.innerText,
          );
        else {
          const sentinel = "scry-readback-" + randomUUID();
          await this.clipboard.write(sentinel);
          if (!(await select())) return result("unknown", "focus_changed_before_readback");
          await this.call("browser_press_key", { key: "ControlOrMeta+C" });
          if (!(await focused())) return result("unknown", "focus_changed_during_readback");
          actual = await this.clipboard.read();
          if (actual === sentinel) return result("unverified", "copy_unavailable");
          await this.call("browser_press_key", { key: "ArrowRight" });
        }
      }
      if (!(await focused())) return result("unknown", "target_changed_during_readback");
      return result(
        actual.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n") ? "observed" : "mismatch",
        "observed_at_return_not_persisted",
      );
    } catch {
      return result(
        phase === "not_started" ? "not_dispatched" : "unknown",
        phase === "not_started"
          ? "reference_or_preparation_unavailable"
          : "input_or_observation_unavailable",
      );
    } finally {
      await receiver?.dispose().catch(() => {});
      await binding?.handle.dispose().catch(() => {});
    }
  }
}
