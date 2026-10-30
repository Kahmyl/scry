import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ChronicleReplayRendererPort,
  ChronicleEvidenceScope,
  ChronicleEvidencePort,
  ChronicleEvidenceSessionPort,
  ChronicleSealOptions,
  EvidenceCompletion,
  EvidenceClosureIssue,
  RecordingProtectionPort,
} from "@scry/contracts";
import { AuthenticatedEvidenceStore } from "./authenticated-evidence-store.js";
import { ChronicleRecording } from "./recording.js";
import { renderSanitizedReplay } from "./offline-replay.js";
import { durableWrite } from "./durable-file.js";
import { AdmittedEvidenceReader } from "./admitted-evidence-reader.js";
import {
  EvidenceArtifactFailure,
  isArtifactFilesystemFailure,
} from "./evidence-artifact-failure.js";

export class ChronicleEvidenceSession implements ChronicleEvidenceSessionPort {
  #recording?: ChronicleRecording;
  #sealing?: Promise<EvidenceCompletion>;
  constructor(
    private readonly scope: ChronicleEvidenceScope,
    private readonly store:
      | AuthenticatedEvidenceStore<Record<string, unknown>>
      | AdmittedEvidenceReader<Record<string, unknown>>,
    private readonly renderer: ChronicleReplayRendererPort,
  ) {}

  createRecording(protection: RecordingProtectionPort): ChronicleRecording {
    if (this.scope.purpose === "closure" || !("append" in this.store))
      throw new Error("SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED");
    if (this.#recording) throw new Error("SCRY_BROWSER_RECORDER_ALREADY_EXISTS");
    this.#recording = new ChronicleRecording(this.store, protection);
    return this.#recording;
  }

  startCapture(): Promise<void> {
    if (this.scope.purpose === "closure")
      return Promise.reject(new Error("SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED"));
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
    try {
      return await this.publishVerified(options);
    } catch (error) {
      if (!options.failureClosure || !(error instanceof EvidenceArtifactFailure)) throw error;
      // Only explicit failure closure can retain this exact unavailable prefix.
      // A database/owner/command failure is never caught as an artifact decision.
      await this.scope.admission.checkpoint();
      this.scope.admission.assertActive();
      const s = await this.scope.admission.readStream();
      return {
        sessionId: this.scope.sessionId,
        runId: this.scope.runId,
        state: "incomplete",
        chainHead: s.chainHead,
        chunkCount: s.chunkCount,
        totalBytes: s.totalBytes,
        issue: error.issue,
      };
    }
  }

  private async writePublication(filename: string, contents: string): Promise<void> {
    this.scope.admission.assertActive();
    try {
      await durableWrite(filename, contents);
    } catch (error) {
      if (isArtifactFilesystemFailure(error))
        throw new EvidenceArtifactFailure("publication_unavailable");
      throw error;
    }
    this.scope.admission.assertActive();
  }

  private async publishVerified(options: ChronicleSealOptions): Promise<EvidenceCompletion> {
    const verified = await this.store.verify();
    const snapshot = await this.scope.admission.readStream();
    let state: EvidenceCompletion["state"] =
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
    let videoObjectKey: string | undefined;
    let issue: EvidenceClosureIssue | undefined;
    if (options.renderVideo && verified.chunks > 0) {
      const ledgerPath = path.join(publicationRoot, "actions.jsonl");
      const ledger = await options.actionLedger();
      this.scope.admission.assertActive();
      await this.writePublication(
        ledgerPath,
        `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      try {
        const publication = await renderSanitizedReplay({
          renderer: this.renderer,
          admission: this.scope.admission,
          events: verified.events,
          ledgerPath,
          outputDirectory: path.join(publicationRoot, "rendered"),
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        });
        videoObjectKey = `local://${publication.videoPath}`;
      } catch (error) {
        if (
          !options.failureClosure ||
          !(error instanceof EvidenceArtifactFailure) ||
          error.issue !== "video_unavailable"
        )
          throw error;
        await this.scope.admission.checkpoint();
        issue = "video_unavailable";
        state = "incomplete";
      }
    }
    await this.writePublication(
      manifestPath,
      JSON.stringify({
        streamId: snapshot.id,
        state,
        chainHead: snapshot.chainHead,
        chunkCount: snapshot.chunkCount,
        totalBytes: snapshot.totalBytes,
        interruptions: snapshot.interruptions,
        chunks: snapshot.chunks,
        ...(issue ? { issue } : {}),
      }),
    );
    this.#recording?.assertActive();
    this.scope.admission.assertActive();
    const facts = {
      sessionId: this.scope.sessionId,
      runId: this.scope.runId,
      chainHead: verified.lastDigest,
      chunkCount: verified.chunks,
      totalBytes: verified.storedBytes,
      replayObjectKey: `local://${manifestPath}`,
      ...(videoObjectKey ? { videoObjectKey } : {}),
    };
    if (state === "complete") return { ...facts, state };
    return { ...facts, state: "incomplete", ...(issue ? { issue } : {}) };
  }

  private requiredRecording(): ChronicleRecording {
    if (!this.#recording) throw new Error("SCRY_BROWSER_RECORDER_FAILED:recorder_missing");
    return this.#recording;
  }
}

export class ChronicleEvidenceService implements ChronicleEvidencePort {
  constructor(private readonly renderer: ChronicleReplayRendererPort) {}

  async openSession(scope: ChronicleEvidenceScope): Promise<ChronicleEvidenceSession> {
    if (scope.purpose === "closure") {
      await scope.admission.openStream(scope.runId);
      return new ChronicleEvidenceSession(
        scope,
        new AdmittedEvidenceReader({
          directory: path.join(scope.root, "evidence"),
          runId: scope.runId,
          scopeId: scope.sessionId,
          protection: scope.protection,
          admission: scope.admission,
        }),
        this.renderer,
      );
    }
    const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
      directory: path.join(scope.root, "evidence"),
      runId: scope.runId,
      scopeId: scope.sessionId,
      protection: scope.protection,
      admission: scope.admission,
      maxSessionBytes: scope.maxSessionBytes,
    }).initialize();
    if ((await scope.admission.readStream()).captureStoppedAt)
      throw new Error("SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED");
    return new ChronicleEvidenceSession(scope, store, this.renderer);
  }
}
