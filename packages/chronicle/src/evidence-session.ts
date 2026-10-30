import { writeFile } from "node:fs/promises";
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

export class ChronicleEvidenceSession implements ChronicleEvidenceSessionPort {
  #recording?: ChronicleRecording;
  constructor(
    private readonly scope: ChronicleEvidenceScope,
    private readonly store: AuthenticatedEvidenceStore<Record<string, unknown>>,
    private readonly renderer: ChronicleReplayRendererPort,
  ) {}

  createRecording(protection: RecordingProtectionPort): ChronicleRecording {
    if (this.#recording) throw new Error("SCRY_BROWSER_RECORDER_ALREADY_EXISTS");
    this.#recording = new ChronicleRecording(this.store, protection);
    return this.#recording;
  }

  async prepareClosure(): Promise<void> {
    await this.scope.admission.run(async () => undefined);
    const diagnostics = await this.requiredRecording().flush();
    if (diagnostics.errors.length)
      throw new Error(`SCRY_BROWSER_RECORDER_FAILED:${diagnostics.errors[0]?.code ?? "unknown"}`);
  }

  async seal(options: ChronicleSealOptions): Promise<EvidenceCompletion> {
    await this.prepareClosure();
    const recording = this.requiredRecording();
    const verified = await this.scope.admission.run(() => this.store.verify());
    if (!verified.complete || !verified.lastDigest || verified.chunks === 0)
      throw new Error("SCRY_BROWSER_EVIDENCE_INCOMPLETE");
    let videoObjectKey: string | undefined;
    if (options.renderVideo) {
      const ledgerPath = path.join(this.scope.root, "actions.jsonl");
      const ledger = await options.actionLedger();
      await this.scope.admission.run(() =>
        writeFile(ledgerPath, `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
          mode: 0o600,
        }),
      );
      const publication = await renderSanitizedReplay({
        renderer: this.renderer,
        admission: this.scope.admission,
        events: verified.events,
        ledgerPath,
        outputDirectory: path.join(this.scope.root, "rendered"),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
      videoObjectKey = `local://${publication.videoPath}`;
    }
    recording.assertActive();
    return {
      sessionId: this.scope.sessionId,
      runId: this.scope.runId,
      chainHead: verified.lastDigest,
      chunkCount: verified.chunks,
      totalBytes: verified.storedBytes,
      replayObjectKey: `local://${path.join(this.scope.root, "evidence")}`,
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
    return new ChronicleEvidenceSession(scope, store, this.renderer);
  }
}
