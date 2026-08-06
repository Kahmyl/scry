import { randomUUID } from "node:crypto";

import type { Job } from "bullmq";
import type { AuthoringRuntimeOwner } from "../authoring-runtime-owner.js";

import type { PraxisJob } from "../../runtime/index.js";
import type { PraxisRuntimeRepository } from "../../praxis/index.js";

interface PraxisWorkerOptions {
  workerId: string;
  releaseId: string;
  schemaFingerprint: string;
  praxis: PraxisRuntimeRepository;
  authoringRuntimeOwner: AuthoringRuntimeOwner;
}

export function createPraxisProcessor(options: PraxisWorkerOptions) {
  return async (job: Job<PraxisJob>) => {
    if (
      job.data.releaseId !== options.releaseId ||
      job.data.schemaFingerprint !== options.schemaFingerprint
    ) {
      throw new Error("WORKER_RELEASE_MISMATCH");
    }

    const claimToken = randomUUID();

    const runtime = await options.praxis.claim(
      job.data.requestId,
      options.workerId,
      claimToken,
    );

    if (!runtime) return { state: "not_claimed" };

    try {
      const payload = runtime.payload as {
        intent: import("@scry/contracts").InteractionTargetIntent;
        allowedOrigins: string[];
        probeSessionId: string;
      };

      const browserLeaseId =
        await options.praxis.resolveActiveBrowserLease(
          payload.probeSessionId,
          options.workerId,
        );

      if (!browserLeaseId) {
        throw new Error("AUTHORING_BROWSER_SESSION_UNAVAILABLE");
      }

      const result = await options.authoringRuntimeOwner.inspect(
        browserLeaseId,
        payload.intent,
        payload.allowedOrigins,
      );

      await options.praxis.complete(runtime, result);

      return {
        state: "completed",
        requestId: job.data.requestId,
      };
    } catch (error) {
      await options.praxis.fail(
        runtime,
        error instanceof Error ? error.message : "PRAXIS_EXECUTION_FAILED",
      );

      return {
        state: "failed",
      };
    }
  };
}

