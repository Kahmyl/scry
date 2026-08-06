import { executionPolicySchema } from "@scry/contracts";
import {
  createAuthoringBrowserSession,
  type AuthoringBrowserSession,
} from "@scry/executor";

import type { AuthoringRuntimeRepository } from "../authoring/index.js";

type CreateSession = typeof createAuthoringBrowserSession;

export type AuthoringRuntimeOwner = {
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createAuthoringRuntimeOwner(options: {
  repository: AuthoringRuntimeRepository;
  workerId: string;
  browserChannel: string;
  veilAdmissionKey: string;
  heartbeatMs: number;
  pollMs: number;
  createSession?: CreateSession;
}): AuthoringRuntimeOwner {
  const createSession = options.createSession ?? createAuthoringBrowserSession;
  const sessions = new Map<
    string,
    {
      session: AuthoringBrowserSession;
      heartbeat: NodeJS.Timeout;
    }
  >();

  let poll: NodeJS.Timeout | undefined;
  let polling = false;
  let closing = false;

  async function claimAvailable() {
    if (polling || closing) {
      return;
    }

    polling = true;

    try {
      const runtime = await options.repository.claimNext(options.workerId);

      if (!runtime || closing) {
        return;
      }

      let session: AuthoringBrowserSession | undefined;

      try {
        session = await createSession({
          sessionId: runtime.probeSessionId,
          environmentId: runtime.environmentId,
          veilAdmissionKey: options.veilAdmissionKey,
          browserChannel: options.browserChannel,
          policy: executionPolicySchema.parse(runtime.policy),
        });

        const activated = await options.repository.activate(
          runtime.browserLeaseId,
          options.workerId,
        );

        if (!activated) {
          await session.close();
          return;
        }

        const heartbeat = setInterval(() => {
          void options.repository
            .heartbeat(runtime.browserLeaseId, options.workerId)
            .then(async (owned) => {
              if (owned) {
                return;
              }

              const ownedSession = sessions.get(runtime.browserLeaseId);

              if (!ownedSession) {
                return;
              }

              clearInterval(ownedSession.heartbeat);
              sessions.delete(runtime.browserLeaseId);
              await ownedSession.session.close();
            })
            .catch(() => undefined);
        }, options.heartbeatMs);

        sessions.set(runtime.browserLeaseId, {
          session,
          heartbeat,
        });
      } catch (error) {
        await session?.close().catch(() => undefined);

        process.stderr.write(
          `${JSON.stringify({
            event: "authoring.runtime.provision_failed",
            probeSessionId: runtime.probeSessionId,
            browserLeaseId: runtime.browserLeaseId,
            code:
              error instanceof Error
                ? error.name
                : "AUTHORING_RUNTIME_PROVISION_FAILED",
          })}\n`,
        );
      }
    } finally {
      polling = false;
    }
  }

  return {
    async start() {
      if (poll || closing) {
        return;
      }

      await claimAvailable();
      poll = setInterval(() => void claimAvailable(), options.pollMs);
    },

    async close() {
      if (closing) {
        return;
      }

      closing = true;

      if (poll) {
        clearInterval(poll);
        poll = undefined;
      }

      const owned = [...sessions.entries()];
      sessions.clear();

      await Promise.all(
        owned.map(async ([browserLeaseId, value]) => {
          clearInterval(value.heartbeat);

          try {
            await value.session.close();
          } finally {
            await options.repository.release(
              browserLeaseId,
              options.workerId,
              "cancelled",
            );
          }
        }),
      );
    },
  };
}
