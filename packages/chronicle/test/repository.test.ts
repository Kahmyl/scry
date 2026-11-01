import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChronicleRepository } from "../src/index.js";

describe("accepted evidence SQL boundary", () => {
  it("binds the report digest to the accepted Mission evidence in baseline order", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { state: "complete", chain_head: "first" },
        { state: "incomplete", chain_head: "second" },
      ],
      rowCount: 2,
    });
    const digest = await new ChronicleRepository({ query }).missionEvidenceDigest("mission-a");
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/LEFT JOIN browser_evidence_streams[\s\S]*ORDER BY r.created_at,r.id/),
      ["mission-a"],
    );
    expect(digest).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            { state: "complete", chain_head: "first" },
            { state: "incomplete", chain_head: "second" },
          ]),
        )
        .digest("hex"),
    );
  });

  it("anchors a failure report to sealed admitted partial evidence without claiming completeness", async () => {
    const rows = [
      { state: "incomplete", chain_head: "partial", sealed_at: "sealed", custody_mode: "admitted" },
    ];
    const query = vi.fn().mockResolvedValue({ rows, rowCount: 1 });
    expect(await new ChronicleRepository({ query }).missionEvidenceDigest("mission-a")).toBe(
      createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    );
    expect(rows[0]?.state).toBe("incomplete");
  });
  it("refuses a report digest without complete or sealed admitted partial evidence heads", async () => {
    for (const rows of [
      [],
      [{ state: "complete", chain_head: "" }],
      [{ state: "incomplete", chain_head: "partial" }],
      [{ state: "incomplete", chain_head: "partial", sealed_at: "sealed", custody_mode: "legacy" }],
      [{ state: "incomplete", chain_head: "", sealed_at: "sealed", custody_mode: "admitted" }],
      [{ state: "corrupt", chain_head: "partial", sealed_at: "sealed", custody_mode: "admitted" }],
    ]) {
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
