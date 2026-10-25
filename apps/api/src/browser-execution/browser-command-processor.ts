import { DelayedError, type Job } from "bullmq";
import type { PraxisExecutionPort } from "@scry/contracts";
import type { BrowserCommandRepository } from "./repositories/browser-command.repository.js";

/** Ordered admission is not a failed browser action or an infrastructure retry.
 * Both production and integration workers use this processor, not copied logic.
 * Claim-loss cancellation and absolute dispatch deadlines are separate lifecycle
 * work; this prerequisite does not claim to solve them by changing queue order.
 */
export async function processBrowserCommand(
  commands: BrowserCommandRepository,
  praxis: PraxisExecutionPort,
  job: Pick<Job<{ commandId: string }>, "data" | "moveToDelayed">,
  token?: string,
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
  const heartbeat = setInterval(
    () => void commands.heartbeatClaim(command.id, claimToken).catch(() => undefined),
    20_000,
  );
  try {
    const result = await praxis.executeCommand(command.session_id, command.safe_input);
    await commands.complete(command.id, claimToken, result);
    return result;
  } catch (error) {
    await commands.fail(command.id, claimToken, error);
    return { failed: true };
  } finally {
    clearInterval(heartbeat);
  }
}
