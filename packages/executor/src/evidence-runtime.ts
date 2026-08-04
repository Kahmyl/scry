import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { visualRedactionInitScript } from "@scry/praxis";
import type { SecretRedactor } from "@scry/policy";
import {
  type VeilChannelCollector,
  type VeilRuntimeCoordinator,
  type VeilVisualCaptureAuthority,
} from "@scry/veil";
import type { BrowserContext, Page } from "playwright";

import { availableArtifact, writeJson } from "./artifacts.js";
import type { StepExecutionResult } from "./types.js";

type CaptureBinding = {
  browserContextId: string;
  pageId: string;
  frameId: string;
  documentEpoch: number;
};

export async function captureRequestedEvidence(
  page: Page,
  root: string,
  stepId: string,
  evidence: Array<"screenshot" | "dom" | "network">,
  result: StepExecutionResult,
  networkRecords: Array<Record<string, unknown>>,
  redactor: SecretRedactor,
  pendingNetworkBodies: Set<Promise<void>>,
  observation?: Record<string, unknown>,
  privacyGate?: VeilRuntimeCoordinator,
  collectors: ReadonlyMap<string, VeilChannelCollector> = new Map(),
  visualCapture?: VeilVisualCaptureAuthority,
  captureBinding?: () => CaptureBinding,
) {
  if (evidence.includes("screenshot")) {
    if (
      collectors.get("screenshot")?.isCaptureSuppressed() ||
      (privacyGate && privacyGate.getDecision("screenshot") !== "allow")
    ) {
      result.artifacts.push({
        id: randomUUID(),
        kind: "screenshot",
        availability: "destroyed",
        privacyClassification: "uncertain",
        failureProvenance: "privacy",
        reasonCode: "PRIVACY_GATE_CLOSED",
        contentType: "image/png",
        observation: { bytesDestroyed: true, reasonCode: "PRIVACY_GATE_CLOSED" },
      });
      setEvidenceStatus(result, "screenshot", "degraded", "Evidence suppressed by Privacy Gate");
    } else {
      const file = path.join(root, "screenshots", `${stepId}.png`);
      try {
        if (!visualCapture || !captureBinding)
          throw new Error("VEIL_VISUAL_CAPTURE_AUTHORITY_REQUIRED");
        const binding = captureBinding();
        const { permit } = await visualCapture.issue(page, binding);
        const fallback = await visualCapture.capture(page, permit, binding, () =>
          captureScreenshotWithFallback(page, file, true),
        );
        const artifact = await availableArtifact(
          "screenshot",
          "image/png",
          file,
          `screenshots/${stepId}.png`,
          {
            classification: "public",
            capturePermit: permit,
          },
        );
        artifact.observation = {
          ...artifact.observation,
          ...observation,
          screenshotMode: fallback ? "viewport-fallback" : "full-page",
        };
        result.artifacts.push(artifact);
        setEvidenceStatus(result, "screenshot", "available");
      } catch (error) {
        result.evidenceFailures ??= [];
        result.evidenceFailures.push({ kind: "screenshot", error: errorMessage(error) });
        result.artifacts.push({
          id: randomUUID(),
          kind: "screenshot",
          availability: "failed",
          privacyClassification: "safe",
          failureProvenance: "executor",
          reasonCode: "SCREENSHOT_CAPTURE_FAILED",
          contentType: "image/png",
        });
        setEvidenceStatus(result, "screenshot", "failed", errorMessage(error));
      }
    }
  }
  if (evidence.includes("dom")) {
    if (
      collectors.get("dom")?.isCaptureSuppressed() ||
      (privacyGate && ["suppress", "quarantine"].includes(privacyGate.getDecision("dom")))
    ) {
      result.artifacts.push({
        id: randomUUID(),
        kind: "dom",
        availability: "destroyed",
        privacyClassification: "uncertain",
        failureProvenance: "privacy",
        reasonCode: "PRIVACY_GATE_CLOSED",
        contentType: "text/html",
        observation: { bytesDestroyed: true, reasonCode: "PRIVACY_GATE_CLOSED" },
      });
      setEvidenceStatus(result, "dom", "degraded", "Evidence suppressed by Privacy Gate");
    } else {
      try {
        const file = path.join(root, "dom", `${stepId}.html`);
        await writeFile(file, await sanitizedDomStructure(page), "utf8");
        const artifact = await availableArtifact("dom", "text/html", file, `dom/${stepId}.html`, {
          classification: "public",
          sanitation: {
            stage: "post_capture",
            method: "SecretRedactor.redact",
            attestedAt: new Date().toISOString(),
          },
        });
        if (observation) artifact.observation = { ...artifact.observation, ...observation };
        result.artifacts.push(artifact);
        setEvidenceStatus(result, "dom", "available");
      } catch (error) {
        result.evidenceFailures ??= [];
        result.evidenceFailures.push({ kind: "dom", error: errorMessage(error) });
        result.artifacts.push({
          id: randomUUID(),
          kind: "dom",
          availability: "failed",
          privacyClassification: "safe",
          failureProvenance: "executor",
          reasonCode: "DOM_CAPTURE_FAILED",
          contentType: "text/html",
        });
        setEvidenceStatus(result, "dom", "failed", errorMessage(error));
      }
    }
  }
  if (evidence.includes("network")) {
    if (
      collectors.get("network")?.isCaptureSuppressed() ||
      (privacyGate && ["suppress", "quarantine"].includes(privacyGate.getDecision("network")))
    ) {
      result.artifacts.push({
        id: randomUUID(),
        kind: "network",
        availability: "destroyed",
        privacyClassification: "uncertain",
        failureProvenance: "privacy",
        reasonCode: "PRIVACY_GATE_CLOSED",
        contentType: "application/json",
        observation: { bytesDestroyed: true, reasonCode: "PRIVACY_GATE_CLOSED" },
      });
      setEvidenceStatus(result, "network", "degraded", "Evidence suppressed by Privacy Gate");
    } else {
      try {
        await Promise.allSettled([...pendingNetworkBodies]);
        const file = path.join(root, "network", `${stepId}.json`);
        await writeJson(file, { requests: safeNetworkEvidence(networkRecords) });
        const artifact = await availableArtifact(
          "network",
          "application/json",
          file,
          `network/${stepId}.json`,
          {
            classification: "public",
            sanitation: {
              stage: "post_capture",
              method: "SecretRedactor.redactValue",
              attestedAt: new Date().toISOString(),
            },
          },
        );
        if (observation) artifact.observation = { ...artifact.observation, ...observation };
        result.artifacts.push(artifact);
        setEvidenceStatus(result, "network", "available");
      } catch (error) {
        result.evidenceFailures ??= [];
        result.evidenceFailures.push({ kind: "network", error: errorMessage(error) });
        result.artifacts.push({
          id: randomUUID(),
          kind: "network",
          availability: "failed",
          privacyClassification: "safe",
          failureProvenance: "executor",
          reasonCode: "NETWORK_CAPTURE_FAILED",
          contentType: "application/json",
        });
        setEvidenceStatus(result, "network", "failed", errorMessage(error));
      }
    }
  }
}

