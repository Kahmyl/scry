import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserCommitIntent, BrowserEffectTruth } from "@scry/contracts";
import { browserCommitIntentSchema, browserEffectTruthSchema } from "@scry/contracts";
import { durableAppend, ensurePrivateDirectory, readJsonLines } from "./durable-file.js";
import { SensitiveValueClassifier } from "@scry/veil";

type EffectEventType =
  | "admitted"
  | "dispatch_started"
  | "provider_response"
  | "capture_durable"
  | "published"
  | "publication_failed"
  | "applied"
  | "not_applied"
  | "unknown";

interface EffectEvent {
  sequence: number;
  at: string;
  effectId: string;
  idempotencyKey: string;
  type: EffectEventType;
  intent?: BrowserCommitIntent;
  responseStatus?: number;
  captureId?: string;
  reason?: string;
}

export interface EffectObservation {
  effectId: string;
  idempotencyKey: string;
  truth: BrowserEffectTruth;
  responseStatus?: number;
  captureId?: string;
  reason?: string;
}

export interface EffectAdmission {
  effectId: string;
  replay: boolean;
  observation: EffectObservation;
}

function eventsFor(events: readonly EffectEvent[], effectId: string): EffectEvent[] {
  return events.filter((event) => event.effectId === effectId);
}

