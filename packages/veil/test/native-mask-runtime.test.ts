import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { nativeProtectionScript } from "../src/native-protection.js";
import { createNativeAdapterProtector } from "../src/native-adapter-protection.js";

class Element {
  style = { cssText: "" };
  children: Element[] = [];
  isConnected = false;
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
    for (const node of nodes) node.isConnected = true;
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
}
function harness(script: string, devicePixelRatio = 1) {
  const frames: Array<() => void> = [];
  const events = new Map<string, () => void>();
  const root = new Element();
  let box = { left: 20, top: 30, right: 220, bottom: 70, width: 200, height: 40 };
  const input = {
    value: "fictional-secret-alpha",
    type: "password",
    name: "password",
    id: "password",
    getAttribute: () => "",
    hasAttribute: () => false,
    getClientRects: () => [box],
    getBoundingClientRect: () => box,
  };
  const email = {
    ...input,
    type: "email",
    name: "email",
    id: "email",
    value: "ordinary@example.test",
  };
  const documentElement = new Element();
  const context: Record<string, unknown> = {
    document: {
      documentElement,
      querySelectorAll: () => [input, email],
      createTreeWalker: () => ({ nextNode: () => null }),
      createElement: () =>
        Object.assign(new Element(), {
          attachShadow: (options: { mode: string }) => {
            expect(options.mode).toBe("closed");
            return root;
          },
        }),
      addEventListener: (name: string, listener: () => void) => events.set(name, listener),
    },
    NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    addEventListener: (name: string, listener: () => void) => events.set(name, listener),
    MutationObserver: class {
      observe() {}
    },
  };
  runInNewContext(script, context);
  const flush = () => {
    for (const frame of frames.splice(0)) frame();
  };
  flush();
  return {
    root,
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
      expect(mask.children[0]!.style.cssText).toContain("filter:blur(7px)");
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
