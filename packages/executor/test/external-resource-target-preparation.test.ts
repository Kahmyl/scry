import type { ExternalResourcePresentationContract } from "@scry/contracts";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ExternalResourcePresentationError,
  prepareExternalResourceDestructiveTarget,
  type AuthoritativeExternalResourceObservation,
  type TrustedExternalSemanticIdentity,
} from "../src/external-resource-target-preparation.js";

describe("cross-surface external resource destructive target preparation", () => {
  let browser: Browser;
  let page: Page;
  let clickCount = 0;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    page = await browser.newPage();
  });
  beforeEach(async () => {
    clickCount = 0;
    page.removeAllListeners("console");
    page.on("console", (message) => {
      if (message.text() === "REVOKE_DISPATCHED") clickCount += 1;
    });
  });
  afterAll(async () => browser.close());

  const ownership = { projectId: "project-a", environmentId: "environment-a" };
  const binding: TrustedExternalSemanticIdentity = {
    sourceProtectedOperationId: "operation-a",
    ...ownership,
    externalIdentity: "canonical-a",
    provider: "provider",
    resourceKind: "credential",
    resourceScope: "application-a",
    identityContractVersion: 1,
  };
  const contract: ExternalResourcePresentationContract = {
    canonicalIdentity: { source: "external_resource_binding" },
    resource: { provider: "provider", kind: "credential", scope: "application-a" },
    presentationObservation: {
      source: "authoritative_read_only_resource_observation",
      resourceCollection: "application_credentials",
    },
    presentationIdentity: {
      semanticField: "label",
      classification: "internal_non_secret",
      stability: "current_projection",
    },
    browserBoundary: { kind: "row" },
    action: {
      concept: "revoke issuance-bound credential",
      requiredCapabilities: ["focusable", "pointer_activatable"],
      preferredEvidence: {
        roles: ["button"], names: ["Revoke", "Revoke credential"], labels: [],
        descriptions: [], placeholders: [], inputTypes: [], testIds: [],
      },
      scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
      risk: "destructive", confidence: { requiredFamilies: [] }, matching: "exact",
    },
  };

  type RecordShape = {
    id: string;
    fields: Array<{ semanticField: string; classification: "internal_non_secret" | "protected"; value: string }>;
  };
  const label = (value: string, classification: "internal_non_secret" | "protected" = "internal_non_secret") => ({
    semanticField: "label", classification, value,
  });
  const observation = (id: string, records: RecordShape[]): AuthoritativeExternalResourceObservation => ({
    observationId: id,
    source: "authoritative_read_only_resource_observation",
    resourceCollection: "application_credentials",
    ...ownership,
    provider: "provider",
    resourceKind: "credential",
    resourceScope: "application-a",
    records: records.map((record) => ({
      canonicalIdentity: record.id,
      presentationFields: record.fields,
    })),
  });
  const row = (visibleLabel: string, controls = 1, extra = "") => `<tr role="row">
    <td>${visibleLabel}</td><td>${extra}</td><td>active</td><td>Never</td><td>
    ${Array.from({ length: controls }, () => '<button aria-label="Revoke" onclick="console.log(\'REVOKE_DISPATCHED\')">Revoke</button>').join("")}
    </td></tr>`;

  async function prepare(input: {
    records: RecordShape[];
    secondRecords?: RecordShape[];
    html?: string;
    activeBinding?: TrustedExternalSemanticIdentity;
    activeContract?: ExternalResourcePresentationContract;
  }) {
    await page.setContent(`<table><tbody>${input.html ?? row("Alpha")}</tbody></table>`);
    let sequence = 0;
    return prepareExternalResourceDestructiveTarget({
      page,
      binding: input.activeBinding ?? binding,
      expectedOwnership: ownership,
      presentationContract: input.activeContract ?? contract,
      observeResources: async ({ phase }) => observation(
        `observation-${++sequence}`,
        phase === "pre_dispatch" ? input.secondRecords ?? input.records : input.records,
      ),
      allowedOrigins: [],
    });
  }

  async function expectCode(work: Promise<unknown>, code: string) {
    await expect(work).rejects.toMatchObject({ code });
  }

  it("A: prepares a bound resource through one unique public presentation label", async () => {
    const prepared = await prepare({ records: [{ id: "canonical-a", fields: [label("Alpha")] }] });
    expect(prepared.providerRevalidated).toBe(true);
    expect(prepared.presentationIdentityValidated).toBe(true);
    expect(clickCount).toBe(0);
  });

  it("B: prepares the intended row among multiple canonical resources", async () => {
    const prepared = await prepare({
      records: [
        { id: "canonical-a", fields: [label("Alpha")] },
        { id: "canonical-b", fields: [label("Beta")] },
      ],
      activeBinding: { ...binding, externalIdentity: "canonical-b" },
      html: row("Alpha") + row("Beta"),
    });
    expect(await prepared.locator.evaluate((element) => element.closest("tr")?.textContent)).toContain("Beta");
    expect(clickCount).toBe(0);
  });

  it("C: rejects a presentation label duplicated in current provider state", async () => {
    await expectCode(prepare({ records: [
      { id: "canonical-a", fields: [label("Same")] },
      { id: "canonical-b", fields: [label("Same")] },
    ], html: row("Same") + row("Same") }), "PRESENTATION_IDENTITY_AMBIGUOUS");
  });

  it("D: rejects a missing bound canonical resource", async () => {
    await expectCode(prepare({ records: [{ id: "canonical-b", fields: [label("Beta")] }] }), "CANONICAL_RESOURCE_NOT_FOUND");
  });

  it("E: rejects a browser surface that does not expose the projected label", async () => {
    await expectCode(prepare({ records: [{ id: "canonical-a", fields: [label("Alpha")] }], html: row("Unrelated") }), "BROWSER_BOUNDARY_NOT_FOUND");
  });

  it("F: rejects two browser containers with the same projected label", async () => {
    await expectCode(prepare({ records: [{ id: "canonical-a", fields: [label("Alpha")] }], html: row("Alpha") + row("Alpha") }), "BROWSER_BOUNDARY_AMBIGUOUS");
  });

  it("G: rejects two intended actions inside the unique browser container", async () => {
    await expectCode(prepare({ records: [{ id: "canonical-a", fields: [label("Alpha")] }], html: row("Alpha", 2) }), "ACTION_TARGET_AMBIGUOUS");
  });

  it("H: rejects a protected-only declared presentation value", async () => {
    await expectCode(prepare({ records: [{ id: "canonical-a", fields: [label("Alpha", "protected")] }] }), "PRESENTATION_IDENTITY_NOT_INTERNAL_SAFE");
  });

  it("uses an explicitly authorized internal-only client ID when label is unavailable", async () => {
    const clientIdContract = {
      ...contract,
      presentationIdentity: { ...contract.presentationIdentity, semanticField: "clientId" },
    };
    const prepared = await prepare({
      activeContract: clientIdContract,
      records: [{ id: "canonical-a", fields: [
        { semanticField: "clientId", classification: "internal_non_secret", value: "client-visible-a" },
      ] }],
      html: row("client-visible-a"),
    });
    expect(prepared.diagnostic.scope).toMatchObject({ kind: "row", name: "client-visible-a" });
    expect(clickCount).toBe(0);
  });

  it("does not borrow an authorized client ID from the wrong canonical record", async () => {
    const clientIdContract = {
      ...contract,
      presentationIdentity: { ...contract.presentationIdentity, semanticField: "clientId" },
    };
    await expectCode(prepare({
      activeContract: clientIdContract,
      records: [
        { id: "canonical-a", fields: [label("unavailable-label")] },
        { id: "canonical-b", fields: [
          { semanticField: "clientId", classification: "internal_non_secret", value: "client-visible-b" },
        ] },
      ],
      html: row("client-visible-b"),
    }), "PRESENTATION_IDENTITY_UNAVAILABLE");
  });

  it("rejects client ID without independent internal-only classification", async () => {
    const clientIdContract = {
      ...contract,
      presentationIdentity: { ...contract.presentationIdentity, semanticField: "clientId" },
    };
    await expectCode(prepare({
      activeContract: clientIdContract,
      records: [{ id: "canonical-a", fields: [
        { semanticField: "clientId", classification: "protected", value: "protected-client-id" },
      ] }],
      html: row("protected-client-id"),
    }), "PRESENTATION_IDENTITY_NOT_INTERNAL_SAFE");
  });

  it("rejects an authorized client ID absent from the browser surface", async () => {
    const clientIdContract = {
      ...contract,
      presentationIdentity: { ...contract.presentationIdentity, semanticField: "clientId" },
    };
    await expectCode(prepare({
      activeContract: clientIdContract,
      records: [{ id: "canonical-a", fields: [
        { semanticField: "clientId", classification: "internal_non_secret", value: "client-visible-a" },
      ] }],
      html: row("unrelated"),
    }), "BROWSER_BOUNDARY_NOT_FOUND");
  });

  it("I: rejects secret suffix as the only available discriminator", async () => {
    const suffixContract = {
      ...contract,
      presentationIdentity: { ...contract.presentationIdentity, semanticField: "secretSuffix" },
    };
    await expectCode(prepare({
      activeContract: suffixContract,
      records: [{ id: "canonical-a", fields: [{ semanticField: "secretSuffix", classification: "protected", value: "suffix" }] }],
    }), "PRESENTATION_IDENTITY_NOT_INTERNAL_SAFE");
  });

  it("J: rejects status and timestamp when the declared public label is absent", async () => {
    await expectCode(prepare({ records: [{ id: "canonical-a", fields: [
      { semanticField: "status", classification: "internal_non_secret", value: "active" },
      { semanticField: "createdAt", classification: "internal_non_secret", value: "2030-01-01" },
    ] }] }), "PRESENTATION_IDENTITY_UNAVAILABLE");
  });

  it("K: rejects presentation drift between initial observation and pre-dispatch revalidation", async () => {
    await expectCode(prepare({
      records: [{ id: "canonical-a", fields: [label("Alpha")] }],
      secondRecords: [{ id: "canonical-a", fields: [label("Gamma")] }],
    }), "PRESENTATION_IDENTITY_DRIFTED");
  });

  it("L: rejects a label that becomes ambiguous before dispatch", async () => {
    await expectCode(prepare({
      records: [{ id: "canonical-a", fields: [label("Alpha")] }],
      secondRecords: [
        { id: "canonical-a", fields: [label("Alpha")] },
        { id: "canonical-b", fields: [label("Alpha")] },
      ],
    }), "PRESENTATION_IDENTITY_AMBIGUOUS");
  });

  it("M: ignores an unrelated global Revoke control outside the projected row", async () => {
    const prepared = await prepare({
      records: [{ id: "canonical-a", fields: [label("Alpha")] }],
      html: '<button aria-label="Revoke">Revoke</button>' + row("Alpha"),
    });
    expect(await prepared.locator.evaluate((element) => element.closest("tr")?.textContent)).toContain("Alpha");
  });

  it("N: rejects duplicate records carrying the bound canonical identity", async () => {
    await expectCode(prepare({ records: [
      { id: "canonical-a", fields: [label("Alpha")] },
      { id: "canonical-a", fields: [label("Beta")] },
    ] }), "CANONICAL_RESOURCE_DUPLICATE");
  });

  it.each([
    { projectId: "wrong-project" },
    { environmentId: "wrong-environment" },
    { provider: "wrong-provider" },
    { resourceScope: "wrong-application" },
  ])("O: rejects binding ownership or resource scope mismatch before observation: %o", async (override) => {
    let observations = 0;
    await page.setContent(`<table><tbody>${row("Alpha")}</tbody></table>`);
    await expect(prepareExternalResourceDestructiveTarget({
      page,
      binding: { ...binding, ...override },
      expectedOwnership: ownership,
      presentationContract: contract,
      observeResources: async () => {
        observations += 1;
        return observation("never", []);
      },
      allowedOrigins: [],
    })).rejects.toMatchObject({ code: "EXTERNAL_BINDING_UNAVAILABLE" });
    expect(observations).toBe(0);
  });

  it("uses the realistic null-label Vitract row without putting canonical identity in the DOM", async () => {
    const canonicalCanary = "canonical-provider-id-must-remain-internal";
    const html = row("internal-client-presentation", 1, "secret-suffix Active Never");
    expect(html).not.toContain(canonicalCanary);
    const prepared = await prepare({
      activeBinding: { ...binding, externalIdentity: canonicalCanary },
      activeContract: {
        ...contract,
        presentationIdentity: { ...contract.presentationIdentity, semanticField: "clientId" },
      },
      records: [{ id: canonicalCanary, fields: [
        { semanticField: "clientId", classification: "internal_non_secret", value: "internal-client-presentation" },
        { semanticField: "secretSuffix", classification: "protected", value: "secret-suffix" },
        { semanticField: "status", classification: "internal_non_secret", value: "active" },
        { semanticField: "lastUsedAt", classification: "internal_non_secret", value: "never" },
      ] }],
      html,
    });
    expect(prepared.diagnostic.scope).toMatchObject({ kind: "row", name: "internal-client-presentation" });
    expect(JSON.stringify(prepared.diagnostic)).not.toContain(canonicalCanary);
    expect(clickCount).toBe(0);
  });

  it("uses typed categorical errors without embedding canonical identity", () => {
    const error = new ExternalResourcePresentationError("CANONICAL_RESOURCE_NOT_FOUND");
    expect(error.message).toBe("CANONICAL_RESOURCE_NOT_FOUND");
    expect(error.message).not.toContain(binding.externalIdentity);
  });

  it("rejects reuse of the same observation receipt as stale revalidation", async () => {
    await page.setContent(`<table><tbody>${row("Alpha")}</tbody></table>`);
    await expect(prepareExternalResourceDestructiveTarget({
      page, binding, expectedOwnership: ownership, presentationContract: contract,
      observeResources: async () => observation("stale-observation", [
        { id: "canonical-a", fields: [label("Alpha")] },
      ]),
      allowedOrigins: [],
    })).rejects.toMatchObject({ code: "PROVIDER_REVALIDATION_FAILED" });
  });

  it("classifies a missing scoped action separately from a missing boundary", async () => {
    await expectCode(prepare({
      records: [{ id: "canonical-a", fields: [label("Alpha")] }],
      html: '<tr role="row"><td>Alpha</td><td>No lifecycle action</td></tr>',
    }), "ACTION_TARGET_NOT_FOUND");
  });

  it("classifies an unavailable second provider observation as failed revalidation", async () => {
    await page.setContent(`<table><tbody>${row("Alpha")}</tbody></table>`);
    await expect(prepareExternalResourceDestructiveTarget({
      page, binding, expectedOwnership: ownership, presentationContract: contract,
      observeResources: async ({ phase }) => {
        if (phase === "pre_dispatch") throw new Error("private provider failure");
        return observation("initial", [{ id: "canonical-a", fields: [label("Alpha")] }]);
      },
      allowedOrigins: [],
    })).rejects.toMatchObject({ code: "PROVIDER_REVALIDATION_FAILED" });
  });

  it("fails Praxis revalidation when the prepared action drifts after provider revalidation", async () => {
    await page.setContent(`<table><tbody>${row("Alpha")}</tbody></table>`);
    let sequence = 0;
    await expect(prepareExternalResourceDestructiveTarget({
      page, binding, expectedOwnership: ownership, presentationContract: contract,
      observeResources: async ({ phase }) => {
        if (phase === "pre_dispatch")
          await page.getByRole("button", { name: "Revoke" }).evaluate((element) => {
            if (element instanceof HTMLButtonElement) element.disabled = true;
          });
        return observation(`observation-${++sequence}`, [
          { id: "canonical-a", fields: [label("Alpha")] },
        ]);
      },
      allowedOrigins: [],
    })).rejects.toMatchObject({ code: "PRAXIS_REVALIDATION_FAILED" });
  }, 10_000);
});
