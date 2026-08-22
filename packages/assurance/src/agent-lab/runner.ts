import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { AgentLabInvocation, AgentLabRunResult, AgentLabRunSpec } from "./types.js";

const execFileAsync = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export type AgentLabProcessLauncher = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => Promise<void>;

const defaultLauncher: AgentLabProcessLauncher = async (command, args, options) => {
  await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 10 * 1024 * 1024,
  });
};

export async function runAgentLab(
  spec: AgentLabRunSpec,
  options: {
    repositoryRoot?: string;
    launcher?: AgentLabProcessLauncher;
  } = {},
): Promise<AgentLabInvocation> {
  if (!spec.objective.trim()) {
    throw new Error("AGENT_LAB_OBJECTIVE_REQUIRED");
  }

  const root = resolve(options.repositoryRoot ?? repositoryRoot);

  const outputDirectory = spec.outputDirectory
    ? resolve(root, spec.outputDirectory)
    : await mkdtemp(join(tmpdir(), "scry-agent-lab-"));

  const args = [
    "run",
    "--project",
    "apps/agent-lab",
    "scry-agent-lab",
    "run",
    "--objective",
    spec.objective,
    "--mcp-url",
    spec.mcpUrl ?? "http://127.0.0.1:4100/mcp",
    "--max-turns",
    String(spec.maxTurns ?? 20),
    "--max-tool-calls",
    String(spec.maxToolCalls ?? 15),
    "--output-directory",
    outputDirectory,
  ];

  if (spec.model) {
    args.push("--model", spec.model);
  }

  let launchError: unknown | undefined;

  try {
    await (options.launcher ?? defaultLauncher)("uv", args, {
      cwd: root,
      env: process.env,
    });
  } catch (error) {
    launchError = error;
  }

  const resultPath = join(outputDirectory, "result.json");

  let serialized: string;

  try {
    serialized = await readFile(resultPath, "utf8");
  } catch {
    throw Object.assign(new Error("AGENT_LAB_RESULT_NOT_PRODUCED"), {
      cause: launchError,
    });
  }

  const result = JSON.parse(serialized) as AgentLabRunResult;

  return {
    result,
    outputDirectory,
  };
}
