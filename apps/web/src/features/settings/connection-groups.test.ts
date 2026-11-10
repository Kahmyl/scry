import { expect, it } from "vitest";
import { connectionStatus, groupConnections, type Connection } from "./connection-groups.js";
const row: Connection = {
  id: "one",
  clientName: "Codex",
  workspaceId: "w",
  workspaceName: "Workspace",
  createdAt: "2026-11-10T00:00:00Z",
  lastUsedAt: "2026-11-10T01:00:00Z",
  revokedAt: null,
  expired: false,
  workspaceAccess: true,
};
it("groups four Codex sign-ins while preserving all four distinct authorizations", () => {
  const g = groupConnections([1, 2, 3, 4].map((i) => ({ ...row, id: String(i) })));
  expect(g).toHaveLength(1);
  expect(g[0]!.connections).toHaveLength(4);
});
it("deduplicates exact scoped grant identity but never different workspaces", () => {
  expect(groupConnections([row, { ...row }])[0]!.connections).toHaveLength(1);
  expect(groupConnections([row, { ...row, workspaceId: "another" }])).toHaveLength(2);
});
it("does not invent scope or current authentication from a historical last-use timestamp", () => {
  const { workspaceId, ...unscoped } = row;
  expect(groupConnections([unscoped, { ...unscoped, id: "two" }])).toHaveLength(2);
  expect(connectionStatus({ ...row, expired: undefined })).toBe("Access not confirmed");
  expect(connectionStatus({ ...row, workspaceAccess: false })).toBe("Workspace access removed");
});
it("revocation wins over a stale duplicate; conflicting projections never show Connected", () => {
  expect(groupConnections([row, { ...row, revokedAt: "2026-11-10T02:00:00Z" }])).toHaveLength(0);
  const g = groupConnections([row, { ...row, workspaceAccess: false }]);
  expect(connectionStatus(g[0]!.connections[0]!)).not.toContain("Connected");
});
