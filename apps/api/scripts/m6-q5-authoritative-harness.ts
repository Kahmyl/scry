import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const Q5_PREPAID_FREE_PHASES = [
  "immutable_source",
  "database_migration",
  "canonical_persisted_state",
  "canonical_application_environment_protected_auth",
  "deterministic_runtime_composition",
  "runtime_source_identity",
  "worker_compatibility_readiness",
  "mcp_q5_profile_contract",
  "browser_praxis_readiness",
  "protected_auth_rehearsal",
  "exact_mission_objective_flow",
  "final_source_runtime_refingerprint",
  "no_known_pre_mission_q5_gaps",
] as const;

export type Q5PrepaidFreePhase = (typeof Q5_PREPAID_FREE_PHASES)[number];
export type Q5GateResult = Readonly<{
  phase: Q5PrepaidFreePhase;
  pass: true;
  evidence: Record<string, unknown>;
}>;
export type Q5Gate = () => Promise<Record<string, unknown>>;

export async function runPrepaidFreeQ5Gates(gates: Readonly<Record<Q5PrepaidFreePhase, Q5Gate>>) {
  const results: Q5GateResult[] = [];
  for (const phase of Q5_PREPAID_FREE_PHASES) {
    const evidence = await gates[phase]();
    if (evidence.pass === false) throw new Error(`Q5_PREFLIGHT_${phase.toUpperCase()}_FAILED`);
    results.push({ phase, pass: true, evidence });
  }
  return results;
}

export async function crossPaidQ5Boundary<T>(input: {
  gates: Readonly<Record<Q5PrepaidFreePhase, Q5Gate>>;
  consumeAttempt(): Promise<{ attemptId: string; state: "consumed" }>;
  constructProviderAfterConsumption(): Promise<T>;
}) {
  const gates = await runPrepaidFreeQ5Gates(input.gates);
  const consumed = await input.consumeAttempt();
  if (consumed.state !== "consumed") throw new Error("Q5_ATTEMPT_CONSUMPTION_NOT_DURABLE");
  const provider = await input.constructProviderAfterConsumption();
  return { gates, consumed, provider };
}

export function assertHighLevelQ5Objective(objective: string) {
  if (!objective.includes("exactly one Preview Test order"))
    throw new Error("Q5_OBJECTIVE_REQUIRED_OUTCOME_MISSING");
  if (!objective.includes("retrieve and verify that same order"))
    throw new Error("Q5_OBJECTIVE_EXACT_RETRIEVAL_MISSING");
  if (
    /\/api\/|openapi|swagger|client.?id|client.?secret|authorization:|x-api|json body|createPartnerOrder/i.test(
      objective,
    )
  )
    throw new Error("Q5_OBJECTIVE_CONTAINS_SOLUTION_FACTS");
}

export function minimalAgentEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  mcpCredential: string;
  providerKey: string;
  protectedCanaries: string[];
}) {
  const permittedHostKeys = ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of permittedHostKeys) if (input.parent[key]) environment[key] = input.parent[key];
  return {
    ...environment,
    DEEPSEEK_API_KEY: input.providerKey,
    SCRY_AGENT_LAB_MCP_TOKEN: input.mcpCredential,
    SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION: "structured",
    SCRY_AGENT_LAB_PROTECTED_CANARIES: JSON.stringify(input.protectedCanaries),
    PYTHONUNBUFFERED: "1",
  };
}

export class Q5OwnedProcess {
  private timer?: NodeJS.Timeout;
  private stdout = "";
  private stderr = "";
  private terminationReason?: string;

  private constructor(
    readonly child: ChildProcess,
    readonly cwd: string,
    readonly outputDirectory: string,
    readonly canaries: string[],
  ) {
    child.stdout?.on("data", (chunk) => (this.stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (this.stderr += String(chunk)));
  }

  static async start(input: {
    executable: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
    repositoryRoot: string;
    outputDirectory: string;
    timeoutMs: number;
  }) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "scry-q5-agent-"));
    if (isWithin(cwd, input.repositoryRoot)) throw new Error("Q5_AGENT_CWD_INSIDE_REPOSITORY");
    const child = spawn(input.executable, input.arguments, {
      cwd,
      env: input.environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const encodedCanaries = input.environment.SCRY_AGENT_LAB_PROTECTED_CANARIES;
    const canaries = encodedCanaries ? (JSON.parse(encodedCanaries) as string[]) : [];
    const owned = new Q5OwnedProcess(child, cwd, input.outputDirectory, canaries);
    owned.timer = setTimeout(
      () => void owned.terminate("Q5_AGENT_TIMEOUT").catch(() => undefined),
      input.timeoutMs,
    );
    return owned;
  }

  async wait() {
    try {
      const [exitCode, signal] = (await once(this.child, "exit")) as [number | null, string | null];
      if (this.timer) clearTimeout(this.timer);
      await this.persistSafeDiagnostics(exitCode, signal, this.terminationReason);
      return {
        exitCode,
        signal,
        diagnostics: redact(`${this.stdout}\n${this.stderr}`, this.canaries).slice(-20_000),
        cwd: this.cwd,
      };
    } catch (error) {
      if (this.timer) clearTimeout(this.timer);
      await this.persistSafeDiagnostics(
        this.child.exitCode,
        this.child.signalCode,
        this.terminationReason ?? "Q5_AGENT_PROCESS_ERROR",
      );
      throw error;
    } finally {
      await rm(this.cwd, { recursive: true, force: true });
    }
  }

  async terminate(reason: string) {
    this.terminationReason = reason;
    if (this.timer) clearTimeout(this.timer);
    if (this.child.exitCode === null && this.child.pid) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {}
      await Promise.race([once(this.child, "exit"), delay(5_000)]);
      if (this.child.exitCode === null)
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {}
      if (this.child.exitCode === null)
        await Promise.race([once(this.child, "exit"), delay(5_000)]);
    }
    await this.persistSafeDiagnostics(this.child.exitCode, this.child.signalCode, reason);
    await rm(this.cwd, { recursive: true, force: true });
  }

  private async persistSafeDiagnostics(
    exitCode: number | null,
    signal: string | null,
    reason?: string,
  ) {
    const safe = redact(`${this.stdout}\n${this.stderr}`, this.canaries).slice(-20_000);
    await writeFile(
      path.join(this.outputDirectory, "agent-process.json"),
      `${JSON.stringify({ exitCode, signal, reason, cwdOutsideRepository: true, diagnostics: safe }, null, 2)}\n`,
      "utf8",
    );
  }
}

export async function recursivePrivacyScan(root: string, canaries: string[]) {
  const files = await walk(root);
  const leaks: Array<{ file: string; canaryIndex: number }> = [];
  for (const file of files) {
    const value = await readFile(file).catch(() => Buffer.alloc(0));
    for (const [index, canary] of canaries.entries())
      if (canary && value.includes(Buffer.from(canary))) leaks.push({ file, canaryIndex: index });
  }
  return { protectedLeakCount: leaks.length, filesScanned: files.length, leaks };
}

function isWithin(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function redact(value: string, canaries: string[]) {
  let safe = value.replace(
    /(authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );
  for (const canary of canaries) safe = safe.replaceAll(canary, "[REDACTED]");
  return safe;
}

async function walk(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(root, entry.name);
      return entry.isDirectory() ? walk(target) : Promise.resolve([target]);
    }),
  );
  return nested.flat();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
