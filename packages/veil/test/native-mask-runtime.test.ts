import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { nativeProtectionScript } from "../src/native-protection.js";
import { createNativeAdapterProtector } from "../src/native-adapter-protection.js";
import type { NativeGraphReceipt } from "../src/native-privacy-facts.js";

// This deliberately narrow DOM fixture exercises the browser script in Node's VM.
// It models only the tree, styles, geometry, events, and owned layer used below;
// actual browser paint and pixel coverage require the separate rendering suite.
class TextNode {
  readonly nodeType = 3;
  parentElement: Element | null = null;
  ownerDocument!: FixtureDocument;
  constructor(public textContent: string) {}
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
}
class Element {
  readonly nodeType = 1;
  style = { cssText: "" };
  childNodes: Array<Element | TextNode> = [];
  attributes: Record<string, string> = {};
  popoverOpen = false;
  type = "";
  name = "";
  id = "";
  value = "";
  readOnly = false;
  parentElement: Element | null = null;
  ownerDocument!: FixtureDocument;
  private associatedLabels: Element[] = [];
  constructor(readonly localName = "div") {}
  get children() {
    return this.childNodes.filter((node): node is Element => node.nodeType === 1);
  }
  get isConnected(): boolean {
    return this === this.ownerDocument?.documentElement || !!this.parentElement?.isConnected;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.replaceChildren(...(value ? [new TextNode(value)] : []));
  }
  // Legacy fixtures specified HTMLInputElement.labels directly. Materialize
  // equivalent for-label relationships so the graph discovers actual DOM owners.
  set labels(values: Array<{ textContent: string }>) {
    for (const label of this.associatedLabels) label.remove();
    this.associatedLabels = values.map(({ textContent }) => {
      const label = this.ownerDocument.createElement("label");
      label.setAttribute("for", this.id);
      label.textContent = textContent;
      this.ownerDocument.documentElement.append(label);
      return label;
    });
  }
  showPopover() {
    this.popoverOpen = true;
  }
  hidePopover() {
    this.popoverOpen = false;
  }
  matches(selector: string) {
    return selector === ":popover-open" && this.popoverOpen;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name: string) {
    return Object.hasOwn(this.attributes, name);
  }
  append(...nodes: Array<Element | TextNode>) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      node.ownerDocument = this.ownerDocument;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes: Array<Element | TextNode>) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  getRootNode() {
    return this.ownerDocument;
  }
  contains(other: Element): boolean {
    return other === this || this.children.some((child) => child.contains(other));
  }
  querySelectorAll(selector: string): Element[] {
    if (selector !== "*") throw Error(`Unsupported fixture selector: ${selector}`);
    return this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }
  toJSON(): unknown {
    return { style: this.style, attributes: this.attributes, children: this.children };
  }
}
type FixtureDocument = {
  documentElement: Element;
  createElement: (localName: string) => Element;
  getElementById: (id: string) => Element | null;
};
function harness(script: string, devicePixelRatio = 1, initialPrivateValue = true) {
  const frames: Array<() => void> = [];
  const events = new Map<string, () => void>();
  const shadow = new Element();
  let box = { left: 20, top: 30, right: 220, bottom: 70, width: 200, height: 40 };
  const documentElement = new Element("html");
  const document: FixtureDocument = {
    documentElement,
    createElement(localName) {
      const element = new Element(localName);
      element.ownerDocument = document;
      return Object.assign(element, {
        attachShadow: (options: { mode: string }) => {
          expect(options.mode).toBe("closed");
          // The fixture retains its testing handle; the host exposes no shadowRoot.
          shadow.replaceChildren(); // A new host gets a fresh closed shadow tree.
          shadow.ownerDocument = document;
          shadow.parentElement = element;
          return shadow;
        },
      });
    },
    getElementById: (id) =>
      documentElement.querySelectorAll("*").find((element) => element.id === id) ?? null,
  };
  documentElement.ownerDocument = document;
  const input = document.createElement("input");
  Object.assign(input, {
    value: initialPrivateValue ? "fictional-secret-alpha" : "",
    type: "password",
    name: "password",
    id: "password",
    getClientRects: () => [box],
    getBoundingClientRect: () => box,
  });
  const email = document.createElement("input");
  Object.assign(email, {
    type: "email",
    name: "email",
    id: "email",
    value: "ordinary@example.test",
    getClientRects: () => [box],
    getBoundingClientRect: () => box,
  });
  documentElement.append(input, email);
  const context: Record<string, unknown> = {
    document,
    performance,
    getComputedStyle: (_element: Element, pseudo?: string) => ({
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
      content: pseudo ? "none" : "normal",
      backgroundImage: "none",
      backgroundColor: "rgba(0, 0, 0, 0)",
    }),
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    setTimeout,
    clearTimeout,
    addEventListener: (name: string, listener: (event: { target: unknown }) => void) =>
      events.set(name, () => listener({ target: document })),
    removeEventListener: (name: string) => events.delete(name),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  runInNewContext(script, context);
  const graph = context.__scryNativeGraph as {
    visualReady(): boolean;
    bind(values: string[]): void;
    read(id: number): NativeGraphReceipt;
    dispose(): void;
  };
  const flush = () => {
    for (const frame of frames.splice(0)) frame();
  };
  flush();
  return {
    get root() {
      return shadow.children.find((element) => element.attributes.popover === "manual") ?? shadow;
    },
    shadow,
    dispose: () => graph.dispose(),
    visualReady: () => graph.visualReady(),
    read: async (expression: string): Promise<NativeGraphReceipt> => {
      const result = runInNewContext(expression, context);
      flush();
      flush();
      return await result;
    },
    bind: (value: string) => {
      graph.bind([value]);
      flush();
    },
    facts: (id = 1) => graph.read(id),
    input,
    email,
    events,
    flush,
    move: (next: typeof box) => {
      box = next;
    },
    refresh: () => {
      (context.__scryNativeRefresh as () => void)();
      flush();
    },
  };
}
it.each(["adapter", "recorder"])(
  "keeps public credential display-name values and pixels public in %s",
  (wrapper) => {
    const policy = createNativeAdapterProtector({});
    const view = harness(wrapper === "adapter" ? policy.script : nativeProtectionScript([]));
    Object.assign(view.input, {
      type: "text",
      name: "",
      id: "slot-a",
      value: "ordinary-public-display-name",
      readOnly: true,
      labels: [{ textContent: "Display name for private access credential" }],
    });
    view.refresh();
    expect(view.facts().values).not.toContain(view.input.value);
    expect(view.root.children).toHaveLength(0);
  },
);
it.each(["adapter", "recorder"])(
  "keeps an authoritative short bound protected under a metadata label in %s",
  (wrapper) => {
    const policy = createNativeAdapterProtector({ selected: "on" });
    const view = harness(wrapper === "adapter" ? policy.script : nativeProtectionScript(["on"]));
    Object.assign(view.input, {
      type: "text",
      name: "",
      id: "display-name",
      value: "on",
      labels: [{ textContent: "Display name for private access credential" }],
    });
    view.refresh();
    expect(view.root.children).toHaveLength(1);
  },
);
describe("opaque frosted native masks", () => {
  it.each([
    ["recorder", () => nativeProtectionScript([])],
    ["official adapter", () => createNativeAdapterProtector({}).script],
  ] as const)(
    "uses an opaque base and source-independent decoration in the %s",
    (_name, script) => {
      const view = harness(script());
      expect(view.root.children).toHaveLength(1); // Ordinary email is not a target.
      const mask = view.root.children[0]!;
      expect(mask.style.cssText).toContain("background:#e5e9ed");
      expect(mask.style.cssText).toContain("opacity:1");
      expect(mask.style.cssText).toContain("overflow:hidden");
      expect(mask.style.cssText).toContain("pointer-events:none");
      expect(mask.style.cssText).not.toContain("backdrop-filter");
      expect(mask.children).toHaveLength(1);
      expect(mask.children[0]!.style.cssText).toContain("linear-gradient(");
      expect(mask.children[0]!.style.cssText).not.toContain("filter:");
      expect(mask.children[0]!.style.cssText).toContain("pointer-events:none");
      const appearance = JSON.stringify(mask);
      view.input.value = "different-fictional-secret-with-a-different-length";
      view.refresh();
      expect(JSON.stringify(view.root.children[0])).toBe(appearance);
      expect(appearance).not.toContain("fictional-secret");
    },
  );
  it("retains the same clipping and refresh lifecycle when targets move or empty", () => {
    const view = harness(nativeProtectionScript([]));
    view.move({ left: -10, top: 50, right: 190, bottom: 90, width: 200, height: 40 });
    view.events.get("scroll")!();
    view.flush();
    expect(view.root.children).toHaveLength(1);
    expect(view.root.children[0]!.style.cssText).toContain(
      "left:0px;top:50px;width:190px;height:40px",
    );
    view.input.value = "";
    view.events.get("input")!();
    view.flush();
    expect(view.root.children).toHaveLength(0);
  });
  it("rounds fractional mask bounds outward to device pixels", () => {
    const view = harness(nativeProtectionScript([]), 2);
    view.move({ left: 20.1, top: 30.3, right: 220.2, bottom: 70.7, width: 200.1, height: 40.4 });
    view.refresh();
    expect(view.root.children[0]!.style.cssText).toContain(
      "left:20px;top:30px;width:200.5px;height:41px",
    );
  });
});

it.each([
  ["recorder", () => nativeProtectionScript([])],
  ["adapter", () => createNativeAdapterProtector({}).script],
] as const)(
  "%s preserves post-install authoritative large bound values without learning capacity",
  (_name, script) => {
    const view = harness(script());
    view.input.type = "text";
    view.input.name = "ordinary";
    view.input.id = "ordinary";
    view.input.value = "a".repeat(65536);
    view.bind(view.input.value);
    expect(view.root.children).toHaveLength(1);
    expect(view.facts().text).toBe("complete");
    expect(view.facts().values).not.toContain(view.input.value);
  },
);

it.each(["cc-number", "cc-csc", "cc-exp", "creditCard", "Credit Card", "newpassword"])(
  "preserves %s native pixel recognition in both wrappers",
  (semantic) => {
    for (const script of [nativeProtectionScript([]), createNativeAdapterProtector({}).script]) {
      const view = harness(script);
      view.input.type = "text";
      view.input.name = "ordinary";
      view.input.id = "ordinary";
      view.input.attributes.autocomplete = semantic;
      view.refresh();
      expect(view.root.children).toHaveLength(1);
    }
  },
);
it("bounds cumulative browser-world explicit history and reports capacity without evicting prior protection", () => {
  const view = harness(nativeProtectionScript([]));
  for (let i = 0; i < 1000; i++) view.bind(`fixture-bound-history-${i}`);
  expect(view.facts()).toMatchObject({
    text: "withheld",
    image: { state: "withheld", reason: "native_protection_capacity" },
  });
  view.input.type = "text";
  view.input.name = "ordinary";
  view.input.id = "ordinary";
  view.input.value = "fixture-bound-history-0";
  view.refresh();
  expect(view.root.children).toHaveLength(1);
});

it("marks an omitted associated label as incomplete instead of certifying partial semantic knowledge", () => {
  const view = harness(nativeProtectionScript([]));
  Object.assign(view.input, {
    type: "text",
    name: "ordinary",
    id: "ordinary",
    labels: Array.from({ length: 17 }, (_, i) => ({
      textContent: i === 16 ? "Access token" : "Ordinary field",
    })),
  });
  view.refresh();
  expect(view.facts()).toMatchObject({
    text: "withheld",
    image: { state: "withheld", reason: "native_protection_graph_capacity" },
  });
});
it.each(["checkbox", "radio", "button", "submit", "reset"])(
  "does not learn ordinary %s state/action values from a credential-related caption",
  (type) => {
    const view = harness(nativeProtectionScript([]));
    view.input.type = type;
    view.input.name = "passwordProtection";
    view.input.id = "setting";
    view.input.value = "on";
    view.refresh();
    const facts = view.facts();
    expect(facts.values.includes("on")).toBe(false);
    const policy = createNativeAdapterProtector({}),
      read = policy.beginNativeRead();
    expect(policy.acceptNativeRead(read, facts, { pageId: 0, worldId: 0 })).toBe(true);
    policy.finishNativeRead(read, true);
    expect(policy.clean("Collaboration options connected.")).toBe(
      "Collaboration options connected.",
    );
  },
);
it.each(["text", "password", "hidden", "number"])(
  "retains genuine credential payloads in %s controls without a minimum-length workaround",
  (type) => {
    const view = harness(nativeProtectionScript([]));
    view.input.type = type;
    view.input.name = "serviceCredential";
    view.input.id = "service-credential";
    view.input.value = "on";
    view.refresh();
    expect(view.facts().values.includes("on")).toBe(true);
  },
);
it("retains explicit bound protection for nonpayload controls without automatic caption learning", () => {
  const view = harness(nativeProtectionScript(["on"]));
  view.input.type = "checkbox";
  view.input.name = "ordinarySetting";
  view.input.id = "setting";
  view.input.value = "on";
  view.refresh();
  expect(view.root.children).toHaveLength(1);
  expect(view.facts().values.includes("on")).toBe(false);
});
it("does not let helper metadata override strong shown-password/autofill control evidence", () => {
  const view = harness(nativeProtectionScript([]));
  view.input.type = "text";
  view.input.name = "shown-password";
  view.input.id = "shown-password";
  view.input.value = "fictional-shown-private-value";
  view.input.attributes.autocomplete = "current-password";
  Object.assign(view.input, { labels: [{ textContent: "Password requirements" }] });
  view.refresh();
  expect(view.facts().values.includes(view.input.value)).toBe(true);
  const policy = createNativeAdapterProtector({}),
    read = policy.beginNativeRead();
  expect(policy.acceptNativeRead(read, view.facts(read), { pageId: 0, worldId: 0 })).toBe(true);
  policy.finishNativeRead(read, true);
  expect(
    String(
      policy.clean(`- textbox "Password requirements" [ref=e1]: ${view.input.value}`),
    ).includes(view.input.value),
  ).toBe(false);
});

it("reports a failed owned-layer promotion instead of certifying pixels", async () => {
  const policy = createNativeAdapterProtector({}),
    view = harness(policy.script);
  view.root.showPopover = () => {
    throw Error("fixture rejected owned layer");
  };
  view.refresh();
  expect(view.visualReady()).toBe(false);
  const result = await view.read(policy.readExpression);
  expect(result.text).toBe("complete");
  expect(result).not.toHaveProperty("pixelReady");
  expect(await view.read(policy.pixelExpression)).toMatchObject({
    image: { state: "withheld", reason: "native_protection_refresh_incomplete" },
  });
});
it("keeps an explicitly labelled service credential NAME public despite its generic identifier", () => {
  const view = harness(nativeProtectionScript([]));
  view.input.type = "text";
  view.input.name = "serviceCredential";
  view.input.id = "serviceCredential";
  view.input.value = "ordinary-staging-connector";
  Object.assign(view.input, { labels: [{ textContent: "Service credential name" }] });
  view.refresh();
  expect(view.facts().values.includes(view.input.value)).toBe(false);
  const policy = createNativeAdapterProtector({}),
    read = policy.beginNativeRead();
  expect(policy.acceptNativeRead(read, view.facts(read), { pageId: 0, worldId: 0 })).toBe(true);
  policy.finishNativeRead(read, true);
  expect(
    policy.clean(`- textbox "Service credential name" [ref=e1]: ${view.input.value}`),
  ).toContain(view.input.value);
});
it("does not consume semantic capacity for an ordinary checkbox's long legal caption", () => {
  const view = harness(nativeProtectionScript([]));
  view.input.type = "checkbox";
  view.input.name = "passwordProtection";
  view.input.id = "setting";
  view.input.value = "on";
  Object.assign(view.input, {
    labels: [{ textContent: "ordinary legal description ".repeat(400) }],
  });
  view.refresh();
  expect(view.facts().text).toBe("complete");
  expect(view.facts().values.includes("on")).toBe(false);
});
it.each(["access_token", "api_key", "clientSecret", "authToken", "recoveryCode", "deletionToken"])(
  "retains strong legacy/private identifier %s despite metadata helper text",
  (name) => {
    const view = harness(nativeProtectionScript([]));
    view.input.type = "text";
    view.input.name = name;
    view.input.id = name;
    view.input.value = "fictional-private-identifier-value";
    Object.assign(view.input, { labels: [{ textContent: "Access token requirements" }] });
    view.refresh();
    expect(view.facts().values.includes(view.input.value)).toBe(true);
  },
);

it.each([
  ["recorder", () => nativeProtectionScript([])],
  ["adapter", () => createNativeAdapterProtector({}).script],
] as const)(
  "%s masks a selected bound option at the native select without changing option state",
  async (_name, script) => {
    const view = harness(script()),
      document = view.input.ownerDocument;
    const select = document.createElement("select"),
      option = document.createElement("option");
    const privateValue = "fictional-selected-option-value";
    option.textContent = privateValue;
    Object.assign(option, {
      selected: true,
      defaultSelected: true,
      value: "business-option-id",
      getClientRects: () => [],
      closest: () => select,
    });
    Object.assign(select, {
      multiple: false,
      size: 0,
      value: "business-option-id",
      getClientRects: () => [view.input.getBoundingClientRect()],
      getBoundingClientRect: () => view.input.getBoundingClientRect(),
    });
    select.append(option);
    document.documentElement.append(select);
    view.bind(privateValue);
    const before = JSON.stringify({
      selected: (option as any).selected,
      defaultSelected: (option as any).defaultSelected,
      value: (option as any).value,
      children: select.children.length,
    });
    view.refresh();
    expect(view.root.children).toHaveLength(2);
    expect(view.visualReady()).toBe(true);
    view.facts();
    expect((await view.read("globalThis.__scryNativeGraph.paint(1)")).image.state).toBe(
      "available",
    );
    expect(
      JSON.stringify({
        selected: (option as any).selected,
        defaultSelected: (option as any).defaultSelected,
        value: (option as any).value,
        children: select.children.length,
      }),
    ).toBe(before);
  },
);

it.each([
  ["recorder", () => nativeProtectionScript([])],
  ["adapter", () => createNativeAdapterProtector({}).script],
] as const)(
  "%s excludes closed details contents despite retained layout boxes and keeps its first summary",
  (_name, script) => {
    const view = harness(script()),
      doc = view.input.ownerDocument;
    const create = doc.createElement;
    doc.createElement = (tag) =>
      tag === "canvas" ? Object.assign(create(tag), { getContext: () => ({}) }) : create(tag);
    const details = doc.createElement("details"),
      summary = doc.createElement("summary"),
      payload = doc.createElement("p");
    const value = "fictional-retained-details-value";
    payload.textContent = value;
    Object.assign(payload, { getBoundingClientRect: () => view.input.getBoundingClientRect() });
    details.append(summary, payload);
    doc.documentElement.append(details);
    Object.assign(details, { open: true });
    Object.assign(payload, { checkVisibility: () => !!(details as any).open });
    view.bind(value);
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(1);
    Object.assign(details, { open: false });
    view.refresh();
    expect(payload.getClientRects()).toHaveLength(1); // Native closed details can retain layout boxes.
    expect(view.facts().textCandidateRefs).toHaveLength(0);
    summary.textContent = value;
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(1); // First summary remains AX/paint visible.
    Object.assign(details, { open: true });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(2); // Reopen does not lose retained privacy.
    const second = doc.createElement("summary");
    second.textContent = value;
    Object.assign(second, { checkVisibility: () => !!(details as any).open });
    details.append(second);
    Object.assign(details, { open: false });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(1);
    const nested = doc.createElement("details"),
      nestedSummary = doc.createElement("summary");
    nestedSummary.textContent = value;
    Object.assign(nestedSummary, { checkVisibility: () => !!(details as any).open });
    nested.append(nestedSummary);
    details.append(nested);
    Object.assign(nested, { open: true });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(1);
    Object.assign(details, { open: true });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(4);
    // A shadow descendant follows the composed host chain into the closed details.
    const host = doc.createElement("div"),
      shadowPayload = doc.createElement("p");
    shadowPayload.textContent = value;
    Object.assign(host, { shadowRoot: { childNodes: [shadowPayload] } });
    Object.assign(shadowPayload, {
      getRootNode: () => ({ host }),
      checkVisibility: () => !!(details as any).open,
    });
    details.append(host);
    Object.assign(details, { open: false });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(1);
    Object.assign(payload, { checkVisibility: () => true });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(2); // Author-exposed closed content stays required.
    Object.assign(payload, { checkVisibility: undefined });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(2); // Missing native proof cannot claim hidden.
    Object.assign(payload, {
      checkVisibility: () => {
        throw Error("unavailable");
      },
    });
    view.refresh();
    expect(view.facts().textCandidateRefs).toHaveLength(2);
  },
);

it.each([
  ["recorder", () => nativeProtectionScript([])],
  ["adapter", () => createNativeAdapterProtector({}).script],
] as const)(
  "%s admits a complete zero-mask observation without hiding or promoting an empty layer",
  async (_name, script) => {
    const view = harness(script()),
      oldLayer = view.root;
    let hides = 0;
    oldLayer.hidePopover = () => {
      hides++;
      throw Object.assign(Error("finite fixture"), { name: "InvalidStateError" });
    };
    view.input.value = "";
    view.refresh();
    view.facts();
    const result = await view.read("globalThis.__scryNativeGraph.paint(1)");
    expect(result.image.state).toBe("available");
    expect(result.knownRequirement).toBe("absent_in_supported_snapshot");
    expect(result.text).toBe("complete");
    expect(hides).toBe(0);
    expect(oldLayer.children).toHaveLength(0);
    expect(view.visualReady()).toBe(true);
  },
);

it("retains an observed required-coverage gap after an independent empty-mask observation recovers", async () => {
  const view = harness(nativeProtectionScript([])),
    layer = view.root;
  layer.hidePopover = () => {
    throw Object.assign(Error("finite fixture"), { name: "InvalidStateError" });
  };
  view.refresh();
  view.facts();
  const failed = await view.read("globalThis.__scryNativeGraph.paint(1)");
  expect(failed.image.state).toBe("withheld");
  expect(failed.observedRequiredGap).toBe("native_protection_refresh_incomplete");
  view.input.value = "";
  view.refresh();
  view.facts(2);
  const recovered = await view.read("globalThis.__scryNativeGraph.paint(2)");
  expect(recovered.image.state).toBe("available");
  expect(recovered.observedRequiredGap).toBe("native_protection_refresh_incomplete");
});

it.each([
  ["recorder", () => nativeProtectionScript([])],
  ["adapter", () => createNativeAdapterProtector({}).script],
] as const)(
  "%s handles empty documents, later private paint and disposal without stale layers",
  async (_name, script) => {
    const view = harness(script(), 1, false);
    expect(view.root.children).toHaveLength(0);
    expect(view.visualReady()).toBe(true);
    view.facts();
    expect((await view.read("globalThis.__scryNativeGraph.paint(1)")).image.state).toBe(
      "available",
    );
    view.input.value = "fictional-next-private-value";
    view.refresh();
    expect(view.root.children).toHaveLength(1);
    expect(view.visualReady()).toBe(true);
    view.input.value = "";
    view.refresh();
    expect(view.root.children).toHaveLength(0);
    expect(view.visualReady()).toBe(true);
    view.dispose();
    expect(view.visualReady()).toBe(false);
    expect(() => view.facts()).toThrow("disposed");
  },
);
it("cleans an already detached owned host on a complete empty observation", async () => {
  const view = harness(nativeProtectionScript([])),
    oldLayer = view.root;
  view.shadow.parentElement!.remove();
  view.input.value = "";
  view.refresh();
  view.facts();
  expect((await view.read("globalThis.__scryNativeGraph.paint(1)")).image.state).toBe("available");
  expect(oldLayer.children).toHaveLength(0);
  expect(oldLayer.isConnected).toBe(false);
  view.input.value = "fictional-new-private-value";
  view.refresh();
  expect(view.root.children).toHaveLength(1);
});

it("does not certify empty visual readiness when owned-host cleanup fails", async () => {
  const view = harness(nativeProtectionScript([])),
    host = view.shadow.parentElement!;
  host.remove = () => {
    throw Error("finite cleanup failure");
  };
  view.input.value = "";
  view.refresh();
  view.facts();
  expect((await view.read("globalThis.__scryNativeGraph.paint(1)")).image.state).toBe("withheld");
  expect(view.visualReady()).toBe(false);
});

it("keeps permanent protection failure withheld even when the current graph needs no rectangles", async () => {
  const view = harness(nativeProtectionScript([], { limited: true }), 1, false);
  view.facts();
  const result = await view.read("globalThis.__scryNativeGraph.paint(1)");
  expect(result.text).toBe("withheld");
  expect(result.image).toMatchObject({ state: "withheld", reason: "native_protection_capacity" });
  expect(view.visualReady()).toBe(false);
});
