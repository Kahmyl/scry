import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SecretRedactor } from "@scry/policy";
import { openPraxisBrowserSession } from "@scry/praxis";
import { expect, it } from "vitest";
import { attachNetworkCapture } from "../src/runtime-diagnostics.js";
import { captureRequestedEvidence } from "../src/evidence-runtime.js";
import type { StepExecutionResult } from "../src/types.js";

it("publishes network metadata without waiting for an unfinished error body", async () => {
  const secret = "unregistered-response-body-canary";
  const server = createServer((request, response) => {
    if (request.url === "/stream") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.write(secret);
      return; // Deliberately never end the error response.
    }
    response.end("<h1>Ready</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_UNAVAILABLE");
  const root = await mkdtemp(path.join(tmpdir(), "network-evidence-"));
  const session = await openPraxisBrowserSession({ headless: true, browserChannel: "chrome" });
  let capture: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const records: Array<Record<string, unknown>> = [];
    const redactor = new SecretRedactor();
    attachNetworkCapture(session.page, records, redactor);
    await session.page.goto(`http://127.0.0.1:${address.port}`);
    await session.page.evaluate(async () => {
      await fetch("/stream");
    });
    await mkdir(path.join(root, "network"));
    const result: StepExecutionResult = {
      id: "stream",
      title: "Capture metadata",
      status: "unevaluated",
      assertions: [],
      action: { status: "passed" },
      artifacts: [],
      evidence: [],
    };
    capture = captureRequestedEvidence(
      session.page,
      root,
      "stream",
      ["network"],
      result,
      records,
      redactor,
    );
    const completed = await Promise.race([
      capture.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    expect(completed).toBe(true);
    expect(session.page.isClosed()).toBe(false);
    const evidence = await readFile(path.join(root, "network", "stream.json"), "utf8");
    expect(evidence).not.toContain(secret);
    expect(JSON.parse(evidence).requests).toContainEqual(
      expect.objectContaining({
        type: "response",
        status: 500,
        responseBodyOmitted: "privacy_metadata_only",
      }),
    );
    expect(JSON.stringify(records)).not.toContain(secret);
  } finally {
    if (timer) clearTimeout(timer);
    await session.browser.close();
    await capture;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
