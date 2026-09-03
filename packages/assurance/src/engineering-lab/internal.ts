import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import type { EngineeringLabCommand, EngineeringLabCommandResult } from "./types.js";

const DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export async function runCommand(
  command: EngineeringLabCommand,
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
  maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
): Promise<EngineeringLabCommandResult> {
  if (!command.executable || command.args.some((arg) => arg.includes("\u0000"))) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_COMMAND_INVALID");
  }

  const startedAt = performance.now();

  return await new Promise<EngineeringLabCommandResult>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd,
      env: buildScrubbedEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, command.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, maxCaptureBytes - stdoutBytes);

      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        stdout.push(captured);
        stdoutBytes += captured.byteLength;
      }

      if (chunk.byteLength > remaining) {
        stdoutTruncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, maxCaptureBytes - stderrBytes);

      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        stderr.push(captured);
        stderrBytes += captured.byteLength;
      }

      if (chunk.byteLength > remaining) {
        stderrTruncated = true;
      }
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);

      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Math.round(performance.now() - startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: {
    allowFailure?: boolean;
    environment?: Readonly<Record<string, string>>;
    maxCaptureBytes?: number;
  } = {},
): Promise<EngineeringLabCommandResult> {
  const result = await runCommand(
    {
      executable: "git",
      args,
      timeoutMs: 60_000,
    },
    cwd,
    options.environment,
    options.maxCaptureBytes,
  );

  if (!options.allowFailure && result.exitCode !== 0) {
    throw new Error(
      `ASSURANCE_ENGINEERING_LAB_GIT_FAILED:${args[0] ?? "unknown"}:${result.stderr.trim()}`,
    );
  }

  return result;
}

function buildScrubbedEnvironment(additions: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const safeKeys = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const;
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };

  for (const key of safeKeys) {
    const value = process.env[key];

    if (value !== undefined) {
      environment[key] = value;
    }
  }

  for (const [key, value] of Object.entries(additions)) {
    if (!isSafeEnvironmentName(key)) {
      throw new Error(`ASSURANCE_ENGINEERING_LAB_ENVIRONMENT_NAME_FORBIDDEN:${key}`);
    }

    environment[key] = value;
  }

  return environment;
}

function isSafeEnvironmentName(key: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return false;
  }

  return !/(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE|API_KEY|ACCESS_KEY)/.test(key);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_NON_FINITE_FACT");
  }

  return value;
}