export async function captureFailureScreenshot(
  page: Page,
  root: string,
  stepId: string,
  result: StepExecutionResult,
  privacyGate?: VeilRuntimeCoordinator,
  collectors: ReadonlyMap<string, VeilChannelCollector> = new Map(),
  visualCapture?: VeilVisualCaptureAuthority,
  captureBinding?: () => CaptureBinding,
) {
  if (
    collectors.get("screenshot")?.isCaptureSuppressed() ||
    (privacyGate && privacyGate.getDecision("screenshot") !== "allow")
  )
    return;
  try {
    const file = path.join(root, "screenshots", `${stepId}.failure.png`);
    if (!visualCapture || !captureBinding) return;
    const binding = captureBinding();
    const { permit } = await visualCapture.issue(page, binding);
    await visualCapture.capture(page, permit, binding, () =>
      page.screenshot({ path: file, fullPage: true }).then(() => undefined),
    );
    result.artifacts.push(
      await availableArtifact(
        "screenshot",
        "image/png",
        file,
        `screenshots/${stepId}.failure.png`,
        { classification: "public", capturePermit: permit },
      ),
    );
  } catch {
    // Preserve the original test failure when screenshot capture also fails.
  }
}

export async function installVisualRedactionStyles(context: BrowserContext) {
  await context.addInitScript({ content: visualRedactionInitScript });
}

export async function captureScreenshotWithFallback(page: Page, file: string, fullPage: boolean) {
  if (!fullPage) {
    await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
    return false;
  }
  const dimensions = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  }));
  if (dimensions.width * dimensions.height <= 40_000_000) {
    try {
      await page.screenshot({ path: file, fullPage: true, timeout: 10_000 });
      return false;
    } catch {
      // Chromium can reject or stall on extremely complex pages despite modest dimensions.
    }
  }
  await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
  return true;
}

async function sanitizedDomStructure(page: Page): Promise<string> {
  return page.evaluate(() => {
    const source = document.documentElement;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script,style,noscript,template").forEach((element) => element.remove());
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
    const remove: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) remove.push(node);
    remove.forEach((node) => node.parentNode?.removeChild(node));
    clone.querySelectorAll("*").forEach((element) => {
      const inputType = element instanceof HTMLInputElement ? element.type : undefined;
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (inputType) element.setAttribute("type", safeInputType(inputType));
    });
    return `<!doctype html>${clone.outerHTML}`;

    function safeInputType(value: string) {
      return [
        "button",
        "checkbox",
        "color",
        "date",
        "file",
        "hidden",
        "image",
        "month",
        "number",
        "password",
        "radio",
        "range",
        "reset",
        "submit",
        "time",
        "week",
      ].includes(value)
        ? value
        : "text";
    }
  });
}

function safeNetworkEvidence(records: Array<Record<string, unknown>>) {
  return records.map((record) => ({
    type: record.type === "response" ? "response" : "request",
    occurredAt: typeof record.occurredAt === "string" ? record.occurredAt : undefined,
    method: typeof record.method === "string" ? record.method : undefined,
    resourceType: typeof record.resourceType === "string" ? record.resourceType : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    responseBodyOmitted:
      record.responseBody === undefined ? record.responseBodyOmitted : "privacy_metadata_only",
  }));
}

function setEvidenceStatus(
  result: StepExecutionResult,
  kind: "screenshot" | "dom" | "network",
  status: "available" | "degraded" | "failed",
  error?: string,
) {
  const entry = result.evidence.find((item) => item.kind === kind);
  if (entry) Object.assign(entry, { status }, error ? { error } : {});
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
