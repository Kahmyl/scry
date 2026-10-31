import { describe, it, expect } from "vitest";
import {
  browserToolCommandSchema,
  nativeToolInputSchema,
  playwrightToolDefinitions,
  nativeBrowserToolSchema,
  editBrowserTextSchema,
} from "../src/native-browser-command.js";
import { publishBrowserMissionReportSchema } from "../src/browser-lifecycle.js";
describe("pinned native browser surface", () => {
  it("requires current opaque edit references and explicit input intent without exposing execution code", () => {
    const input = { target: "f2e42", text: "A replacement", intent: "replace", method: "paste" };
    expect(editBrowserTextSchema.parse(input)).toEqual(input);
    for (const target of ["#editor", "e4 >> input", "e4;alert(1)", "", "f2e"])
      expect(editBrowserTextSchema.safeParse({ ...input, target }).success).toBe(false);
    for (const change of [
      { intent: undefined },
      { method: "auto" },
      { script: "document.execCommand()" },
    ])
      expect(editBrowserTextSchema.safeParse({ ...input, ...change }).success).toBe(false);
    expect(
      browserToolCommandSchema.safeParse({
        kind: "browser_tool",
        tool: "browser_edit_text",
        args: input,
      }).success,
    ).toBe(true);
  });
  it("accepts bounded screenshot presentation without permitting filenames or unrelated arguments", () => {
    const schema = nativeBrowserToolSchema("browser_take_screenshot");
    expect(
      schema.parse({
        type: "png",
        evidenceTitle: "Saved project",
        evidenceDescription: "After saving the updated note.",
      }),
    ).toMatchObject({ evidenceTitle: "Saved project" });
    for (const invalid of [
      { filename: "/tmp/capture.png" },
      { evidenceTitle: "bad\u0000title" },
      { evidenceTitle: "x".repeat(201) },
      { unrelated: true },
    ])
      expect(schema.safeParse({ type: "png", ...invalid }).success).toBe(false);
    expect(
      nativeBrowserToolSchema("browser_snapshot").safeParse({ evidenceTitle: "Wrong tool" })
        .success,
    ).toBe(false);
  });
  it("keeps historical reports readable and validates optional common presentation and references", () => {
    const base = {
      missionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      summary: "Tested the saved note",
      safeReport: { legacy: "Preserved" },
    };
    expect(publishBrowserMissionReportSchema.parse(base).safeReport).toEqual(base.safeReport);
    const presentation = {
      verified: ["Saved and reopened the note"],
      observations: [
        {
          title: "Recovered input",
          detail: "First input was uncertain; inspected before continuing.",
          evidence: [{ runId: base.missionId, artifactId: "a".repeat(64) }],
        },
      ],
      limitations: ["Other browsers not tested"],
    };
    expect(
      publishBrowserMissionReportSchema.safeParse({ ...base, safeReport: { presentation } })
        .success,
    ).toBe(true);
    expect(
      publishBrowserMissionReportSchema.safeParse({
        ...base,
        safeReport: {
          presentation: {
            ...presentation,
            observations: [
              {
                ...presentation.observations[0],
                evidence: [{ runId: base.missionId, artifactId: "not-an-artifact" }],
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      publishBrowserMissionReportSchema.safeParse({
        ...base,
        safeReport: { presentation: { unknown: "Do not silently accept a misspelled contract" } },
      }).success,
    ).toBe(false);
  });
  it("translates every supported official schema without permissive fallback", () => {
    for (const d of playwrightToolDefinitions)
      expect(() => nativeToolInputSchema(d.inputSchema)).not.toThrow();
    expect(() => nativeToolInputSchema({ type: "unknown" })).toThrow("SCHEMA_UNSUPPORTED");
  });
  it("excludes filesystem and arbitrary evaluation capabilities", () => {
    for (const tool of [
      "browser_run_code",
      "browser_evaluate",
      "browser_install",
      "browser_file_upload",
      "browser_network_requests",
    ])
      expect(
        browserToolCommandSchema.safeParse({ kind: "browser_tool", tool, args: {} }).success,
      ).toBe(false);
    expect(
      browserToolCommandSchema.safeParse({
        kind: "browser_tool",
        tool: "browser_take_screenshot",
        args: { filename: "/tmp/secret.png" },
      }).success,
    ).toBe(false);
    const screenshot = playwrightToolDefinitions.find((t) => t.name === "browser_take_screenshot")!;
    expect(
      nativeToolInputSchema(screenshot.inputSchema).safeParse({ filename: "/tmp/secret.png" })
        .success,
    ).toBe(false);
  });
});
