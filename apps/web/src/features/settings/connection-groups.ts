export type Connection = {
  id: string;
  clientName: string;
  workspaceId?: string;
  workspaceName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expired?: boolean | undefined;
  workspaceAccess?: boolean | undefined;
  conflicting?: boolean;
};
export function connectionStatus(c: Connection) {
  if (c.revokedAt) return "Disconnected";
  if (c.expired === true) return "Expired";
  if (c.workspaceAccess === false) return "Workspace access removed";
  if (c.conflicting || c.expired !== false || c.workspaceAccess !== true)
    return "Access not confirmed";
  return c.lastUsedAt
    ? "Connected · authenticated access verified"
    : "Approved · waiting for client verification";
}
export function groupConnections(rows: Connection[]) {
  const unique = new Map<string, Connection>();
  const projection = (c: Connection) =>
    JSON.stringify([
      c.clientName,
      c.workspaceId,
      c.workspaceName,
      c.createdAt,
      c.lastUsedAt,
      c.revokedAt,
      c.expired,
      c.workspaceAccess,
    ]);
  rows.forEach((c, i) => {
    const key = c.workspaceId && c.id ? JSON.stringify([c.workspaceId, c.id]) : "unknown:" + i;
    const previous = unique.get(key);
    unique.set(
      key,
      !previous || projection(previous) === projection(c)
        ? { ...c }
        : {
            ...previous,
            revokedAt: previous.revokedAt || c.revokedAt,
            expired: previous.expired === true || c.expired === true ? true : undefined,
            workspaceAccess:
              previous.workspaceAccess === false || c.workspaceAccess === false ? false : undefined,
            conflicting: true,
          },
    );
  });
  const groups = new Map<
    string,
    { key: string; clientName: string; workspaceName: string; connections: Connection[] }
  >();
  for (const [identity, c] of unique) {
    if (c.revokedAt || c.expired === true) continue;
    const key = c.workspaceId
      ? JSON.stringify([c.workspaceId, c.clientName])
      : "unscoped:" + identity;
    if (!groups.has(key))
      groups.set(key, {
        key,
        clientName: c.clientName,
        workspaceName: c.workspaceName,
        connections: [],
      });
    groups.get(key)!.connections.push(c);
  }
  return [...groups.values()];
}
