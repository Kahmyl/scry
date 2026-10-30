import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChronicleRepository } from "../src/index.js";

describe("accepted evidence SQL boundary", () => {
  it("binds the report digest to the accepted Mission evidence in baseline order", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ chain_head: "first" }, { chain_head: "second" }],
      rowCount: 2,
    });
    const digest = await new ChronicleRepository({ query }).missionEvidenceDigest("mission-a");
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/e.state='complete' ORDER BY r.created_at,e.id/),
      ["mission-a"],
    );
    expect(digest).toBe(
      createHash("sha256")
        .update(JSON.stringify(["first", "second"]))
        .digest("hex"),
    );
  });

  it("refuses a report digest without complete evidence heads", async () => {
    for (const rows of [[], [{ chain_head: "" }]]) {
      const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
      await expect(
        new ChronicleRepository({ query }).missionEvidenceDigest("mission-a"),
      ).rejects.toThrow("SCRY_BROWSER_MISSION_EVIDENCE_INCOMPLETE");
    }
  });

  it("appends ordered effect history through the supplied transaction capability", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ next: "4" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await new ChronicleRepository({ query }).appendEffectEvent(
      "effect-a",
      "session-a",
      "capture_durable",
      { captureId: "capture-a" },
    );
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("MAX(sequence)"), [
      "effect-a",
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO browser_effect_events"),
      ["effect-a", "session-a", "4", "capture_durable", '{"captureId":"capture-a"}'],
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("projects a safe action ledger without command inputs or results", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          kind: "fill",
          state: "completed",
          created_at: new Date(1000),
          started_at: new Date(2000),
          completed_at: new Date(2007),
          secret: "not-projectable",
        },
      ],
      rowCount: 1,
    });
    const ledger = await new ChronicleRepository({ query }).safeActionLedger("session-a");
    expect(ledger).toEqual([
      { at: new Date(2000).toISOString(), tool: "fill", outcome: "completed", durationMs: 7 },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY command_ordinal"), [
      "session-a",
    ]);
  });
});
