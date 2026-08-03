import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SecretRedactor } from "@scry/policy";
import { afterEach, describe, expect, it } from "vitest";

import { ExecutionEventStream } from "../src/execution-events.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStream(isSuppressed: () => boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scry-events-"));
  temporaryDirectories.push(directory);
  const eventPath = path.join(directory, "events.jsonl");
  const redactor = new SecretRedactor();
  redactor.add("private-value");
  const observedSequences: number[] = [];
  const stream = new ExecutionEventStream({
    eventPath,
    runId: "run-1",
    attemptId: "attempt-1",
    redactor,
    isSuppressed,
    onEvent: async (event) => {
      observedSequences.push(event.sequence);
    },
  });
  return { eventPath, observedSequences, stream };
}

describe("ExecutionEventStream", () => {
  it("serializes concurrent writes in sequence order and redacts payloads", async () => {
    const { eventPath, observedSequences, stream } = await createStream(() => false);

    await Promise.all([
      stream.emit("step.started", { value: "private-value" }),
      stream.emit("step.passed", { ordinal: 2 }),
    ]);

    const events = (await readFile(eventPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; payload: unknown });
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(observedSequences).toEqual([1, 2]);
    expect(events[0]!.payload).toEqual({ value: "[REDACTED]" });
  });

  it("suppresses ordinary events while retaining privacy lifecycle events", async () => {
    const { eventPath, stream } = await createStream(() => true);

    await stream.emit("step.started", { stepId: "hidden" });
    await stream.emit("privacy.state_changed", { state: "isolated" });

    const events = (await readFile(eventPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; type: string });
    expect(events).toEqual([
      expect.objectContaining({ sequence: 1, type: "privacy.state_changed" }),
    ]);
  });
});