export class EffectLedger {
  readonly #ledgerPath: string;
  readonly #classifier: SensitiveValueClassifier;
  #events: EffectEvent[] = [];
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { directory: string; classifier?: SensitiveValueClassifier }) {
    this.#ledgerPath = path.join(options.directory, "effect-ledger.jsonl");
    this.#classifier = options.classifier ?? new SensitiveValueClassifier();
  }

  async initialize(): Promise<this> {
    await ensurePrivateDirectory(path.dirname(this.#ledgerPath));
    this.#events = await readJsonLines<EffectEvent>(this.#ledgerPath);
    for (let index = 0; index < this.#events.length; index += 1) {
      if (this.#events[index]?.sequence !== index)
        throw new Error("effect_ledger_sequence_invalid");
    }
    return this;
  }

  async admit(rawIntent: BrowserCommitIntent): Promise<EffectAdmission> {
    const parsedIntent = browserCommitIntentSchema.parse(rawIntent);
    const intent: BrowserCommitIntent = {
      ...parsedIntent,
      intentSummary: this.#classifier.sanitize(parsedIntent.intentSummary),
    };
    return this.#serial(async () => {
      const existing = this.#events.find(
        (event) => event.type === "admitted" && event.idempotencyKey === intent.idempotencyKey,
      );
      if (existing) {
        if (JSON.stringify(existing.intent) !== JSON.stringify(intent))
          throw new Error("effect_idempotency_conflict");
        return {
          effectId: existing.effectId,
          replay: true,
          observation: this.observe(existing.effectId),
        };
      }

      const blocking = this.observations().find(
        ({ truth }) => truth.outcome === "pending" || truth.outcome === "unknown",
      );
      if (blocking) throw new Error(`effect_unresolved:${blocking.effectId}`);

      const effectId = randomUUID();
      await this.#append({
        effectId,
        idempotencyKey: intent.idempotencyKey,
        type: "admitted",
        intent,
      });
      return { effectId, replay: false, observation: this.observe(effectId) };
    });
  }

  async markDispatchStarted(effectId: string): Promise<EffectObservation> {
    return this.#transition(effectId, "dispatch_started", ["admitted"]);
  }

  async markProviderResponse(effectId: string, responseStatus: number): Promise<EffectObservation> {
    if (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599) {
      throw new Error("effect_response_status_invalid");
    }
    return this.#transition(effectId, "provider_response", ["dispatch_started"], {
      responseStatus,
    });
  }

  async markCaptureDurable(effectId: string, captureId: string): Promise<EffectObservation> {
    return this.#transition(effectId, "capture_durable", ["provider_response"], { captureId });
  }

  async markPublished(effectId: string): Promise<EffectObservation> {
    return this.#transition(effectId, "published", ["capture_durable"]);
  }

  async markApplied(effectId: string, reason: string): Promise<EffectObservation> {
    return this.#transition(effectId, "applied", ["provider_response"], { reason });
  }

  async markPublicationFailed(effectId: string, reason: string): Promise<EffectObservation> {
    return this.#transition(effectId, "publication_failed", ["capture_durable"], { reason });
  }

  async markNotApplied(effectId: string, reason: string): Promise<EffectObservation> {
    return this.#serial(async () => {
      const history = eventsFor(this.#events, effectId);
      const admission = history.find((event) => event.type === "admitted");
      if (!admission) throw new Error("effect_unknown");
      const existing = history.find((event) => event.type === "not_applied");
      if (existing) return this.observe(effectId);
      const dispatchStarted = history.some((event) => event.type === "dispatch_started");
      const responseObserved = history.some((event) => event.type === "provider_response");
      if (dispatchStarted && !responseObserved) throw new Error("effect_not_applied_unproven");
      if (history.some((event) => ["applied", "unknown", "published"].includes(event.type))) {
        throw new Error(`effect_already_terminal:${effectId}`);
      }
      await this.#append({
        effectId,
        idempotencyKey: admission.idempotencyKey,
        type: "not_applied",
        reason,
      });
      return this.observe(effectId);
    });
  }

  async markUnknown(effectId: string, reason: string): Promise<EffectObservation> {
    return this.#transition(effectId, "unknown", ["dispatch_started"], { reason });
  }

  observe(effectId: string): EffectObservation {
    const history = eventsFor(this.#events, effectId);
    const admission = history.find((event) => event.type === "admitted");
    if (!admission) throw new Error("effect_unknown");
    const has = (type: EffectEventType) => history.some((event) => event.type === type);
    const response = history.find((event) => event.type === "provider_response");
    const capture = history.find((event) => event.type === "capture_durable");
    const terminal = [...history]
      .reverse()
      .find((event) =>
        ["published", "publication_failed", "applied", "not_applied", "unknown"].includes(
          event.type,
        ),
      );
    const truth: BrowserEffectTruth = browserEffectTruthSchema.parse({
      dispatch: has("provider_response")
        ? "acknowledged"
        : has("unknown")
          ? "unknown"
          : has("dispatch_started")
            ? "started"
            : "not_started",
      capture: has("capture_durable") ? "durable" : "not_started",
      publication: has("published")
        ? "published"
        : has("publication_failed")
          ? "failed"
          : "not_started",
      outcome: has("not_applied")
        ? "not_applied"
        : has("applied")
          ? "applied"
          : has("unknown")
            ? "unknown"
            : "pending",
    });
    return {
      effectId,
      idempotencyKey: admission.idempotencyKey,
      truth,
      ...(response?.responseStatus === undefined
        ? {}
        : { responseStatus: response.responseStatus }),
      ...(capture?.captureId === undefined ? {} : { captureId: capture.captureId }),
      ...(terminal?.reason === undefined ? {} : { reason: terminal.reason }),
    };
  }

  observations(): EffectObservation[] {
    return this.#events
      .filter((event) => event.type === "admitted")
      .map((event) => this.observe(event.effectId));
  }

  async #transition(
    effectId: string,
    type: EffectEventType,
    requiredPrior: readonly EffectEventType[],
    details: Pick<EffectEvent, "responseStatus" | "captureId" | "reason"> = {},
    forbiddenPrior: readonly EffectEventType[] = [],
  ): Promise<EffectObservation> {
    return this.#serial(async () => {
      const history = eventsFor(this.#events, effectId);
      const admission = history.find((event) => event.type === "admitted");
      if (!admission) throw new Error("effect_unknown");
      const existing = history.find((event) => event.type === type);
      if (existing) return this.observe(effectId);
      if (!requiredPrior.every((required) => history.some((event) => event.type === required))) {
        throw new Error(`effect_transition_invalid:${type}`);
      }
      if (forbiddenPrior.some((forbidden) => history.some((event) => event.type === forbidden))) {
        throw new Error(`effect_transition_invalid:${type}`);
      }
      const canReconcileUnknown = [
        "provider_response",
        "capture_durable",
        "published",
        "publication_failed",
        "applied",
      ].includes(type);
      if (
        history.some((event) => ["applied", "not_applied", "published"].includes(event.type)) ||
        (!canReconcileUnknown && history.some((event) => event.type === "unknown"))
      ) {
        throw new Error(`effect_already_terminal:${effectId}`);
      }
      await this.#append({
        effectId,
        idempotencyKey: admission.idempotencyKey,
        type,
        ...details,
      });
      return this.observe(effectId);
    });
  }

  async #append(event: Omit<EffectEvent, "sequence" | "at">): Promise<void> {
    const complete: EffectEvent = {
      ...event,
      sequence: this.#events.length,
      at: new Date().toISOString(),
    };
    await durableAppend(this.#ledgerPath, complete);
    this.#events.push(complete);
  }

  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
