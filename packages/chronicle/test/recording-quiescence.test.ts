import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EvidenceCipher } from "@scry/veil";
import {
  ChronicleRecording,
  AuthenticatedEvidenceStore,
  ChronicleEvidenceSession,
} from "../src/index.js";
import type { ChronicleReplayRendererPort } from "@scry/contracts";
import { memoryAdmission } from "./fixtures/evidence-admission.js";

const protection = { snapshot: vi.fn(() => (value: unknown) => value) };
function fixture() {
  const store = {
    nextSequence: 0,
    append: vi.fn(async (_value: unknown): Promise<number> => 0),
    flush: vi.fn(async (): Promise<void> => undefined),
    discardPending: vi.fn(() => undefined),
  };
  return { store, recording: new ChronicleRecording(store, protection) };
}
describe("recording queue quiescence", () => {
  async function sessionFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "scry-recording-closure-"));
    const scope = {
      root,
      runId: "00000000-0000-4000-8000-000000000301",
      sessionId: "fixture-session",
      protection: new EvidenceCipher(randomBytes(32)),
      admission: memoryAdmission().admission,
      maxSessionBytes: 1024 * 1024,
    };
    const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
      directory: path.join(root, "evidence"),
      scopeId: scope.sessionId,
      ...scope,
    }).initialize();
    const session = new ChronicleEvidenceSession(scope, store, {
      render: vi.fn<ChronicleReplayRendererPort["render"]>(),
    });
    await session.startCapture();
    return { root, store, session, recording: session.createRecording(protection) };
  }
  it("does not create a second recording owner for the same store lifecycle", async () => {
    const { session } = await sessionFixture();
    expect(() => session.createRecording(protection)).toThrow("RECORDER_ALREADY_EXISTS");
  });
  it("preserves durable historical chunks and refuses closure after abandonment", async () => {
    const { root, session, recording } = await sessionFixture();
    recording.receive('{"visible":"fixture"}');
    await recording.flush();
    const directory = path.join(root, "evidence");
    const names = await readdir(directory, { recursive: true });
    const files = names.filter((name) => name.endsWith(".json"));
    const before = await Promise.all(files.map((name) => readFile(path.join(directory, name))));
    await recording.abort();
    await expect(
      session.seal({ renderVideo: false, actionLedger: async () => [] }),
    ).rejects.toThrow("RECORDER_CLOSED");
    expect(await readdir(directory, { recursive: true })).toEqual(names);
    expect(await Promise.all(files.map((name) => readFile(path.join(directory, name))))).toEqual(
      before,
    );
  });
  it("does not return completion when abandonment happens during sealing verification", async () => {
    const { store, session, recording } = await sessionFixture();
    recording.receive('{"visible":"fixture"}');
    await recording.flush();
    await session.stopCapture({ browserStopped: true, recordingDrained: true });
    let finish!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    const verify = store.verify.bind(store);
    const delayed = vi.spyOn(store, "verify").mockImplementationOnce(async () => {
      enter();
      await gate;
      return verify();
    });
    const sealing = session.seal({ renderVideo: false, actionLedger: async () => [] }),
      outcome = sealing.catch((error) => error);
    try {
      await entered;
      await recording.abort();
      finish();
      expect(await outcome).toMatchObject({ message: "SCRY_BROWSER_RECORDER_CLOSED" });
    } finally {
      finish();
      await outcome;
      delayed.mockRestore();
    }
  });
  it("orders an explicit flush before later appends and flushes", async () => {
    const { store, recording } = fixture(),
      order: string[] = [];
    let finish!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    store.append.mockImplementation(async (value) => {
      order.push(`append:${(value as { n: number }).n}`);
      return 0;
    });
    store.flush.mockImplementationOnce(async () => {
      order.push("flush:start");
      enter();
      await gate;
      order.push("flush:end");
    });
    store.flush.mockImplementation(async () => {
      order.push("flush:next");
    });
    recording.receive('{"n":1}');
    const first = recording.flush();
    await entered;
    recording.receive('{"n":2}');
    const second = recording.flush();
    try {
      await Promise.resolve();
    } finally {
      finish();
      await Promise.all([first, second]);
    }
    expect(order).toEqual(["append:1", "flush:start", "flush:end", "append:2", "flush:next"]);
  });
  it("abandons queued events without beginning a store append or flush", async () => {
    const { store, recording } = fixture();
    recording.receive('{"n":1}');
    await recording.abort();
    expect(store.append).not.toHaveBeenCalled();
    expect(store.flush).not.toHaveBeenCalled();
    expect(store.discardPending).toHaveBeenCalledTimes(1);
    await expect(recording.flush()).rejects.toThrow("RECORDER_CLOSED");
  });
  it("waits for an in-flight append, then skips later events and discards pending data", async () => {
    const { store, recording } = fixture();
    let finish!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    store.append.mockImplementationOnce(async () => {
      enter();
      await gate;
      return 0;
    });
    recording.receive('{"n":1}');
    await entered;
    recording.receive('{"n":2}');
    let settled = false;
    let aborted: Promise<void> | undefined;
    try {
      aborted = recording.abort().then(() => {
        settled = true;
      });
      recording.receive('{"n":3}');
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(store.discardPending).not.toHaveBeenCalled();
    } finally {
      finish();
      await aborted;
    }
    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.flush).not.toHaveBeenCalled();
    expect(store.discardPending).toHaveBeenCalledTimes(1);
  });
  it("waits for an in-flight flush and cannot return valid closure after abandonment", async () => {
    const { store, recording } = fixture();
    let finish!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    store.flush.mockImplementationOnce(async () => {
      enter();
      await gate;
    });
    const flushing = recording.flush(),
      observed = flushing.catch((error) => error);
    await entered;
    let settled = false;
    let aborted: Promise<void> | undefined;
    try {
      aborted = recording.abort().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      finish();
      await aborted;
    }
    expect(await observed).toMatchObject({ message: "SCRY_BROWSER_RECORDER_CLOSED" });
    expect(store.discardPending).toHaveBeenCalledTimes(1);
  });
  it("shares permanent abandonment and ignores late receipt before protection work", async () => {
    const { store, recording } = fixture();
    await Promise.all([recording.abort(), recording.abort()]);
    const snapshots = protection.snapshot.mock.calls.length;
    recording.receive('{"late":true}');
    expect(protection.snapshot.mock.calls.length).toBe(snapshots);
    expect(store.append).not.toHaveBeenCalled();
    expect(store.discardPending).toHaveBeenCalledTimes(1);
  });
  it("retains an unconfirmed discard failure instead of claiming the queue is drained", async () => {
    const { store, recording } = fixture();
    store.discardPending.mockImplementationOnce(() => {
      throw new Error("discard_unconfirmed");
    });
    await expect(recording.abort()).rejects.toThrow("discard_unconfirmed");
    await expect(recording.abort()).rejects.toThrow("discard_unconfirmed");
    expect(store.discardPending).toHaveBeenCalledTimes(1);
  });
  it("settles failed in-flight work without flushing buffered evidence during abandonment", async () => {
    const { store, recording } = fixture();
    let fail!: () => void, enter!: () => void;
    const gate = new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error("fixture_write_failed"));
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    store.append.mockImplementationOnce(async () => {
      enter();
      await gate;
      return 0;
    });
    recording.receive('{"n":1}');
    await entered;
    let aborted: Promise<void> | undefined;
    try {
      aborted = recording.abort();
    } finally {
      fail();
      await aborted;
    }
    expect(store.flush).not.toHaveBeenCalled();
    expect(store.discardPending).toHaveBeenCalledTimes(1);
  });
  it("discards actual unflushed store data without publishing a new chunk", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scry-recording-abandon-"));
    const store = await new AuthenticatedEvidenceStore({
      directory,
      runId: "00000000-0000-4000-8000-000000000301",
      scopeId: "fixture",
      protection: new EvidenceCipher(randomBytes(32)),
      admission: memoryAdmission("fixture").admission,
    }).initialize();
    const appended = vi.spyOn(store, "append"),
      recording = new ChronicleRecording(store, protection);
    recording.receive('{"visible":"fixture"}');
    await vi.waitFor(() => expect(appended).toHaveBeenCalledTimes(1));
    const before = await readdir(directory);
    await recording.abort();
    expect(await readdir(directory)).toEqual(before);
    expect((await store.verify()).events).toEqual([]);
    expect(store.nextSequence).toBe(0);
  });
});
