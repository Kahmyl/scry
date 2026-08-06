import {
  currentActionSchema,
  executionPolicySchema,
  type ClaimedAuthoringRuntimeCommand,
} from "@scry/contracts";
import {
  createAuthoringBrowserSession,
  type AuthoringBrowserSession,
} from "@scry/executor";

import type {
  AuthoringRuntimeCommandRepository,
  AuthoringRuntimeRepository,
} from "../authoring/index.js";

type CreateSession = typeof createAuthoringBrowserSession;

export type AuthoringRuntimeOwner = {
  start(): Promise<void>;
  close(): Promise<void>;
};

type OwnedSession = {
  probeSessionId: string;
  session: AuthoringBrowserSession;
  heartbeat: NodeJS.Timeout;
  commandPoll: NodeJS.Timeout;
  processingCommand: boolean;
};

export function createAuthoringRuntimeOwner(options: {
  repository: AuthoringRuntimeRepository;
  commands: AuthoringRuntimeCommandRepository;
  workerId: string;
  browserChannel: string;
  veilAdmissionKey: string;
  heartbeatMs: number;
  pollMs: number;
  createSession?: CreateSession;
}): AuthoringRuntimeOwner {
  const createSession = options.createSession ?? createAuthoringBrowserSession;
  const sessions = new Map<string, OwnedSession>();

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

              await stopOwnedSession(runtime.browserLeaseId, false);
            })
            .catch(() => undefined);
        }, options.heartbeatMs);

        const owned: OwnedSession = {
          probeSessionId: runtime.probeSessionId,
          session,
          heartbeat,
          commandPoll: undefined as unknown as NodeJS.Timeout,
          processingCommand: false,
        };

        owned.commandPoll = setInterval(
          () => void processNextCommand(runtime.browserLeaseId),
          options.pollMs,
        );

        sessions.set(runtime.browserLeaseId, owned);
        await processNextCommand(runtime.browserLeaseId);
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

  async function processNextCommand(browserLeaseId: string) {
    const owned = sessions.get(browserLeaseId);

    if (!owned || owned.processingCommand || closing) {
      return;
    }

    owned.processingCommand = true;

    try {
      const command = await options.commands.claimNext(
        browserLeaseId,
        options.workerId,
      );

      if (!command) {
        return;
      }

      await executeCommand(owned, command);
    } finally {
      const current = sessions.get(browserLeaseId);

      if (current) {
        current.processingCommand = false;
      }
    }
  }

  async function executeCommand(
    owned: OwnedSession,
    command: ClaimedAuthoringRuntimeCommand,
  ) {
    try {
      switch (command.type) {
        case "observe_document": {
          const observation = await owned.session.observeDocument();

          await options.repository.recordObservation(
            command.browserLeaseId,
            options.workerId,
            observation,
          );

          await complete(command, observation);
          return;
        }

        case "interact": {
          const action = currentActionSchema.parse(command.payload.action);
          const observation = await owned.session.interact(action);

          await options.repository.recordObservation(
            command.browserLeaseId,
            options.workerId,
            observation,
          );

          await complete(command, observation);
          return;
        }

        case "suspend": {
          owned.session.suspend();

          const suspended = await options.repository.suspend(
            command.browserLeaseId,
            options.workerId,
          );

          if (!suspended) {
            owned.session.resume();
            throw new Error("AUTHORING_RUNTIME_SUSPEND_REJECTED");
          }

          await complete(command, {
            state: "suspended",
          });
          return;
        }

        case "resume": {
          const resumed = await options.repository.resume(
            command.browserLeaseId,
            options.workerId,
          );

          if (!resumed) {
            throw new Error("AUTHORING_RUNTIME_RESUME_REJECTED");
          }

          owned.session.resume();

          await complete(command, {
            state: "active",
          });
          return;
        }

        case "cancel": {
          await complete(command, {
            state: "cancelled",
          });

          await options.commands.cancelPending(
            command.probeSessionId,
            command.id,
          );

          await stopOwnedSession(command.browserLeaseId, false);

          await options.repository.release(
            command.browserLeaseId,
            options.workerId,
            "cancelled",
          );
          return;
        }
      }
    } catch {
      await options.commands
        .fail({
          commandId: command.id,
          browserLeaseId: command.browserLeaseId,
          workerId: options.workerId,
          claimToken: command.claimToken,
          safeError: {
            code: "AUTHORING_COMMAND_FAILED",
          },
        })
        .catch(() => undefined);

      await options.repository
        .crash(
          command.browserLeaseId,
          options.workerId,
          "AUTHORING_COMMAND_FAILED",
        )
        .catch(() => undefined);

      await stopOwnedSession(command.browserLeaseId, false);
    }
  }

  function complete(
    command: ClaimedAuthoringRuntimeCommand,
    safeResult: Record<string, unknown>,
  ) {
    return options.commands.complete({
      commandId: command.id,
      browserLeaseId: command.browserLeaseId,
      workerId: options.workerId,
      claimToken: command.claimToken,
      safeResult,
    });
  }

  async function stopOwnedSession(
    browserLeaseId: string,
    release: boolean,
  ) {
    const owned = sessions.get(browserLeaseId);

    if (!owned) {
      return;
    }

    sessions.delete(browserLeaseId);
    clearInterval(owned.heartbeat);
    clearInterval(owned.commandPoll);

    try {
      await owned.session.close();
    } finally {
      if (release) {
        await options.repository.release(
          browserLeaseId,
          options.workerId,
          "cancelled",
        );
      }
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

      await Promise.all(
        [...sessions.keys()].map((browserLeaseId) =>
          stopOwnedSession(browserLeaseId, true),
        ),
      );
    },
  };
}
