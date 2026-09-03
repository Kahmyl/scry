import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  inspectPraxisStructure,
  installPraxisStructurePerception,
  readPraxisPublicStructureValue,
} from "../src/structure-perception.js";
import {
  inspectPraxisRuntimeState,
  installPraxisRuntimeStatePerception,
  readPraxisPublicRuntimeValue,
} from "../src/runtime-state-perception.js";

let browsers: Browser[] = [];
afterEach(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
  browsers = [];
});

async function page() {
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  return browser.newPage();
}

describe("bounded structural and runtime perception", () => {
  it("returns opaque DOM/AX structure metadata and Veil-admitted exact fields without network or mutation", async () => {
    const current = await page();
    let requests = 0;
    current.on("request", () => (requests += 1));
    const stop = installPraxisStructurePerception(current);
    await current.setContent(
      '<main><p>Structural public fact</p><button aria-label="AX-only public fact"></button><span aria-label="client_secret=refused-example-value"></span></main>',
    );
    try {
      const inspection = await inspectPraxisStructure(current);
      const serialized = JSON.stringify(inspection);
      expect(serialized).not.toContain("Structural public fact");
      expect(serialized).not.toContain("AX-only public fact");
      expect(serialized).not.toMatch(/nodeId|backendNodeId|objectId/);
      const values = await Promise.all(
        inspection.structures.flatMap((entry) =>
          entry.readableFields.map(async (field) =>
            readPraxisPublicStructureValue(current, { reference: entry.reference, field }).catch(
              () => undefined,
            ),
          ),
        ),
      );
      expect(values.some((value) => value?.text === "Structural public fact")).toBe(true);
      expect(values.some((value) => value?.text === "AX-only public fact")).toBe(true);
      expect(values.some((value) => value?.text.includes("refused-example"))).toBe(false);
      expect(requests).toBe(0);
      const reference = inspection.structures[0]!.reference;
      await current.goto("data:text/html,next");
      await expect(
        readPraxisPublicStructureValue(current, {
          reference,
          field: inspection.structures[0]!.readableFields[0]!,
        }),
      ).rejects.toMatchObject({ code: "PUBLIC_STRUCTURE_REFERENCE_UNKNOWN" });
    } finally {
      stop();
    }
  });

  it("excludes inherited inaccessible, redacted, editable, and protected-form structure boundaries", async () => {
    const current = await page();
    const stop = installPraxisStructurePerception(current);
    const excluded = [
      "STRUCTURE_HIDDEN_LEAF",
      "STRUCTURE_HIDDEN_ANCESTOR",
      "STRUCTURE_INERT_ANCESTOR",
      "STRUCTURE_ARIA_HIDDEN",
      "STRUCTURE_REDACTED_ANCESTOR",
      "STRUCTURE_CONTENTEDITABLE",
      "STRUCTURE_PROTECTED_FORM",
      "STRUCTURE_TEXTAREA",
      "STRUCTURE_SELECT",
    ];
    await current.setContent(`
      <main>
        <p>STRUCTURE_VISIBLE_PUBLIC</p>
        <div hidden>STRUCTURE_HIDDEN_LEAF</div>
        <div hidden><span>STRUCTURE_HIDDEN_ANCESTOR</span></div>
        <div inert><span>STRUCTURE_INERT_ANCESTOR</span></div>
        <div aria-hidden="true" aria-label="STRUCTURE_ARIA_HIDDEN">STRUCTURE_ARIA_HIDDEN</div>
        <section data-scry-redacted="true"><span>STRUCTURE_REDACTED_ANCESTOR</span></section>
        <div contenteditable="true">STRUCTURE_CONTENTEDITABLE</div>
        <form><input type="password" /><p>STRUCTURE_PROTECTED_FORM</p></form>
        <textarea>STRUCTURE_TEXTAREA</textarea>
        <select><option>STRUCTURE_SELECT</option></select>
      </main>
    `);
    try {
      const inspection = await inspectPraxisStructure(current);
      const serializedInspection = JSON.stringify(inspection);
      for (const text of excluded) expect(serializedInspection).not.toContain(text);
      const reads = await Promise.all(
        inspection.structures.flatMap((entry) =>
          entry.readableFields.map((field) =>
            readPraxisPublicStructureValue(current, {
              reference: entry.reference,
              field,
            }).catch(() => undefined),
          ),
        ),
      );
      expect(reads.some((value) => value?.text === "STRUCTURE_VISIBLE_PUBLIC")).toBe(true);
      for (const text of excluded)
        expect(reads.some((value) => value?.text.includes(text))).toBe(false);
    } finally {
      stop();
    }
  });

  it("rejects ignored accessibility candidates before reference creation", async () => {
    const current = await page();
    const stop = installPraxisStructurePerception(current);
    await current.setContent("<main><p>STRUCTURE_AX_CONTROL_PUBLIC</p></main>");
    const context = current.context();
    const newSession = context.newCDPSession.bind(context);
    const cdp = await newSession(current);
    const send = cdp.send.bind(cdp);
    const sessionSpy = vi.spyOn(context, "newCDPSession").mockResolvedValue({
      send: async (method: string, input: unknown) =>
        method === "Accessibility.getFullAXTree"
          ? {
              nodes: [
                {
                  ignored: true,
                  role: { value: "text" },
                  name: { value: "STRUCTURE_IGNORED_AX" },
                  childIds: [],
                },
              ],
            }
          : send(method as never, input as never),
      detach: () => cdp.detach(),
    } as never);
    try {
      const inspection = await inspectPraxisStructure(current);
      expect(JSON.stringify(inspection)).not.toContain("STRUCTURE_IGNORED_AX");
      const reads = await Promise.all(
        inspection.structures.flatMap((entry) =>
          entry.readableFields.map((field) =>
            readPraxisPublicStructureValue(current, {
              reference: entry.reference,
              field,
            }),
          ),
        ),
      );
      expect(reads.some((value) => value.text === "STRUCTURE_AX_CONTROL_PUBLIC")).toBe(true);
      expect(reads.some((value) => value.text === "STRUCTURE_IGNORED_AX")).toBe(false);
    } finally {
      sessionSpy.mockRestore();
      stop();
    }
  });

  it("keeps structure main-frame scoped and reports bounded truncation", async () => {
    const current = await page();
    const stop = installPraxisStructurePerception(current);
    const deepStructure = `${"<div>".repeat(140)}<span>deep-main-frame-fact</span>${"</div>".repeat(140)}`;
    await current.setContent(
      `<main>${deepStructure}${Array.from({ length: 180 }, (_, index) => `<p>main-${index}</p>`).join("")}</main><iframe srcdoc="<p>iframe-only-fact</p>"></iframe>`,
    );
    try {
      const inspection = await inspectPraxisStructure(current);
      expect(inspection.structures).toHaveLength(32);
      expect(inspection.completeness.observed).toBeGreaterThan(128);
      expect(inspection.completeness).toMatchObject({ returned: 32, truncated: true });
      expect(inspection.structures.every(({ depth }) => depth <= 128)).toBe(true);
      const reads = await Promise.all(
        inspection.structures.flatMap((entry) =>
          entry.readableFields.map((field) =>
            readPraxisPublicStructureValue(current, { reference: entry.reference, field }),
          ),
        ),
      );
      expect(reads.some((value) => value.text.includes("iframe-only-fact"))).toBe(false);
    } finally {
      stop();
    }
  });

  it("includes open shadow-root text when Chromium DOMSnapshot provides it", async () => {
    const current = await page();
    const stop = installPraxisStructurePerception(current);
    await current.setContent(
      '<div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML="<span>shadow structural fact</span>"</script>',
    );
    try {
      const inspection = await inspectPraxisStructure(current);
      const reads = await Promise.all(
        inspection.structures.flatMap((entry) =>
          entry.readableFields.map((field) =>
            readPraxisPublicStructureValue(current, { reference: entry.reference, field }).catch(
              () => undefined,
            ),
          ),
        ),
      );
      expect(reads.some((value) => value?.text === "shadow structural fact")).toBe(true);
    } finally {
      stop();
    }
  });

  it("admits only page-owned JSON-like runtime data without invoking getters or host objects", async () => {
    const current = await page();
    const stop = await installPraxisRuntimeStatePerception(current);
    await current.setContent(
      '<div id="node"></div><script>window.appState={nested:["public",{value:"<EXAMPLE_ACCESS_TOKEN>"}]};window.secretState={client_secret:"refused-example-value"};window.hostState=document.querySelector("#node");window.sideEffects=0;Object.defineProperty(window,"getterState",{get(){window.sideEffects++;return "bad"}});window.functionState=()=>"bad";</script>',
    );
    try {
      const inspection = await inspectPraxisRuntimeState(current);
      expect(JSON.stringify(inspection)).not.toContain("appState");
      expect(JSON.stringify(inspection)).not.toContain("public");
      expect(inspection.values.length).toBeLessThanOrEqual(16);
      const reads = await Promise.all(
        inspection.values.map((entry) =>
          readPraxisPublicRuntimeValue(current, { reference: entry.reference }).catch(
            () => undefined,
          ),
        ),
      );
      expect(reads.some((value) => value?.text.includes("EXAMPLE_ACCESS_TOKEN"))).toBe(true);
      expect(reads.some((value) => value?.text.includes("refused-example"))).toBe(false);
      expect(await current.evaluate(() => (window as any).sideEffects)).toBe(0);
      const reference = inspection.values[0]!.reference;
      await current.goto("data:text/html,next");
      await expect(readPraxisPublicRuntimeValue(current, { reference })).rejects.toMatchObject({
        code: "PUBLIC_RUNTIME_REFERENCE_UNKNOWN",
      });
    } finally {
      stop();
    }
  });

  it("fails closed for deep, wide, oversized, inherited, symbol, accessor, and executable runtime state", async () => {
    const current = await page();
    const stop = await installPraxisRuntimeStatePerception(current);
    await current.setContent(`<script>
      window.runtimeMutations=0;
      const inherited={inherited:"inherited-marker"}; window.inheritedState=Object.assign(Object.create(inherited),{own:"own-marker"});
      window.symbolState={visible:"visible-marker",[Symbol("hidden")]:"symbol-marker"};
      window.deepState={a:{b:{c:{d:{e:"deep-marker"}}}}};
      window.wideState=Object.fromEntries(Array.from({length:513},(_,i)=>["k"+i,i]));
      window.oversizedState={value:"x".repeat(524289)};
      Object.defineProperty(window,"setterState",{set(value){window.runtimeMutations++}});
      window.methodState={method(){window.runtimeMutations++;}};
    </script>`);
    try {
      const inspection = await inspectPraxisRuntimeState(current);
      const reads = await Promise.all(
        inspection.values.map((entry) =>
          readPraxisPublicRuntimeValue(current, { reference: entry.reference }).catch(
            () => undefined,
          ),
        ),
      );
      const text = reads.map((value) => value?.text ?? "").join("\n");
      expect(text).toContain("own-marker");
      expect(text).toContain("visible-marker");
      expect(text).not.toMatch(/inherited-marker|symbol-marker|deep-marker/);
      expect(inspection.completeness.truncated).toBe(true);
      expect(await current.evaluate(() => (window as any).runtimeMutations)).toBe(0);
    } finally {
      stop();
    }
  });

  it("fails closed without invoking a page-authored globalThis getter", async () => {
    const current = await page();
    let getterExecutions = 0;
    current.on("console", (message) => {
      if (message.text() === "GLOBALTHIS_GETTER_EXECUTED") getterExecutions += 1;
    });
    const stop = await installPraxisRuntimeStatePerception(current);
    await current.setContent(`<script>
      window.safeState={fact:"must-not-be-observed-through-poisoned-authority"};
      Object.defineProperty(window,"globalThis",{get(){console.log("GLOBALTHIS_GETTER_EXECUTED");return window}});
    </script>`);
    try {
      const getterExecutionsBeforeInspection = getterExecutions;
      const inspection = await inspectPraxisRuntimeState(current);
      expect(inspection.values).toEqual([]);
      expect(getterExecutions).toBe(getterExecutionsBeforeInspection);
    } finally {
      stop();
    }
  });

  it("caps top-level runtime candidates and references truthfully", async () => {
    const current = await page();
    const stop = await installPraxisRuntimeStatePerception(current);
    await current.setContent(
      `<script>${Array.from({ length: 40 }, (_, index) => `window["bounded${index}"]=${index};`).join("")}</script>`,
    );
    try {
      const inspection = await inspectPraxisRuntimeState(current);
      expect(inspection.values).toHaveLength(16);
      expect(inspection.completeness.observed).toBeGreaterThanOrEqual(40);
      expect(inspection.completeness).toMatchObject({ returned: 16, truncated: true });
    } finally {
      stop();
    }
  });
});
