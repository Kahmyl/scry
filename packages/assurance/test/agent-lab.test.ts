import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAgentLab, type AgentLabProcessLauncher } from "../src/agent-lab/index.js";

describe("Agent Lab Assurance bridge", () => {
  it("invokes the external process and reads its factual result", async () => {
    const root = process.cwd();

    const outputDirectory = ".agent-lab-test-output";

    let observedCommand = "";
    let observedArgs: string[] = [];

    const launcher: AgentLabProcessLauncher = async (command, args) => {
      observedCommand = command;
      observedArgs = args;

      const absolute = join(root, outputDirectory);

      await mkdir(absolute, {
        recursive: true,
      });

      await writeFile(
        join(absolute, "result.json"),
        JSON.stringify({
          status: "completed",
          objective: "Inspect Scry.",
          provider: "fake",
          model: "fake-model",
          mcp_url: "http://fake/mcp",
          advertised_tools: ["get_capabilities"],
          turns: 2,
          tool_calls: 1,
          invalid_calls: 0,
          stale_reference_calls: 0,
          repeated_unchanged_observations: 0,
          unnecessary_capabilities_calls: 0,
          completed: true,
          duration_ms: 10,
          transcript_path: "transcript.jsonl",
        }),
      );
    };

    const invocation = await runAgentLab(
      {
        objective: "Inspect Scry.",
        mcpUrl: "http://fake/mcp",
        outputDirectory,
      },
      {
        repositoryRoot: root,
        launcher,
      },
    );

    expect(observedCommand).toBe("uv");

    expect(observedArgs).toContain("apps/agent-lab");

    expect(observedArgs).toContain("Inspect Scry.");

    expect(invocation.result.tool_calls).toBe(1);

    expect(invocation.result.advertised_tools).toEqual(["get_capabilities"]);
  });
});
