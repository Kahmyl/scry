import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  Q5_PREPAID_FREE_PHASES,
  Q5OwnedProcess,
  assertHighLevelQ5Objective,
  crossPaidQ5Boundary,
  minimalAgentEnvironment,
  recursivePrivacyScan,
  runPrepaidFreeQ5Gates,
  type Q5Gate,
  type Q5PrepaidFreePhase,
} from "../scripts/m6-q5-authoritative-harness.js";

const passingGates = () =>
  Object.fromEntries(
    Q5_PREPAID_FREE_PHASES.map((phase) => [phase, vi.fn(async () => ({ pass: true, phase }))]),
  ) as unknown as Record<Q5PrepaidFreePhase, Q5Gate>;

describe("M6 authoritative Q5 harness", () => {
  it("runs all prepaid-free phases in order before attempt consumption or provider construction", async () => {
    const order: string[] = [];
    const gates = Object.fromEntries(
      Q5_PREPAID_FREE_PHASES.map((phase) => [
        phase,
        async () => (order.push(phase), { pass: true }),
      ]),
    ) as unknown as Record<Q5PrepaidFreePhase, Q5Gate>;
    const result = await crossPaidQ5Boundary({
      gates,
      consumeAttempt: async () => (
        order.push("consume"),
        { attemptId: "attempt", state: "consumed" }
      ),
      constructProviderAfterConsumption: async () => (order.push("provider"), "mock-provider"),
    });
    expect(order).toEqual([...Q5_PREPAID_FREE_PHASES, "consume", "provider"]);
    expect(result.provider).toBe("mock-provider");
  });

  it.each(Q5_PREPAID_FREE_PHASES)(
    "fails closed at %s without consuming authority",
    async (failed) => {
      const gates = passingGates();
      gates[failed] = async () => ({ pass: false });
      const consume = vi.fn();
      const provider = vi.fn();
      await expect(
        crossPaidQ5Boundary({
          gates,
          consumeAttempt: consume,
          constructProviderAfterConsumption: provider,
        }),
      ).rejects.toThrow(`Q5_PREFLIGHT_${failed.toUpperCase()}_FAILED`);
      expect(consume).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it("does not construct provider if durable consumption refuses a second invocation", async () => {
    const provider = vi.fn();
    await expect(
      crossPaidQ5Boundary({
        gates: passingGates(),
        consumeAttempt: async () => {
          throw new Error("Q5_AUTHORITATIVE_ATTEMPT_CONSUMED");
        },
        constructProviderAfterConsumption: provider,
      }),
    ).rejects.toThrow("Q5_AUTHORITATIVE_ATTEMPT_CONSUMED");
    expect(provider).not.toHaveBeenCalled();
  });

  it("passes only an explicit minimal environment to Agent Lab", () => {
    const environment = minimalAgentEnvironment({
      parent: {
        PATH: "/bin",
        HOME: "/protected/home",
        DATABASE_URL: "postgres://protected",
        VEIL_ADMISSION_KEY: "protected",
        SCRY_SERVICE_TOKEN: "global-token",
        DEEPSEEK_API_KEY: "parent-key",
      },
      mcpCredential: "scoped-q5-token",
      providerKey: "provider-key",
      protectedCanaries: ["canary"],
    });
    expect(environment).toMatchObject({
      PATH: "/bin",
      SCRY_AGENT_LAB_MCP_TOKEN: "scoped-q5-token",
      DEEPSEEK_API_KEY: "provider-key",
    });
    expect(environment).not.toHaveProperty("HOME");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("VEIL_ADMISSION_KEY");
    expect(environment).not.toHaveProperty("SCRY_SERVICE_TOKEN");
  });

  it("rejects Vitract solution coaching but accepts the high-level objective", () => {
    const objective =
      "Use public Scry to create exactly one Preview Test order, retrieve and verify that same order, then finalize.";
    expect(() => assertHighLevelQ5Objective(objective)).not.toThrow();
    expect(() => assertHighLevelQ5Objective(`${objective} use /api/v1/orders`)).toThrow(
      "Q5_OBJECTIVE_CONTAINS_SOLUTION_FACTS",
    );
  });

  it("recursively catches every seeded protected canary on success and failure artifacts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "q5-privacy-"));
    const canaries = [
      "provider-key-canary",
      "credential-canary",
      "cookie-canary",
      "session-canary",
      "authorization-canary",
      "request-body-canary",
      "output-value-canary",
    ];
    await writeFile(path.join(directory, "success.json"), JSON.stringify({ status: "PASS" }));
    await writeFile(path.join(directory, "failure.log"), "safe failure");
    expect(await recursivePrivacyScan(directory, canaries)).toMatchObject({
      protectedLeakCount: 0,
    });
    await writeFile(path.join(directory, "failure.log"), canaries.join("\n"));
    const leaked = await recursivePrivacyScan(directory, canaries);
    expect(leaked.protectedLeakCount).toBe(7);
    expect(await readFile(path.join(directory, "success.json"), "utf8")).toContain("PASS");
  });

  it("prepaid-free gate execution itself creates no paid authority", async () => {
    const consume = vi.fn();
    await runPrepaidFreeQ5Gates(passingGates());
    expect(consume).not.toHaveBeenCalled();
  });

  it("writes safe structured diagnostics when provider process construction fails", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "q5-spawn-failure-"));
    const process = await Q5OwnedProcess.start({
      executable: path.join(outputDirectory, "missing-provider"),
      arguments: [],
      environment: { PATH: processEnvPath() },
      repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
      outputDirectory,
      timeoutMs: 1_000,
    });
    await expect(process.wait()).rejects.toBeDefined();
    await expect(
      readFile(path.join(outputDirectory, "agent-process.json"), "utf8"),
    ).resolves.toContain("Q5_AGENT_PROCESS_ERROR");
  });

  it("owns timeout termination, escalates within its process group, and removes the external cwd", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "q5-timeout-"));
    const owned = await Q5OwnedProcess.start({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      environment: { PATH: processEnvPath() },
      repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
      outputDirectory,
      timeoutMs: 30,
    });
    const cwd = owned.cwd;
    await owned.wait();
    const diagnostics = JSON.parse(
      await readFile(path.join(outputDirectory, "agent-process.json"), "utf8"),
    );
    expect(diagnostics.reason).toBe("Q5_AGENT_TIMEOUT");
    await expect(readFile(cwd, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function processEnvPath() {
  return process.env.PATH ?? "/usr/bin:/bin";
}
