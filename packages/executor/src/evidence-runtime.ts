import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  capturePraxisSanitizedStructure,
  capturePraxisScreenshot,
  installPraxisInitScript,
  measurePraxisDocument,
  observeAndMaskPraxisVisualRegions,
  visualRedactionInitScript,
} from "@scry/praxis";
import type { SecretRedactor } from "@scry/policy";
import {
  type VeilChannelCollector,
  type VeilRuntimeCoordinator,
  VeilVisualCaptureError,
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

const VISUAL_CAPTURE_STABILIZATION_ATTEMPTS = 3;

export async function captureWithStableVisualPermit<T>(input: {
  visualCapture: VeilVisualCaptureAuthority;
  captureBinding: () => CaptureBinding;
  observe: () => Promise<Awaited<ReturnType<typeof observeAndMaskPraxisVisualRegions>>>;
  capture: () => Promise<T>;
}) {
  let lastDocumentChanged: VeilVisualCaptureError | undefined;

  for (let attempt = 1; attempt <= VISUAL_CAPTURE_STABILIZATION_ATTEMPTS; attempt += 1) {
    const binding = input.captureBinding();
    const observation = await input.observe();
    const { permit } = input.visualCapture.issue(observation, binding);
    const validatedObservation = await input.observe();

    try {
      const result = await input.visualCapture.capture(
        validatedObservation,
        permit,
        binding,
        input.capture,
      );

      return {
        permit,
        observation: validatedObservation,
        result,
        stabilizationAttempts: attempt,
      };
    } catch (error) {
      if (
        !(error instanceof VeilVisualCaptureError) ||
        error.code !== "VEIL_CAPTURE_DOCUMENT_CHANGED"
      ) {
        throw error;
      }

      lastDocumentChanged = error;

      if (attempt === VISUAL_CAPTURE_STABILIZATION_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw lastDocumentChanged ?? new Error("VEIL_VISUAL_CAPTURE_STABILIZATION_EXHAUSTED");
}

export async function captureRequestedEvidence(
  page: Page,
  root: string,
  stepId: string,
  evidence: Array<"screenshot" | "dom" | "network">,
  result: StepExecutionResult,
  networkRecords: Array<Record<string, unknown>>,
  redactor: SecretRedactor,
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
        const {
          permit,
          observation,
          result: fallback,
        } = await captureWithStableVisualPermit({
          visualCapture,
          captureBinding,
          observe: () => observeAndMaskPraxisVisualRegions(page),
          capture: () => captureScreenshotWithFallback(page, file, true),
        });
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
        await writeFile(file, await sanitizedDomStructure(page, redactor), "utf8");
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
    const { permit } = await captureWithStableVisualPermit({
      visualCapture,
      captureBinding,
      observe: () => observeAndMaskPraxisVisualRegions(page),
      capture: () => capturePraxisScreenshot(page, file, { fullPage: true }),
    });
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
  await installPraxisInitScript(context, visualRedactionInitScript);
}

export async function captureScreenshotWithFallback(page: Page, file: string, fullPage: boolean) {
  if (!fullPage) {
    await capturePraxisScreenshot(page, file, { fullPage: false, timeoutMs: 10_000 });
    return false;
  }
  const dimensions = await measurePraxisDocument(page);
  if (dimensions.width * dimensions.height <= 40_000_000) {
    try {
      await capturePraxisScreenshot(page, file, { fullPage: true, timeoutMs: 10_000 });
      return false;
    } catch {
      // Chromium can reject or stall on extremely complex pages despite modest dimensions.
    }
  }
  await capturePraxisScreenshot(page, file, { fullPage: false, timeoutMs: 10_000 });
  return true;
}

export async function sanitizedDomStructure(
  page: Page,
  redactor: Pick<SecretRedactor, "redact">,
): Promise<string> {
  const structure = await capturePraxisSanitizedStructure(page);
  return redactor.redact(structure);
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
