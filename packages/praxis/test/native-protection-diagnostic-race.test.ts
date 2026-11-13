import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { createNativeAdapterProtector } from "../../veil/src/native-adapter-protection.js";
import { createNativeDiagnosticProtection } from "../../veil/src/native-diagnostic-protection.js";
// @ts-expect-error Private shipped JavaScript transport.
import { refreshNativeProtection } from "../src/mcp-native/protection-refresh.mjs";
// @ts-expect-error Private shipped JavaScript deadline owner.
import { BestEffortTasks } from "../src/mcp-native/best-effort-tasks.mjs";
import { createSessionDenials } from "../src/mcp-native/scope-denials.js";

it("withholds native endpoint detail when a background secret is learned after critical facts", async () => {
  const policy = createNativeAdapterProtector({});
  class Element {
    readonly nodeType = 1;
    constructor(readonly localName = "div") {}
    childNodes: Element[] = [];
    parentElement: Element | null = null;
    get children() {
      return this.childNodes;
    }
    get textContent() {
      return "";
    }
    getRootNode() {
      return context.document;
    }
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }
    hasAttribute(name: string) {
      return Object.hasOwn(this.attributes, name);
    }
    getClientRects() {
      return [];
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    querySelectorAll(): Element[] {
      return this.children.flatMap((child) => [child, ...child.querySelectorAll()]);
    }
    attributes: Record<string, string> = {};
    style = { cssText: "" };
    isConnected = false;
    popoverOpen = false;
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    }
    append(...nodes: Element[]) {
      this.childNodes.push(...nodes);
      for (const node of nodes) {
        node.isConnected = true;
        node.parentElement = this;
      }
    }
    replaceChildren(...nodes: Element[]) {
      this.childNodes = nodes;
    }
    matches(selector: string) {
      return selector === ":popover-open" && this.popoverOpen;
    }
    showPopover() {
      this.popoverOpen = true;
    }
    hidePopover() {
      this.popoverOpen = false;
    }
  }
  const frames: Array<() => void> = [];
  const input = Object.assign(new Element("input"), {
    value: "",
    type: "text",
    name: "access_token",
    id: "access_token",
  });
  const context: any = {
    document: {
      documentElement: new Element("html"),
      querySelectorAll: () => [input],
      createTreeWalker: () => ({ nextNode: () => null }),
      createElement: (tag: string) =>
        Object.assign(new Element(tag), { attachShadow: () => new Element() }),
      addEventListener: () => {},
    },
    performance,
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      transform: "none",
      textShadow: "none",
      filter: "none",
      writingMode: "horizontal-tb",
      textTransform: "none",
      animationName: "none",
      position: "static",
      backdropFilter: "none",
      mixBlendMode: "normal",
      perspective: "none",
      clipPath: "none",
      maskImage: "none",
      content: "none",
    }),
    devicePixelRatio: 1,
    NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: 800,
    innerHeight: 600,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    setTimeout,
    addEventListener: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  context.document.documentElement.append(input);
  runInNewContext(policy.script, context);
  const flush = () => {
    for (const callback of frames.splice(0)) callback();
  };
  flush();
  const secret = "fictional-late-background-value";
  let detailAllowed = false;
  const diagnostics = createNativeDiagnosticProtection({});
  const denials = createSessionDenials({
    clean: (value) => (detailAllowed ? diagnostics.sanitize(value) : undefined),
  });
  let facts = 0,
    paints = 0;
  const session = {
    send: async (name: string, args?: { expression?: string }) => {
      if (name === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (name === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (args?.expression?.includes(".read(")) {
        facts++;
        // CDP returnByValue copies facts; later mutations do not update Node.
        return { result: { value: structuredClone(runInNewContext(args.expression, context)) } };
      }
      paints++;
      // A background document generates a credential after its fact receipt.
      input.value = secret;
      context.__scryNativeRefresh();
      denials.record({ reason: "origin_not_allowed", origin: `https://${secret}.example` });
      const promise = runInNewContext(args!.expression!, context);
      flush();
      flush();
      return { result: { value: await promise } };
    },
  };
  const page = { isClosed: () => false };
  await refreshNativeProtection({
    protection: policy,
    sessions: new Map([[page, session]]),
    dialogs: new Map(),
    pages: [page],
    maskTasks: new BestEffortTasks(() => {}),
    pixelTasks: new BestEffortTasks(() => {}),
    recovered: () => {},
    degrade: () => {},
    phase: () => {},
  });
  // The active public page need not expose the background control in its snapshot.
  policy.cleanTextContent([{ type: "text", text: "Public active page" }], false);
  detailAllowed = policy.diagnosticDetailAllowed();
  const snapshot = denials.snapshot();
  const result = {
    facts,
    paints,
    childHasLearned: context.__scryNativeRead().values.includes(secret),
    nodeDiagnosticDetailAllowed: detailAllowed,
    observationAvailable: policy.observationAvailable(),
    endpointLeaked: JSON.stringify(snapshot).includes(secret),
    denialCount: snapshot.denialCount,
  };
  expect(result).toMatchObject({
    facts: 1,
    paints: 1,
    childHasLearned: true,
    nodeDiagnosticDetailAllowed: false,
    observationAvailable: true,
    endpointLeaked: false,
    denialCount: 1,
  });
  policy.dispose();
});
