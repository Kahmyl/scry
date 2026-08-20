import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InteractionTargetIntent } from "@scry/contracts";
import { resolveTarget } from "../src/grounding.js";

type Issuance = {
  projectId: string;
  environmentId: string;
  provider: string;
  applicationId: string;
  publicRecordId?: string;
  publicLabel?: string;
  createdAt?: string;
};

type ProviderRecord = {
  publicRecordId: string;
  publicLabel: string;
  status: "active" | "revoked";
};

const owner = {
  projectId: "project-a",
  environmentId: "environment-a",
  provider: "provider-a",
  applicationId: "application-a",
} as const;

function boundRecord(issuance: Issuance, records: ProviderRecord[]) {
  if (
    issuance.projectId !== owner.projectId ||
    issuance.environmentId !== owner.environmentId ||
    issuance.provider !== owner.provider ||
    issuance.applicationId !== owner.applicationId
  )
    return undefined;
  if (!issuance.publicRecordId) return undefined;
  const matches = records.filter((record) => record.publicRecordId === issuance.publicRecordId);
  return matches.length === 1 ? matches[0] : undefined;
}

function revokeIntent(publicRecordId: string): InteractionTargetIntent {
  return {
    concept: "revoke issuance-bound provider credential",
    requiredCapabilities: ["focusable", "pointer_activatable"],
    preferredEvidence: {
      roles: ["button"],
      names: ["Revoke"],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
      testIds: [],
    },
    scope: { kind: "row", name: publicRecordId },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "destructive",
    confidence: { requiredFamilies: [] },
    matching: "exact",
  };
}

function row(record: ProviderRecord, structuralConvenience = false) {
  return `<div role="row" aria-label="${record.publicRecordId}">
    <span>${record.publicLabel}</span><span>${record.status}</span>
    ${structuralConvenience ? "<strong>recommended</strong>" : ""}
    ${record.status === "active" ? '<button aria-label="Revoke">Revoke</button>' : ""}
  </div>`;
}

describe("external provider record identity binding characterization", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    page = await browser.newPage();
  });
  afterAll(async () => browser.close());

  it("A: proves one record only from an issuance-bound public record ID", () => {
    const records = [
      { publicRecordId: "record-a", publicLabel: "Alpha", status: "active" },
    ] as const;
    expect(boundRecord({ ...owner, publicRecordId: "record-a" }, [...records])).toEqual(records[0]);
  });

  it("B: proves the exact record among multiple public IDs", () => {
    const records: ProviderRecord[] = [
      { publicRecordId: "record-a", publicLabel: "Alpha", status: "active" },
      { publicRecordId: "record-b", publicLabel: "Beta", status: "active" },
    ];
    expect(boundRecord({ ...owner, publicRecordId: "record-b" }, records)?.publicRecordId).toBe(
      "record-b",
    );
  });

  it("C: distinguishable rows without issuance binding remain insufficient", () => {
    const records: ProviderRecord[] = [
      { publicRecordId: "record-a", publicLabel: "Alpha", status: "active" },
      { publicRecordId: "record-b", publicLabel: "Beta", status: "active" },
    ];
    expect(boundRecord(owner, records)).toBeUndefined();
  });

  it("D: cardinality one without issuance binding remains insufficient", () => {
    expect(
      boundRecord(owner, [{ publicRecordId: "record-a", publicLabel: "Alpha", status: "active" }]),
    ).toBeUndefined();
  });

  it("E: an observed label cannot create missing historical provenance", () => {
    expect(
      boundRecord(owner, [{ publicRecordId: "record-a", publicLabel: "Alpha", status: "active" }]),
    ).toBeUndefined();
  });

  it("F: timestamp proximity is not record identity", () => {
    expect(
      boundRecord({ ...owner, createdAt: "2030-01-01T00:00:00Z" }, [
        { publicRecordId: "record-a", publicLabel: "Alpha", status: "active" },
      ]),
    ).toBeUndefined();
  });

  it("G: a duplicated safe public descriptor remains insufficient", () => {
    const records: ProviderRecord[] = [
      { publicRecordId: "record-shared", publicLabel: "Shared", status: "active" },
      { publicRecordId: "record-shared", publicLabel: "Shared", status: "active" },
    ];
    expect(boundRecord({ ...owner, publicRecordId: "record-shared" }, records)).toBeUndefined();
  });

  it("H: provider status cannot substitute for issuance binding", () => {
    const records: ProviderRecord[] = [
      { publicRecordId: "record-a", publicLabel: "Alpha", status: "revoked" },
      { publicRecordId: "record-b", publicLabel: "Beta", status: "active" },
    ];
    expect(boundRecord(owner, records)).toBeUndefined();
  });

  it("I: bound identity dominates structural convenience and unchanged Praxis resolves its control", async () => {
    const records: ProviderRecord[] = [
      { publicRecordId: "record-a", publicLabel: "Alpha", status: "active" },
      { publicRecordId: "record-b", publicLabel: "Beta", status: "active" },
    ];
    const bound = boundRecord({ ...owner, publicRecordId: "record-b" }, records)!;
    await page.setContent(row(records[0]!, true) + row(records[1]!));
    const grounded = await resolveTarget(page, revokeIntent(bound.publicRecordId));
    expect(await grounded.locator.getAttribute("aria-label")).toBe("Revoke");
    await grounded.revalidate();
  });

  it("J: a forbidden secret-only distinction cannot select a public record", async () => {
    await page.setContent(
      row({ publicRecordId: "record-a", publicLabel: "Alpha", status: "active" }),
    );
    await expect(
      resolveTarget(page, revokeIntent("secret-only-discriminator")),
    ).rejects.toMatchObject({
      code: "TARGET_SCOPE_INVALID",
      diagnostic: { safeActions: ["narrow_scope", "revise_intent"] },
    });
  });
});
