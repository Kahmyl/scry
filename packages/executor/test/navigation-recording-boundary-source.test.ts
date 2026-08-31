import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("navigation recording boundary source contract", () => {
  it("stops recording before action dispatch and qualifies before resume", async () => {
    const executor = await readFile(new URL("../src/executor.ts", import.meta.url), "utf8");

    const start = executor.indexOf("const transitionOperationId =");
    const end = executor.indexOf('result.action = { status: "passed" };', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const boundary = executor.slice(start, end);

    const begin = boundary.indexOf("await recording.beginDocumentTransition");
    const dispatch = boundary.indexOf("await executeAction(");
    const qualify = boundary.indexOf("await observeAndMaskPraxisVisualRegions(page)");
    const resume = boundary.indexOf("await recording.completeDocumentTransition(page)");

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(begin);
    expect(qualify).toBeGreaterThan(dispatch);
    expect(resume).toBeGreaterThan(qualify);

    expect(boundary).toContain('failDocumentTransition("DOCUMENT_TRANSITION_ACTION_FAILED")');
    expect(boundary).toContain('"DOCUMENT_TRANSITION_QUALIFICATION_FAILED"');
  });

  it("carries canonical operation identity and expected navigation from the kernel", async () => {
    const kernel = await readFile(new URL("../src/execution-kernel.ts", import.meta.url), "utf8");

    expect(kernel).toContain("recordingOperationId: request.operationId");
    expect(kernel).toMatch(
      /input\.action\.type === "navigate"\s*\|\|[\s\S]*?expectedEffect\.type === "navigation"/,
    );
    expect(kernel).toContain("settleExpectedEffectBeforeCapture");
  });
});
