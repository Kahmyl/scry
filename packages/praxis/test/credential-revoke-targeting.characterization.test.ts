import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InteractionTargetIntent } from "@scry/contracts";
import {
  GroundingError,
  registerGroundingObserver,
  resolveTarget,
  type GroundingDiagnostic,
} from "../src/grounding.js";

const baseIntent: InteractionTargetIntent = {
  concept: "revoke intended credential",
  requiredCapabilities: ["focusable", "pointer_activatable"],
  preferredEvidence: {
    roles: ["button"], names: ["Revoke"], labels: [], descriptions: [],
    placeholders: [], inputTypes: [], testIds: [],
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "live",
  confidence: { requiredFamilies: [] },
  matching: "exact",
};

let browser: Awaited<ReturnType<typeof chromium.launch>>;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
  page = await browser.newPage();
});
afterAll(async () => browser.close());

async function characterize(html: string, intent: InteractionTargetIntent = baseIntent) {
  await page.setContent(html);
  let observed: (GroundingDiagnostic & { outcome: "resolved" | "rejected"; code?: string }) | undefined;
  registerGroundingObserver(page, (diagnostic) => { observed = diagnostic; });
  try {
    const result = await resolveTarget(page, intent);
    return { code: "RESOLVED", diagnostic: result.diagnostic };
  } catch (error) {
    expect(error).toBeInstanceOf(GroundingError);
    return { code: (error as GroundingError).code, diagnostic: observed! };
  }
}

function row(label: string, status: "Active" | "Revoked", hiddenDuplicate = false) {
  return `<tr role="row"><th scope="row">${label}</th><td>${status}</td><td>
    ${status === "Active" ? '<button aria-label="Revoke credential">Revoke</button>' : '<span>Revoked</span>'}
    ${hiddenDuplicate ? '<button hidden aria-label="Revoke credential">Revoke</button>' : ''}
  </td></tr>`;
}

describe("credential revoke targeting characterization", () => {
  it("resolves one credential with one visible revoke control", async () => {
    const result = await characterize(`<table><tbody>${row("Credential Alpha", "Active")}</tbody></table>`);
    expect(result).toMatchObject({ code: "RESOLVED", diagnostic: { candidateCount: 1, eligibleCount: 1 } });
  });

  it("fails closed for two active credential rows with identical controls", async () => {
    const result = await characterize(`<table><tbody>${row("Credential Alpha", "Active")}${row("Credential Beta", "Active")}</tbody></table>`);
    console.log("SAFE_REVOKE_AMBIGUITY_METRICS", JSON.stringify({
      code: result.code,
      candidateCount: result.diagnostic.candidateCount,
      eligibleCount: result.diagnostic.eligibleCount,
      confidence: result.diagnostic.confidence,
      confidenceMargin: result.diagnostic.confidenceMargin,
      score: result.diagnostic.score,
      evidenceFamilies: result.diagnostic.evidenceFamilies,
      rejectedConstraints: result.diagnostic.rejectedConstraints,
    }));
    expect(result).toMatchObject({
      code: "TARGET_AMBIGUOUS",
      diagnostic: { candidateCount: 2, eligibleCount: 2, confidenceMargin: 0 },
    });
  });

  it("resolves when only one credential remains active", async () => {
    const result = await characterize(`<table><tbody>${row("Credential Alpha", "Active")}${row("Credential Beta", "Revoked")}</tbody></table>`);
    expect(result).toMatchObject({ code: "RESOLVED", diagnostic: { candidateCount: 1, eligibleCount: 1 } });
  });

  it("rejects a hidden duplicate and resolves the visible control", async () => {
    const result = await characterize(`<table><tbody>${row("Credential Alpha", "Active", true)}</tbody></table>`);
    expect(result).toMatchObject({
      code: "RESOLVED",
      diagnostic: { candidateCount: 2, eligibleCount: 1, rejectedConstraints: expect.arrayContaining(["hidden"]) },
    });
  });

  it.each([
    `${row("Credential Alpha", "Active")}${row("Credential Beta", "Active")}`,
    `${row("Credential Beta", "Active")}${row("Credential Alpha", "Active")}`,
  ])("uses a named row scope independent of row order", async (rows) => {
    const result = await characterize(`<table><tbody>${rows}</tbody></table>`, {
      ...baseIntent,
      scope: { kind: "row", name: "Credential Beta" },
    });
    expect(result).toMatchObject({ code: "RESOLVED", diagnostic: { candidateCount: 1, eligibleCount: 1 } });
  });

  it("ignores unrelated revoke text that is not an actionable button", async () => {
    const result = await characterize(`<p>Revoke access from the audit page.</p><table><tbody>${row("Credential Alpha", "Active")}</tbody></table>`);
    expect(result).toMatchObject({ code: "RESOLVED", diagnostic: { candidateCount: 1, eligibleCount: 1 } });
  });

  it("uses a same-boundary relation for div-based credential containers", async () => {
    const result = await characterize(`
      <div role="row"><span>Credential Alpha</span><button aria-label="Revoke credential">Revoke</button></div>
      <div role="row"><span>Credential Beta</span><button aria-label="Revoke credential">Revoke</button></div>
    `, { ...baseIntent, relations: [{ kind: "same_boundary", name: "Credential Beta" }] });
    expect(result).toMatchObject({ code: "RESOLVED", diagnostic: { candidateCount: 2, eligibleCount: 1 } });
  });

  it("does not prove row association with same-boundary on native table rows", async () => {
    const result = await characterize(`<div><table><tbody>${row("Credential Alpha", "Active")}${row("Credential Beta", "Active")}</tbody></table></div>`, {
      ...baseIntent,
      relations: [{ kind: "same_boundary", name: "Credential Beta" }],
    });
    expect(result).toMatchObject({ code: "TARGET_AMBIGUOUS", diagnostic: { eligibleCount: 2, confidenceMargin: 0 } });
  });

  it("fails closed when a named row association is not unique", async () => {
    const result = await characterize(`<table><tbody>${row("Shared Credential", "Active")}${row("Shared Credential", "Active")}</tbody></table>`, {
      ...baseIntent,
      scope: { kind: "row", name: "Shared Credential" },
    });
    expect(result).toMatchObject({ code: "TARGET_SCOPE_INVALID" });
  });
});
