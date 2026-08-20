import { describe, expect, it, vi } from "vitest";

import { FlowReadRepository } from "../src/flows/flow-read.repository.js";

describe("FlowReadRepository dashboard projection", () => {
  it("composes active drafts and published Flows without published-draft duplicates", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { id: "draft", recordKind: "draft" },
          { id: "published", recordKind: "published" },
        ],
      });
    const rows = await new FlowReadRepository({ query } as never).list(
      { kind: "service" } as never,
      "project",
      "all",
    );
    const sql = String(query.mock.calls[1]![0]);
    expect(rows).toEqual([
      { id: "draft", recordKind: "draft" },
      { id: "published", recordKind: "published" },
    ]);
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("d.state NOT IN ('published','abandoned')");
    expect(sql).toContain("f.publication_state='published'");
  });

  it("scopes published detail through its project workspace", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: "flow", recordKind: "published", version: 4 }],
    });
    const detail = await new FlowReadRepository({ query } as never).getPublished(
      { kind: "user", workspaceId: "11111111-1111-4111-8111-111111111111" } as never,
      "flow",
    );
    expect(detail).toMatchObject({ id: "flow", recordKind: "published", version: 4 });
    expect(query.mock.calls[0]![1]).toEqual(["flow", "11111111-1111-4111-8111-111111111111"]);
  });
});
