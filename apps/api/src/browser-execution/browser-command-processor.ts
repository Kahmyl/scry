import { DelayedError, type Job } from "bullmq";
import type { PraxisExecutionPort } from "@scry/contracts";
import type { BrowserCommandRepository } from "./repositories/browser-command.repository.js";
import { CommandExecutionLease } from "./command-execution-lease.js";
import { runtimeRecoveryCode } from "./command-recovery.js";

/** Ordered admission is not a failed browser action or an infrastructure retry.
 * Both production and integration workers use this processor, not copied logic.
 * Durable deadlines and claim-loss cancellation share one private lease control.
 * Native unconfirmed drain never advances the durable command to terminal state.
 */
export async function processBrowserCommand(
  commands: BrowserCommandRepository,
  praxis: PraxisExecutionPort,
  job: Pick<Job<{ commandId: string }>, "data" | "moveToDelayed">,
  token?: string,
  options: { onUnconfirmedDrain?: () => void } = {},
): Promise<Record<string, unknown>> {
  let command;
  try {
    command = await commands.claim(job.data.commandId);
  } catch (error) {
    if (
      error instanceof Error &&
      ["SCRY_BROWSER_COMMAND_PREDECESSOR_PENDING", "SCRY_BROWSER_COMMAND_ALREADY_RUNNING"].includes(
        error.message,
      )
    ) {
      await job.moveToDelayed(Date.now() + 1_000, token);
      throw new DelayedError();
    }
    throw error;
  }
  if (!command) return { replay: true };
  const claimToken = command.claim_token;
  if (!claimToken) throw new Error("SCRY_BROWSER_COMMAND_CLAIM_TOKEN_MISSING");
  const lease = new CommandExecutionLease(commands, command.id, claimToken, command);
  try {
    lease.assertActive();
    await lease.checkpoint();
    if (command.kind === "browser_tool" && command.attempt_count > 1) {
      // A prior claim may have reached the application. Reconcile receipts only;
      // never restore a browser and redispatch a reclaimed interaction.
      const result = command.safe_result ?? {
        execution: "unknown",
        businessOutcome: "unknown",
        observation: "unavailable",
        reason: "worker_interrupted_before_receipt",
      };
      await commands.complete(command.id, claimToken, { ...result, recovered: true });
      return { ...result, recovered: true };
    }
    const result = await praxis.executeCommand(command.session_id, command.safe_input, {
      remainingMs: lease.remainingMs(),
      signal: lease.signal,
      assertCurrent: () => lease.checkpoint(),
      sampleAuthority: () => lease.authoritySample(),
      persistAction: (result) => commands.checkpointAction(command.id, claimToken, result),
    });
    lease.assertActive();
    await commands.complete(command.id, claimToken, result);
    return result;
  } catch (error) {
    const recoveryCode = error instanceof Error ? runtimeRecoveryCode(error.message) : undefined;
    if (recoveryCode) {
      // Diagnostic persistence is best effort; host containment never depends on
      // a database still being available or this claimant still being current.
      options.onUnconfirmedDrain?.();
      await commands
        .noteRecoveryRequired(command.id, claimToken, recoveryCode)
        .catch(() => undefined);
      throw new Error("SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED");
    }
    await commands.fail(command.id, claimToken, lease.failure ?? error);
    return { failed: true };
  } finally {
    lease.dispose();
  }
}
