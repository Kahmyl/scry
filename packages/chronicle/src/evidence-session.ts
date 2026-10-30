import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ChronicleReplayRendererPort,
  ChronicleEvidenceScope,
  ChronicleEvidencePort,
  ChronicleEvidenceSessionPort,
  ChronicleSealOptions,
  EvidenceCompletion,
  RecordingProtectionPort,
} from "@scry/contracts";
import { AuthenticatedEvidenceStore } from "./authenticated-evidence-store.js";
import { ChronicleRecording } from "./recording.js";
import { renderSanitizedReplay } from "./offline-replay.js";
import { durableWrite } from "./durable-file.js";

export class ChronicleEvidenceSession implements ChronicleEvidenceSessionPort {
  #recording?: ChronicleRecording;
  #sealing?: Promise<EvidenceCompletion>;
  constructor(
    private readonly scope: ChronicleEvidenceScope,
    private readonly store: AuthenticatedEvidenceStore<Record<string, unknown>>,
    private readonly renderer: ChronicleReplayRendererPort,
  ) {}

  createRecording(protection: RecordingProtectionPort): ChronicleRecording {
    if (this.scope.purpose === "closure") throw new Error("SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED");
    if (this.#recording) throw new Error("SCRY_BROWSER_RECORDER_ALREADY_EXISTS");
    this.#recording = new ChronicleRecording(this.store, protection);
    return this.#recording;
  }

  startCapture(): Promise<void> {
    return this.scope.admission.startCapture();
  }
  async stopCapture(receipt: { browserStopped: true; recordingDrained: true }): Promise<void> {
    const diagnostics = await this.requiredRecording().flush();
    const snapshot = await this.scope.admission.readStream();
    const recordingComplete =
      diagnostics.errors.length === 0 &&
      diagnostics.diagnostics.length === 0 &&
      diagnostics.receivedEvents === (snapshot.chunks.at(-1)?.lastSequence ?? -1) + 1;
    await this.scope.admission.stopCapture({ ...receipt, recordingComplete });
  }

  async prepareClosure(): Promise<void> {
    await this.scope.admission.checkpoint();
    if (this.scope.purpose === "closure") return;
    const diagnostics = await this.requiredRecording().flush();
    if (diagnostics.errors.length)
      throw new Error(`SCRY_BROWSER_RECORDER_FAILED:${diagnostics.errors[0]?.code ?? "unknown"}`);
  }

  async seal(options: ChronicleSealOptions): Promise<EvidenceCompletion> {
    if (this.#sealing) return this.#sealing;
    await this.prepareClosure();
    const snapshot = await this.scope.admission.readStream();
    if (
      !snapshot.captureStoppedAt &&
      !(
        this.scope.purpose === "closure" &&
        (snapshot.interruptions > 0 || !snapshot.captureStartedAt)
      )
    )
      throw new Error("SCRY_BROWSER_EVIDENCE_STOP_UNCONFIRMED");
    // Install single-flight only after preconditions pass. An early seal request
    // cannot permanently poison a later legitimate stopped-capture closure.
    this.#sealing ??= this.publish(options);
    return this.#sealing;
  }

  private async publish(options: ChronicleSealOptions): Promise<EvidenceCompletion> {
    const verified = await this.store.verify();
    const snapshot = await this.scope.admission.readStream();
    const state =
      snapshot.interruptions === 0 &&
      snapshot.captureComplete === true &&
      snapshot.captureStartedAt &&
      snapshot.captureStoppedAt &&
      verified.chunks > 0
        ? "complete"
        : "incomplete";
    const publicationRoot = path.join(
      this.scope.root,
      "publications",
      String(this.scope.admission.ownerGeneration),
      randomUUID(),
    );
    const manifestPath = path.join(publicationRoot, "evidence.json");
    await durableWrite(
      manifestPath,
      JSON.stringify({
        streamId: snapshot.id,
        state,
        chainHead: snapshot.chainHead,
        chunkCount: snapshot.chunkCount,
        totalBytes: snapshot.totalBytes,
        interruptions: snapshot.interruptions,
        chunks: snapshot.chunks,
      }),
    );
    let videoObjectKey: string | undefined;
    if (options.renderVideo && verified.chunks > 0) {
      const ledgerPath = path.join(publicationRoot, "actions.jsonl");
      const ledger = await options.actionLedger();
      this.scope.admission.assertActive();
      await durableWrite(
        ledgerPath,
        `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      const publication = await renderSanitizedReplay({
        renderer: this.renderer,
        admission: this.scope.admission,
        events: verified.events,
        ledgerPath,
        outputDirectory: path.join(publicationRoot, "rendered"),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
      videoObjectKey = `local://${publication.videoPath}`;
    }
    this.#recording?.assertActive();
    this.scope.admission.assertActive();
    return {
      sessionId: this.scope.sessionId,
      runId: this.scope.runId,
      state,
      chainHead: verified.lastDigest,
      chunkCount: verified.chunks,
      totalBytes: verified.storedBytes,
      replayObjectKey: `local://${manifestPath}`,
      ...(videoObjectKey ? { videoObjectKey } : {}),
    };
  }

  private requiredRecording(): ChronicleRecording {
    if (!this.#recording) throw new Error("SCRY_BROWSER_RECORDER_FAILED:recorder_missing");
    return this.#recording;
  }
}

export class ChronicleEvidenceService implements ChronicleEvidencePort {
  constructor(private readonly renderer: ChronicleReplayRendererPort) {}

  async openSession(scope: ChronicleEvidenceScope): Promise<ChronicleEvidenceSession> {
    const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
      directory: path.join(scope.root, "evidence"),
      runId: scope.runId,
      scopeId: scope.sessionId,
      protection: scope.protection,
      admission: scope.admission,
      maxSessionBytes: scope.maxSessionBytes,
    }).initialize();
    if (scope.purpose !== "closure" && (await scope.admission.readStream()).captureStoppedAt)
      throw new Error("SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED");
    return new ChronicleEvidenceSession(scope, store, this.renderer);
  }
}
