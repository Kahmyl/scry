import { randomUUID } from "node:crypto";

import {
  advanceAuthoringTurnPayloadSchema,
  advanceAuthoringTurnResultSchema,
  currentActionSchema,
  executionPolicySchema,
  type ClaimedAuthoringRuntimeCommand,
  type InteractionTargetIntent,
  type PraxisCandidateResponse,
} from "@scry/contracts";
import type {
  createAuthoringBrowserSession,
  AuthoringBrowserSession,
} from "@scry/executor";
import { inspectPraxisCandidates } from "@scry/praxis";

import type {
  AuthoringRuntimeCommandRepository,
  AuthoringRuntimeRepository,
} from "../authoring/index.js";

type CreateSession = typeof createAuthoringBrowserSession;

export type AuthoringRuntimeOwner = {
  start(): Promise<void>;
  close(): Promise<void>;
  inspect(
    browserLeaseId: string,
    intent: InteractionTargetIntent,
    allowedOrigins: string[],
  ): Promise<PraxisCandidateResponse>;
};

type OwnedSession = {
  probeSessionId: string;
  environmentId: string;
  policy: import("@scry/contracts").ExecutionPolicy;
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
  admitSession?(input: {
    sessionId: string;
    environmentId: string;
    policy: import("@scry/contracts").ExecutionPolicy;
    operationId: string;
    correlationId?: string;
  }): Promise<void>;
  executeObservation?<T>(input: {
    sessionId: string;
    environmentId: string;
    policy: import("@scry/contracts").ExecutionPolicy;
    operationId: string;
    correlationId?: string;
    perform(): Promise<T>;
  }): Promise<T>;
  createSession?: CreateSession;
  executeInteraction?(input: {
    sessionId: string;
    environmentId: string;
    policy: import("@scry/contracts").ExecutionPolicy;
    page: Parameters<Parameters<CreateSession>[0]["executeInteraction"]>[0]["page"];
    action: Parameters<Parameters<CreateSession>[0]["executeInteraction"]>[0]["action"];
    ordinal: number;
    operationId: string;
    correlationId?: string;
    mutationIdentity?: string;
    expectedEffect?: import("@scry/contracts").ExpectedEffect;
    objectiveDelta?: string;
    signal?: AbortSignal;
  }): ReturnType<Parameters<CreateSession>[0]["executeInteraction"]>;
}): AuthoringRuntimeOwner {
  const createSession = options.createSession;
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
        if (!createSession) {
          throw new Error("EXECUTION_KERNEL_REQUIRED");
        }
        const policy = executionPolicySchema.parse(runtime.policy);
        await options.admitSession?.({
          sessionId: runtime.probeSessionId,
          environmentId: runtime.environmentId,
          policy,
          operationId: `authoring-session-${runtime.browserLeaseId}`,
        });
        session = await createSession({
          sessionId: runtime.probeSessionId,
          environmentId: runtime.environmentId,
          veilAdmissionKey: options.veilAdmissionKey,
          browserChannel: options.browserChannel,
          policy,
          executeInteraction: options.executeInteraction
            ? (input) =>
                options.executeInteraction!({
                  sessionId: runtime.probeSessionId,
                  environmentId: runtime.environmentId,
                  policy: executionPolicySchema.parse(runtime.policy),
                  ...input,
                })
            : async () => {
                throw new Error("EXECUTION_KERNEL_REQUIRED");
              },
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
          environmentId: runtime.environmentId,
          policy,
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
            code: error instanceof Error ? error.name : "AUTHORING_RUNTIME_PROVISION_FAILED",
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
      const command = await options.commands.claimNext(browserLeaseId, options.workerId);

      if (!command) {
        return;
      }

      const claimHeartbeat = setInterval(() => {
        void options.commands
          .heartbeatClaim({
            commandId: command.id,
            browserLeaseId: command.browserLeaseId,
            workerId: options.workerId,
            claimToken: command.claimToken,
          })
          .then((retained) => {
            if (!retained) void stopOwnedSession(command.browserLeaseId, false);
          })
          .catch(() => undefined);
      }, Math.max(250, Math.floor(options.heartbeatMs / 2)));
      try {
        await executeCommand(owned, command);
      } finally {
        clearInterval(claimHeartbeat);
      }
    } finally {
      const current = sessions.get(browserLeaseId);

      if (current) {
        current.processingCommand = false;
      }
    }
  }

  async function executeCommand(owned: OwnedSession, command: ClaimedAuthoringRuntimeCommand) {
    try {
      switch (command.type) {
        case "observe_document": {
          const observation = options.executeObservation
            ? await options.executeObservation({
                sessionId: owned.probeSessionId,
                environmentId: owned.environmentId,
                policy: owned.policy,
                operationId: `authoring-command-${command.id}`,
                perform: () => owned.session.observeDocument(),
              })
            : await owned.session.observeDocument();

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
          const interaction = await owned.session.interact(action, {
            operationId: `authoring-command-${command.id}`,
          });
          const observation = {
            documentEpoch: interaction.documentEpoch,
            url: interaction.url,
          };

          await options.repository.recordObservation(
            command.browserLeaseId,
            options.workerId,
            observation,
          );

          if (
            interaction.outcome.functionalResult !== "succeeded" ||
            interaction.outcome.mutationOutcome === "unknown"
          ) {
            await fail(command, {
              code: interaction.outcome.reasonCode ?? "AUTHORING_INTERACTION_FAILED",
              outcome: interaction.outcome,
              safeState: observation,
            });
            return;
          }

          await complete(command, { ...observation, outcome: interaction.outcome });
          return;
        }

        case "advance_turn": {
          const payload = advanceAuthoringTurnPayloadSchema.parse(command.payload);
          const correlationId = payload.correlationId ?? randomUUID();
          const startedAt = performance.now();
          const completed = [];
          let observationMs = 0;
          let interactionMs = 0;
          let retryCount = 0;
          const deadline = startedAt + payload.budgets.maxDurationMs;
          const turnController = new AbortController();
          let sessionCancelled = false;
          const turnTimeout = setTimeout(
            () => turnController.abort(new Error("AUTHORING_TURN_BUDGET_EXHAUSTED")),
            payload.budgets.maxDurationMs,
          );
          turnTimeout.unref();
          let decisionBoundary:
            | {
                type:
                  | "authorization_required"
                  | "protected_input_required"
                  | "mutation_reconciliation_required"
                  | "policy_refused"
                  | "objective_completed"
                  | "turn_budget_exhausted";
                reasonCode: string;
                safeActions: string[];
              }
            | undefined;
          const observationStartedAt = performance.now();
          let observation: { documentEpoch: number; url: string };
          try {
            const observationWork = options.executeObservation
              ? options.executeObservation({
                  sessionId: owned.probeSessionId,
                  environmentId: owned.environmentId,
                  policy: owned.policy,
                  operationId: `authoring-turn-${command.id}-observation-1`,
                  correlationId,
                  perform: () => owned.session.observeDocument(),
                })
              : owned.session.observeDocument();
            observation = await withinTurnBudget(
              observationWork,
              turnController.signal,
              async () => {
                sessionCancelled = true;
                await owned.session.cancelActiveOperation();
              },
            );
          } catch (error) {
            if (!turnController.signal.aborted) throw error;
            observation = {
              documentEpoch: owned.session.documentEpoch(),
              url: owned.session.page.url(),
            };
            decisionBoundary = {
              type: "turn_budget_exhausted",
              reasonCode: "AUTHORING_TURN_BUDGET_EXHAUSTED",
              safeActions: ["restart_authoring_session"],
            };
          }
          observationMs += performance.now() - observationStartedAt;

          for (const [ordinal, operation] of payload.operations.entries()) {
            if (decisionBoundary) break;
            if (
              ordinal >= payload.budgets.maxOperations ||
              performance.now() >= deadline ||
              turnController.signal.aborted
            ) {
              decisionBoundary = {
                type: "turn_budget_exhausted",
                reasonCode: "AUTHORING_TURN_BUDGET_EXHAUSTED",
                safeActions: ["continue_authoring_turn"],
              };
              break;
            }
            if (
              requiresMutationAuthorization(operation.action) &&
              !payload.authorization.mutationAllowed
            ) {
              decisionBoundary = {
                type: "authorization_required",
                reasonCode: "AUTHORING_MUTATION_AUTHORIZATION_REQUIRED",
                safeActions: ["request_authorization"],
              };
              break;
            }
            if (
              usesProtectedReference(operation.action) &&
              !payload.authorization.protectedOperationAllowed
            ) {
              decisionBoundary = {
                type: "protected_input_required",
                reasonCode: "AUTHORING_PROTECTED_OPERATION_AUTHORIZATION_REQUIRED",
                safeActions: ["bind_protected_input", "request_authorization"],
              };
              break;
            }

            let result;
            let retries = 0;
            while (true) {
              const remainingMs = Math.floor(deadline - performance.now());
              if (remainingMs < 100) {
                decisionBoundary = {
                  type: "turn_budget_exhausted",
                  reasonCode: "AUTHORING_TURN_BUDGET_EXHAUSTED",
                  safeActions: ["continue_authoring_turn"],
                };
                break;
              }
              const interactionStartedAt = performance.now();
              try {
                result = await withinTurnBudget(
                  owned.session.interact(clampActionTimeout(operation.action, remainingMs), {
                    operationId: `authoring-turn-${command.id}-${operation.operationId}-attempt-${retries + 1}`,
                    correlationId,
                    mutationIdentity: `authoring-turn-${command.id}-${operation.operationId}`,
                    expectedEffect: operation.expectedEffect,
                    objectiveDelta: payload.objectiveDelta,
                    signal: turnController.signal,
                  }),
                  turnController.signal,
                  async () => {
                    sessionCancelled = true;
                    await owned.session.cancelActiveOperation();
                  },
                );
              } catch (error) {
                if (!turnController.signal.aborted) throw error;
                decisionBoundary = {
                  type: "turn_budget_exhausted",
                  reasonCode: "AUTHORING_TURN_BUDGET_EXHAUSTED",
                  safeActions: [
                    "reconcile_if_mutation_was_dispatched",
                    "restart_authoring_session",
                  ],
                };
                break;
              }
              interactionMs += performance.now() - interactionStartedAt;
              if (
                !isProvenPreDispatchTransient(result.outcome) ||
                retries >= payload.budgets.maxPreDispatchRetries
              ) {
                break;
              }
              retries += 1;
              retryCount += 1;
              const refreshStartedAt = performance.now();
              try {
                const refreshWork = options.executeObservation
                  ? options.executeObservation({
                      sessionId: owned.probeSessionId,
                      environmentId: owned.environmentId,
                      policy: owned.policy,
                      operationId: `authoring-turn-${command.id}-${operation.operationId}-refresh-${retries}`,
                      correlationId,
                      perform: () => owned.session.observeDocument(),
                    })
                  : owned.session.observeDocument();
                observation = await withinTurnBudget(
                  refreshWork,
                  turnController.signal,
                  async () => {
                    sessionCancelled = true;
                    await owned.session.cancelActiveOperation();
                  },
                );
              } catch (error) {
                if (!turnController.signal.aborted) throw error;
                decisionBoundary = {
                  type: "turn_budget_exhausted",
                  reasonCode: "AUTHORING_TURN_BUDGET_EXHAUSTED",
                  safeActions: ["restart_authoring_session"],
                };
                break;
              }
              observationMs += performance.now() - refreshStartedAt;
              await options.repository.recordObservation(
                command.browserLeaseId,
                options.workerId,
                observation,
              );
            }
            if (decisionBoundary || !result) break;
            observation = { documentEpoch: result.documentEpoch, url: result.url };
            completed.push({ ...result.outcome, operationId: operation.operationId });
            await options.repository.recordObservation(
              command.browserLeaseId,
              options.workerId,
              observation,
            );

            if (result.outcome.mutationOutcome === "unknown") {
              decisionBoundary = {
                type: "mutation_reconciliation_required",
                reasonCode: "AUTHORING_MUTATION_OUTCOME_UNKNOWN",
                safeActions: ["reconcile_mutation", "do_not_retry"],
              };
              break;
            }
            if (result.outcome.functionalResult !== "succeeded") {
              decisionBoundary = {
                type: "policy_refused",
                reasonCode: result.outcome.reasonCode ?? "AUTHORING_OPERATION_FAILED",
                safeActions: ["revise_intent"],
              };
              break;
            }
          }

          decisionBoundary ??= {
            type: "objective_completed",
            reasonCode: "AUTHORING_TURN_COMPLETED",
            safeActions: [],
          };
          const resultWithoutBytes = {
            correlationId,
            operationsCompleted: completed,
            safeState: observation,
            decisionBoundary,
            timings: {
              totalMs: performance.now() - startedAt,
              observationMs,
              interactionMs,
              retryCount,
            },
          };
          const result = advanceAuthoringTurnResultSchema.parse({
            ...resultWithoutBytes,
            bytesReturned: Buffer.byteLength(JSON.stringify(resultWithoutBytes)),
          });
          clearTimeout(turnTimeout);
          await complete(command, result);
          if (sessionCancelled) {
            await options.repository
              .crash(command.browserLeaseId, options.workerId, "AUTHORING_TURN_BUDGET_EXHAUSTED")
              .catch(() => undefined);
            await stopOwnedSession(command.browserLeaseId, false);
          }
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
          const resumed = await options.repository.resume(command.browserLeaseId, options.workerId);

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

          await options.commands.cancelPending(command.probeSessionId, command.id);

          await stopOwnedSession(command.browserLeaseId, false);

          await options.repository.release(command.browserLeaseId, options.workerId, "cancelled");
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
        .crash(command.browserLeaseId, options.workerId, "AUTHORING_COMMAND_FAILED")
        .catch(() => undefined);

      await stopOwnedSession(command.browserLeaseId, false);
    }
  }

  function complete(command: ClaimedAuthoringRuntimeCommand, safeResult: Record<string, unknown>) {
    return options.commands.complete({
      commandId: command.id,
      browserLeaseId: command.browserLeaseId,
      workerId: options.workerId,
      claimToken: command.claimToken,
      safeResult,
    });
  }

  function fail(command: ClaimedAuthoringRuntimeCommand, safeError: Record<string, unknown>) {
    return options.commands.fail({
      commandId: command.id,
      browserLeaseId: command.browserLeaseId,
      workerId: options.workerId,
      claimToken: command.claimToken,
      safeError,
    });
  }

  async function stopOwnedSession(browserLeaseId: string, release: boolean) {
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
        await options.repository.release(browserLeaseId, options.workerId, "cancelled");
      }
    }
  }

  async function inspect(
    browserLeaseId: string,
    intent: InteractionTargetIntent,
    allowedOrigins: string[],
  ) {
    const owned = sessions.get(browserLeaseId);

    if (!owned) {
      throw new Error("AUTHORING_BROWSER_SESSION_UNAVAILABLE");
    }

    const perform = () =>
      inspectPraxisCandidates({
        page: owned.session.page,
        intent,
        context: {
          channel: "probe",
          ordinal: 0,
          timeoutMs: 10_000,
          allowedOrigins,
        },
      });
    return options.executeObservation
      ? options.executeObservation({
          sessionId: owned.probeSessionId,
          environmentId: owned.environmentId,
          policy: owned.policy,
          operationId: `authoring-inspection-${randomUUID()}`,
          perform,
        })
      : perform();
  }

  return {
    inspect,
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
        [...sessions.keys()].map((browserLeaseId) => stopOwnedSession(browserLeaseId, true)),
      );
    },
  };
}

