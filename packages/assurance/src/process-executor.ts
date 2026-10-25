import { spawn } from "node:child_process";
import path from "node:path";
import { parseTestCounts, type CheckExecutor, type ExecutionResult } from "./qualification.js";

/** Runs registered commands without a shell. Child output is bounded in memory,
 * reduced to safe counters, and never copied to logs or qualification reports. */
export function createProcessExecutor(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): CheckExecutor {
  return (check, signal) =>
    new Promise<ExecutionResult>((resolve) => {
      if (signal?.aborted) {
        resolve({ exitCode: null, issue: "cancelled" });
        return;
      }
      const graceMs = check.terminationGraceMs ?? 5_000;
      if (!Number.isSafeInteger(graceMs) || graceMs <= 0 || graceMs > 180_000) {
        resolve({ exitCode: null, issue: "invalid_configuration" });
        return;
      }
      const [command, ...args] = check.command;
      if (!command) {
        resolve({ exitCode: null, issue: "spawn_failed" });
        return;
      }
      if (check.tests)
        args.push(
          "--reporter",
          path.join(repositoryRoot, "packages/assurance/scripts/safe-reporter.ts"),
        );
      const child = spawn(command, args, {
        cwd: repositoryRoot,
        env: { ...environment, ...check.environment },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let output = "";
      let size = 0;
      let issue: ExecutionResult["issue"];
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (kind: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
          else child.kill(kind);
        } catch {
          /* Already exited. */
        }
      };
      const terminate = (reason: NonNullable<ExecutionResult["issue"]>) => {
        if (issue) return;
        issue = reason;
        kill("SIGTERM");
        // The execution deadline has already failed. This separate clock lets
        // owned-resource teardown finish without ever extending successful work.
        killTimer = setTimeout(() => kill("SIGKILL"), graceMs);
        killTimer.unref();
      };
      const collect = (buffer: Buffer, stdout: boolean) => {
        size += buffer.length;
        if (size > 2 * 1024 * 1024) {
          terminate("output_limit");
          return;
        }
        if (stdout) output += buffer.toString("utf8");
      };
      child.stdout.on("data", (buffer: Buffer) => collect(buffer, true));
      child.stderr.on("data", (buffer: Buffer) => collect(buffer, false));
      const timeout = setTimeout(() => terminate("timeout"), check.timeoutMs ?? 180_000);
      const cancel = () => terminate("cancelled");
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.once("error", () => {
        issue = "spawn_failed";
      });
      child.once("close", (exitCode) => {
        if (issue) kill("SIGKILL");
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", cancel);
        const counts = check.tests ? parseTestCounts(output) : undefined;
        resolve({ exitCode, ...(issue ? { issue } : {}), ...(counts ? { counts } : {}) });
      });
    });
}
