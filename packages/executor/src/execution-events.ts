import { appendFile } from "node:fs/promises";

import { runEventSchema, type RunEvent } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";

export type ExecutionEventEmitter = (
  type: RunEvent["type"],
  payload: Record<string, unknown>,
) => Promise<void>;

interface ExecutionEventStreamOptions {
  eventPath: string;
  runId: string;
  attemptId: string;
  redactor: SecretRedactor;
  isSuppressed: () => boolean;
  onEvent?: (event: RunEvent) => void | Promise<void>;
}

export class ExecutionEventStream {
  private sequence = 0;
  private writeChain = Promise.resolve();

  constructor(private readonly options: ExecutionEventStreamOptions) {}

  readonly emit: ExecutionEventEmitter = async (type, payload) => {
    if (
      this.options.isSuppressed() &&
      !type.startsWith("privacy.") &&
      !type.startsWith("recording.")
    ) {
      return;
    }

    const event = runEventSchema.parse({
      sequence: ++this.sequence,
      runId: this.options.runId,
      attemptId: this.options.attemptId,
      type,
      occurredAt: new Date().toISOString(),
      payload: this.options.redactor.redactValue(payload),
    });

    this.writeChain = this.writeChain.then(async () => {
      await appendFile(this.options.eventPath, `${JSON.stringify(event)}\n`, "utf8");
      await this.options.onEvent?.(event);
    });
    await this.writeChain;
  };
}