function requiresMutationAuthorization(action: import("@scry/contracts").CurrentAction) {
  return ["click", "fill", "select", "check", "press", "protectedTransaction"].includes(
    action.type,
  );
}

function isProvenPreDispatchTransient(outcome: import("@scry/contracts").OperationOutcome) {
  return (
    outcome.functionalResult !== "succeeded" &&
    outcome.mutationOutcome === "not_applied" &&
    outcome.reasonCode === "PRAXIS_TARGET_CHANGED_BEFORE_ACTION"
  );
}

function usesProtectedReference(action: import("@scry/contracts").CurrentAction) {
  return (
    action.type === "protectedTransaction" ||
    (action.type === "fill" && Boolean(action.secretRef || action.capturedSecretRef))
  );
}

function clampActionTimeout(
  action: import("@scry/contracts").CurrentAction,
  remainingMs: number,
): import("@scry/contracts").CurrentAction {
  if (!("timeoutMs" in action)) return action;
  const timeoutMs = Math.max(100, Math.min(action.timeoutMs ?? remainingMs, remainingMs));
  return currentActionSchema.parse({ ...action, timeoutMs });
}

function withinTurnBudget<T>(
  work: Promise<T>,
  signal: AbortSignal,
  cancel: () => Promise<void>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborting = false;
    const aborted = () => {
      if (settled) return;
      aborting = true;
      void (async () => {
        await cancel().catch(() => undefined);
        await work.catch(() => undefined);
        reject(signal.reason ?? new Error("AUTHORING_TURN_BUDGET_EXHAUSTED"));
      })();
    };
    signal.addEventListener("abort", aborted, { once: true });
    work
      .then(
        (value) => {
          if (!aborting) resolve(value);
        },
        (error) => {
          if (!aborting) reject(error);
        },
      )
      .finally(() => {
        settled = true;
        signal.removeEventListener("abort", aborted);
      });
  });
}
