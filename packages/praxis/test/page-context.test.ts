import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InteractionTargetIntent } from "@scry/contracts";
import { resolveTarget } from "../src/grounding.js";
import {
  observeSemanticPageContext,
  observeSemanticPageContextReferenceState,
  observeOperationContracts,
} from "../src/page-context.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

describe("bounded semantic page context", () => {
  it("represents several stable facts in one privacy-safe authoritative observation", async () => {
    await page.setContent(`
      <title>Developer</title>
      <main>
        <h1>Developer</h1>
        <section aria-label="Environment">
          <button role="tab" aria-selected="true">Test mode</button>
          <button role="tab" aria-selected="false">Live mode</button>
          <button aria-pressed="true">Sandbox enabled</button>
          <button aria-pressed="false">Production enabled</button>
        </section>
        <section aria-label="Applications">
          <h2>Existing application</h2>
          <button>Manage credentials</button>
          <a href="/docs">Developer documentation</a>
          <label>API secret <input type="password" value="must-not-leak" /></label>
        </section>
      </main>
    `);

    const before = performance.now();
    const context = await observeSemanticPageContext(page);
    const elapsedMs = performance.now() - before;
    const serialized = JSON.stringify(context);

    expect(context.authority).toMatchObject({ title: "Developer", readiness: "stable" });
    expect(context.completeness).toMatchObject({ kind: "bounded", truncated: false });
    expect(context.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "heading", name: "Developer" }),
        expect.objectContaining({ role: "tab", name: "Test mode", selected: true }),
        expect.objectContaining({ role: "tab", name: "Live mode", selected: false }),
        expect.objectContaining({ role: "button", name: "Sandbox enabled", pressed: true }),
        expect.objectContaining({ role: "button", name: "Production enabled", pressed: false }),
        expect.objectContaining({ role: "button", name: "Manage credentials" }),
        expect.objectContaining({ role: "link", name: "Developer documentation" }),
      ]),
    );
    expect(context.controls.find((control) => control.name === "API secret")).toMatchObject({
      capabilities: expect.arrayContaining(["enter_text"]),
      inputSources: ["protected_reference"],
      valueProtected: true,
    });
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized.length).toBeLessThan(16_384);
    expect(elapsedMs).toBeLessThan(3_000);

    const oldEpoch = context.authority.documentEpoch;
    await page.getByRole("tab", { name: "Live mode" }).evaluate((element) => {
      element.setAttribute("aria-selected", "true");
    });
    const changed = await observeSemanticPageContext(page);
    expect(changed.authority.documentEpoch).toBeGreaterThan(oldEpoch);
    expect(changed.controls).toContainEqual(
      expect.objectContaining({ role: "tab", name: "Live mode", selected: true }),
    );
  });

  it("advertises literal input for ordinary text and returns bounded public documentation sections", async () => {
    await page.setContent(`
      <main>
        <label>Credential name <input aria-label="Credential name"></label>
        <h2>Create Order</h2>
        <p>POST /orders</p>
        <p>Requires the customerId field.</p>
        <div>Public fact <span data-scry-redacted="true">must-not-leak</span></div>
        <h2 data-scry-redacted="true">Private notes</h2>
      </main>
    `);
    const context = await observeSemanticPageContext(page);
    expect(context.controls.find((control) => control.name === "Credential name")).toMatchObject({
      capabilities: expect.arrayContaining(["enter_text"]),
      inputSources: ["literal", "protected_reference"],
    });
    expect(context.sections).toContainEqual({
      heading: "Create Order",
      content: "POST /orders Requires the customerId field. Public fact",
    });
    expect(JSON.stringify(context)).not.toContain("must-not-leak");
    expect(context.sectionCompleteness).toEqual({
      kind: "bounded",
      observed: 2,
      returned: 1,
      truncated: true,
    });
  });

  it("reports bounded incompleteness instead of claiming a complete large surface", async () => {
    await page.setContent(
      `<main>${Array.from({ length: 80 }, (_, index) => `<button>Action ${index}</button>`).join(
        "",
      )}</main>`,
    );
    const context = await observeSemanticPageContext(page);
    expect(context.controls).toHaveLength(48);
    expect(context.completeness).toMatchObject({ observed: 80, returned: 48, truncated: true });
  });

  it("preserves distinct actionable identity for multiple protected controls without values", async () => {
    await page.setContent(`
      <form aria-label="Change password">
        <label>Current password <input type="password" autocomplete="current-password" value="old-secret" /></label>
        <label>New password <input type="password" autocomplete="new-password" value="new-secret" /></label>
        <label>Confirm password <input type="password" autocomplete="new-password" value="new-secret" /></label>
      </form>
    `);

    const context = await observeSemanticPageContext(page);
    const protectedControls = context.controls.filter((control) => control.role === "textbox");
    const serialized = JSON.stringify(context);

    expect(protectedControls).toHaveLength(3);
    expect(new Set(protectedControls.map((control) => control.reference)).size).toBe(3);
    expect(serialized).not.toContain("old-secret");
    expect(serialized).not.toContain("new-secret");
  });

  it("projects privacy-safe structural identity for repeated protected rows", async () => {
    await page.setContent(`
      <main data-private="must-not-project">
        <div role="row"><span data-scry-redacted="true">credential-secret-a</span><button>Rotate</button><button>Revoke</button></div>
        <div role="row"><span data-scry-redacted="true">credential-secret-b</span><button>Rotate</button><button>Revoke</button></div>
        <div role="row" style="display:none"><span>decoy</span><button>Rotate</button></div>
      </main>
    `);
    const context = await observeSemanticPageContext(page);
    const rotate = context.controls.filter((control) => control.name === "Rotate");
    expect(context.schemaVersion).toBe(2);
    expect(rotate).toHaveLength(2);
    expect(rotate[0]!.containerReferences).toHaveLength(1);
    expect(rotate[1]!.containerReferences).toHaveLength(1);
    expect(rotate[0]!.containerReferences![0]).not.toBe(rotate[1]!.containerReferences![0]);
    for (const control of rotate) {
      const container = context.containers.find(
        (candidate) => candidate.reference === control.containerReferences![0],
      );
      expect(container).toMatchObject({ kind: "row" });
      expect(container!.controlReferences).toEqual(
        expect.arrayContaining([
          control.reference,
          context.controls.find(
            (candidate) =>
              candidate.name === "Revoke" &&
              candidate.containerReferences?.[0] === container!.reference,
          )!.reference,
        ]),
      );
    }
    expect(context.containerCompleteness).toEqual({
      kind: "bounded",
      observed: 2,
      returned: 2,
      truncated: false,
    });
    expect(JSON.stringify(context)).not.toMatch(/credential-secret|must-not-project|data-private/);
  });

  it("keeps row membership across reorder and denies replacement, movement, and forged references", async () => {
    await page.setContent(`
      <div role="row" id="a"><button>Rotate</button></div>
      <div role="row" id="b"><button>Rotate</button></div>
    `);
    const context = await observeSemanticPageContext(page);
    const control = context.controls[0]!;
    const intent = referenceIntent(control.reference);
    intent.concept = "rotate";
    intent.requiredCapabilities = ["focusable", "pointer_activatable"];
    intent.risk = "protected";

    await page.locator("#b").evaluate((row) => row.parentElement!.prepend(row));
    await expect(resolveTarget(page, intent)).resolves.toMatchObject({ adapter: "native_click" });

    await page
      .locator("#a button")
      .evaluate((button) => document.querySelector("#b")!.append(button));
    await expect(resolveTarget(page, intent)).rejects.toThrow("TARGET_CHANGED_BEFORE_ACTION");

    await page.setContent(`
      <div role="row" data-structural-reference="${control.containerReferences![0]}">
        <button data-reference="${control.reference}">Rotate</button>
      </div>
    `);
    const replacement = await observeSemanticPageContext(page);
    expect(replacement.controls[0]!.reference).not.toBe(control.reference);
    expect(replacement.containers[0]!.reference).not.toBe(control.containerReferences![0]);
  });

  it("keeps same-document exact identity authoritative across semantic drift", async () => {
    await page.setContent('<div role="row"><button id="action">Rotate</button></div>');
    const context = await observeSemanticPageContext(page);
    const intent = referenceIntent(context.controls[0]!.reference);
    intent.requiredCapabilities = ["focusable", "pointer_activatable"];
    await page.locator("#action").evaluate((button) => {
      button.textContent = "Revoke";
    });
    await expect(resolveTarget(page, intent)).resolves.toMatchObject({
      diagnostic: { candidateCount: 1 },
    });

    await page.setContent('<div role="row" id="row"><button>Rotate</button></div>');
    const structural = await observeSemanticPageContext(page);
    const structuralIntent = referenceIntent(structural.controls[0]!.reference);
    structuralIntent.requiredCapabilities = ["focusable", "pointer_activatable"];
    await page.locator("#row").evaluate((row) => row.setAttribute("role", "group"));
    await expect(resolveTarget(page, structuralIntent)).resolves.toMatchObject({
      diagnostic: { candidateCount: 1 },
    });
  });

  it("suppresses group text around protected descendants and bounds candidate relocation", async () => {
    await page.setContent(`
      <section aria-label="protected-client-id-must-not-leak">
        <span data-scry-redacted="true">secret</span><button>Rotate</button>
      </section>
    `);
    const protectedContext = await observeSemanticPageContext(page);
    expect(
      protectedContext.controls.find((control) => control.name === "Rotate")!.group,
    ).toBeUndefined();
    expect(JSON.stringify(protectedContext)).not.toContain("protected-client-id-must-not-leak");

    await page.setContent(
      `${Array.from({ length: 5_001 }, () => "<button hidden>Hidden</button>").join("")}<button>Visible after budget</button>`,
    );
    const bounded = await observeSemanticPageContext(page);
    expect(bounded.completeness).toMatchObject({ observed: 5_002, returned: 0, truncated: true });
    expect(bounded.controls).toHaveLength(0);
  });

  it("keeps an independently public form label visible beside a protected control", async () => {
    await page.setContent(`
      <form aria-label="Account sign in">
        <label>Password <input type="password" /></label>
        <button>Continue</button>
      </form>
    `);
    const context = await observeSemanticPageContext(page);
    expect(context.controls.find((control) => control.name === "Continue")?.group).toBe(
      "Account sign in",
    );
    expect(context.controls.find((control) => control.valueProtected)?.group).toBe(
      "Account sign in",
    );
  });

  it.each([
    [
      "email and password",
      '<label>Email <input type="email"></label><label>Password <input type="password"></label>',
      ["Password"],
    ],
    [
      "ordinary textboxes and password",
      '<input aria-label="First"><input aria-label="Second"><label>Password <input type="password"></label>',
      ["Password"],
    ],
    [
      "repeated labels in separate forms",
      '<form aria-label="Primary"><label>Secret <input type="password"></label></form><form aria-label="Secondary"><label>Secret <input type="password"></label></form>',
      ["Secret", "Secret"],
    ],
    [
      "purpose without a label",
      '<input type="password" autocomplete="current-password">',
      ["identity suppressed"],
    ],
    [
      "OTP and PIN",
      '<label>Code <input data-scry-redacted="true" autocomplete="one-time-code"></label><label>PIN <input data-scry-redacted="true" inputmode="numeric"></label>',
      ["identity suppressed", "identity suppressed"],
    ],
  ])("keeps privacy-safe protected identity for %s", async (_name, markup, expectedNames) => {
    await page.setContent(`<main>${markup}</main>`);
    const context = await observeSemanticPageContext(page);
    const protectedControls = context.controls.filter((control) => control.valueProtected);
    expect(protectedControls.map((control) => control.name)).toEqual(expectedNames);
    expect(new Set(protectedControls.map((control) => control.reference)).size).toBe(
      expectedNames.length,
    );
  });

  it("excludes a hidden protected decoy and fails stale and cross-page references closed", async () => {
    await page.setContent(`
      <input type="password" aria-label="Decoy" style="display:none">
      <label>Visible password <input type="password"></label>
    `);
    const context = await observeSemanticPageContext(page);
    const protectedControls = context.controls.filter((control) => control.valueProtected);
    expect(protectedControls).toHaveLength(1);
    expect(protectedControls[0]!.name).toBe("Visible password");
    const intent = referenceIntent(protectedControls[0]!.reference);
    expect((await resolveTarget(page, intent)).locator).toBeDefined();

    const otherPage = await browser.newPage();
    await otherPage.setContent('<label>Visible password <input type="password"></label>');
    await expect(withDeadline(resolveTarget(otherPage, intent), "cross-page")).rejects.toThrow(
      "TARGET_CHANGED_BEFORE_ACTION",
    );
    await otherPage.close();

    await page.setContent('<label>Replacement <input type="password"></label>');
    await expect(withDeadline(resolveTarget(page, intent), "stale-page")).rejects.toThrow(
      "TARGET_CHANGED_BEFORE_ACTION",
    );
  }, 15_000);

  it("does not turn a protected text-entry reference into a generic activation capability", async () => {
    await page.setContent('<label>Password <input type="password"></label>');
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.valueProtected)!.reference;
    const intent = referenceIntent(reference);
    intent.requiredCapabilities = ["pointer_activatable"];
    await expect(resolveTarget(page, intent)).rejects.toThrow("NO_CAPABILITY_COMPATIBLE_CONTROL");
  });

  it("revalidates a referenced sibling across unrelated DOM mutation and rejects target drift", async () => {
    await page.setContent(`
      <label>Email <input aria-label="Email"></label>
      <label>Password <input id="password" type="password" aria-label="Password"></label>
    `);
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.valueProtected)!.reference;
    const intent = referenceIntent(reference);

    await page.getByLabel("Email").fill("safe@example.test");
    const refreshed = await observeSemanticPageContext(page);
    expect(refreshed.controls.find((control) => control.valueProtected)!.reference).toBe(reference);
    await expect(resolveTarget(page, intent)).resolves.toMatchObject({ adapter: "native_fill" });

    await page.locator("#password").evaluate((element) => {
      element.setAttribute("disabled", "");
    });
    await expect(resolveTarget(page, intent)).rejects.toThrow("TARGET_CHANGED_BEFORE_ACTION");

    await page.setContent(
      '<label>Password <input id="password" type="password" aria-label="Password"></label>',
    );
    await expect(resolveTarget(page, intent)).rejects.toThrow("TARGET_CHANGED_BEFORE_ACTION");
  });

  it("accepts the published activation capability for an ordinary button reference", async () => {
    await page.setContent('<button type="submit">Login</button>');
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.name === "Login")!.reference;
    const intent = referenceIntent(reference);
    intent.concept = "login submission";
    intent.requiredCapabilities = ["focusable", "pointer_activatable"];
    intent.risk = "authentication";
    await expect(resolveTarget(page, intent)).resolves.toMatchObject({ adapter: "native_click" });
  });

  it("invalidates a reference when the same element changes protected purpose or capability", async () => {
    await page.setContent('<label>Account <input id="field" aria-label="Account"></label>');
    const ordinary = await observeSemanticPageContext(page);
    const ordinaryReference = ordinary.controls.find(
      (control) => control.name === "Account",
    )!.reference;

    await page.locator("#field").evaluate((element) => {
      element.setAttribute("type", "password");
      element.setAttribute("autocomplete", "new-password");
      element.setAttribute("aria-label", "New password");
    });
    const protectedContext = await observeSemanticPageContext(page);
    const protectedControl = protectedContext.controls.find((control) => control.valueProtected)!;
    expect(protectedControl.reference).not.toBe(ordinaryReference);
    await expect(resolveTarget(page, referenceIntent(ordinaryReference))).rejects.toThrow(
      "TARGET_CHANGED_BEFORE_ACTION",
    );

    const protectedReference = protectedControl.reference;
    await page.locator("#field").evaluate((element) => element.setAttribute("disabled", ""));
    const disabledContext = await observeSemanticPageContext(page);
    expect(
      disabledContext.controls.find((control) => control.name === "New password")!.reference,
    ).not.toBe(protectedReference);
  });

  it("authoritatively observes the exact registered handle as visible, then absent after removal", async () => {
    await page.setContent(`
      <div role="row"><button id="target">Rotate key</button></div>
      <script>
        window.actionDispatches = 0;
        document.querySelector('#target').addEventListener('click', () => window.actionDispatches += 1);
      </script>
    `);
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.name === "Rotate key")!.reference;

    await expect(observeSemanticPageContextReferenceState(page, reference)).resolves.toEqual({
      state: "visible",
      reasonCode: "CONTEXT_REFERENCE_VISIBLE",
    });
    await page.locator("#target").evaluate((element) => element.remove());
    await expect(observeSemanticPageContextReferenceState(page, reference)).resolves.toEqual({
      state: "absent",
      reasonCode: "CONTEXT_REFERENCE_ABSENT",
    });
    expect(
      await page.evaluate(
        () => (window as typeof window & { actionDispatches: number }).actionDispatches,
      ),
    ).toBe(0);
  });

  it("keeps a same-semantic replacement ambiguous instead of adopting it", async () => {
    await page.setContent('<div role="row"><button id="target">Rotate key</button></div>');
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.name === "Rotate key")!.reference;
    await page.locator("#target").evaluate((element) => {
      const replacement = document.createElement("button");
      replacement.id = "replacement";
      replacement.textContent = "Rotate key";
      element.replaceWith(replacement);
    });

    await expect(observeSemanticPageContextReferenceState(page, reference)).resolves.toEqual({
      state: "ambiguous_stale",
      reasonCode: "CONTEXT_REFERENCE_REPLACEMENT_AMBIGUOUS",
    });
  });

  it("preserves exact handles across same-document moves and refuses cross-document reuse", async () => {
    await page.setContent(`
      <div role="row" id="first"><button id="target">Rotate key</button></div>
      <div role="row" id="second"></div>
    `);
    const context = await observeSemanticPageContext(page);
    const reference = context.controls.find((control) => control.name === "Rotate key")!.reference;
    await page
      .locator("#target")
      .evaluate((element) => document.querySelector("#second")!.append(element));
    await expect(observeSemanticPageContextReferenceState(page, reference)).resolves.toMatchObject({
      state: "visible",
    });

    await page.setContent('<button id="target">Rotate key</button>');
    const semanticContext = await observeSemanticPageContext(page);
    const semanticReference = semanticContext.controls[0]!.reference;
    await page.locator("#target").evaluate((element) => {
      element.textContent = "Delete key";
    });
    await expect(
      observeSemanticPageContextReferenceState(page, semanticReference),
    ).resolves.toEqual({
      state: "visible",
      reasonCode: "CONTEXT_REFERENCE_VISIBLE",
    });

    await page.goto('data:text/html,<button id="new-document">Rotate key</button>');
    await expect(
      observeSemanticPageContextReferenceState(page, semanticReference),
    ).resolves.toEqual({
      state: "ambiguous_stale",
      reasonCode: "CONTEXT_REFERENCE_DOCUMENT_CHANGED",
    });
  });

  it("bounds observation when controls disappear while exact handles are pinned", async () => {
    await page.setContent(
      `<main>${Array.from(
        { length: 80 },
        (_, index) => `<button id="control-${index}">Control ${index}</button>`,
      ).join("")}</main>`,
    );
    await page.evaluate(() => {
      let index = 79;
      const timer = window.setInterval(() => {
        document.querySelector(`#control-${index}`)?.remove();
        index -= 1;
        if (index < 35) window.clearInterval(timer);
      }, 0);
    });

    const before = performance.now();
    const context = await observeSemanticPageContext(page);

    expect(performance.now() - before).toBeLessThan(3_000);
    expect(
      context.controls.every((control) => control.reference.startsWith("context-control-")),
    ).toBe(true);
  });

  it("projects redacted operation facts onto exact current controls without trusting aliases", async () => {
    await page.route("https://operation.example.test/", async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
          <label>Client ID <input /></label>
          <button>Create item</button>
          <script type="application/scry-operation-contract+json">${JSON.stringify({
            application: { key: "example", provider: "example" },
            adapter: { key: "public_document", version: 1 },
            operation: {
              key: "createItem",
              label: "Create item",
              method: "POST",
              pathTemplate: "/items",
              transports: ["fetch"],
              semantics: { dispatch: "mutation", effects: ["business_effect"] },
            },
            inputs: [
              {
                key: "clientId",
                label: "Client ID",
                aliases: ["Customer"],
                required: true,
                classification: "public",
                acceptedPresentations: ["plain_text"],
              },
            ],
            auth: { presentationClasses: [] },
            response: {
              statusClasses: [2],
              mutationPolicy: { confirmedNotAppliedStatuses: [400, 401, 403, 422] },
              outputs: [
                {
                  key: "itemId",
                  label: "id",
                  classification: "public",
                  extractor: { kind: "json_path", path: "$.itemId" },
                  identityRole: "continuation_identity",
                  generatedValueEligible: true,
                },
              ],
              continuation: "read_only_retrieve",
            },
          })}</script>`,
      }),
    );
    await page.goto("https://operation.example.test/");
    const [contract] = await observeOperationContracts(
      page,
      "00000000-0000-4000-8000-000000000001",
    );
    expect(contract).toMatchObject({
      facts: {
        operation: { key: "createItem" },
        inputs: [{ key: "clientId", aliases: ["Customer"] }],
      },
      interaction: {
        activationControlReference: expect.stringMatching(/^context-control-[a-f0-9]{32}$/),
        inputControlReferences: {
          clientId: expect.stringMatching(/^context-control-[a-f0-9]{32}$/),
        },
      },
    });
    expect(JSON.stringify(contract)).not.toContain("must-not-leak");
    await page.unroute("https://operation.example.test/");
  });

  it("refuses a public declaration that attempts to supply opaque control authority", async () => {
    await page.setContent(`
      <label>Password <input type="password" /></label>
      <button>Sign in</button>
      <script type="application/scry-operation-contract+json">${JSON.stringify({
        application: { key: "example", provider: "example" },
        adapter: { key: "public_document", version: 1 },
        operation: {
          key: "authenticate",
          label: "Sign in",
          method: "POST",
          pathTemplate: "/sessions",
          transports: ["fetch"],
          semantics: { dispatch: "mutation", effects: ["authentication"] },
        },
        inputs: [
          {
            key: "password",
            label: "Password",
            aliases: [],
            required: true,
            classification: "protected",
            acceptedPresentations: ["protected_text"],
            controlReference: `context-control-${"f".repeat(32)}`,
          },
        ],
        auth: { presentationClasses: ["protected_text"] },
        response: {
          statusClasses: [2],
          mutationPolicy: { confirmedNotAppliedStatuses: [400, 401, 403] },
          outputs: [{ key: "authenticated", label: "authenticated", classification: "public" }],
          continuation: "none",
        },
      })}</script>
    `);
    await expect(
      observeOperationContracts(page, "00000000-0000-4000-8000-000000000001"),
    ).resolves.toEqual([]);
  });

  it("keeps field aliases display-only instead of using them as execution authority", async () => {
    await page.setContent(`
      <label>Customer <input /></label>
      <button>Create item</button>
      <script type="application/scry-operation-contract+json">${JSON.stringify({
        application: { key: "example", provider: "example" },
        adapter: { key: "public_document", version: 1 },
        operation: {
          key: "createItem",
          label: "Create item",
          method: "POST",
          pathTemplate: "/items",
          transports: ["fetch"],
          semantics: { dispatch: "mutation", effects: ["business_effect"] },
        },
        inputs: [
          {
            key: "clientId",
            label: "Client ID",
            aliases: ["Customer"],
            required: true,
            classification: "public",
            acceptedPresentations: ["plain_text"],
          },
        ],
        auth: { presentationClasses: [] },
        response: {
          statusClasses: [2],
          mutationPolicy: { confirmedNotAppliedStatuses: [400] },
          outputs: [{ key: "itemId", label: "id", classification: "public" }],
          continuation: "none",
        },
      })}</script>
    `);
    await expect(
      observeOperationContracts(page, "00000000-0000-4000-8000-000000000001"),
    ).resolves.toEqual([]);
  });
});

function referenceIntent(reference: string): InteractionTargetIntent {
  return {
    concept: "protected input",
    authoritativeReference: reference,
    requiredCapabilities: ["focusable", "accepts_text", "editable"],
    preferredEvidence: {
      roles: [],
      names: [],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "authentication",
    confidence: { requiredFamilies: [] },
    matching: "exact",
  };
}

function withDeadline<T>(promise: Promise<T>, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`fixture-timeout:${label}`)), 1_000),
    ),
  ]);
}
