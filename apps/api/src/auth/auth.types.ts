export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export type UserPrincipal = {
  kind: "user";
  credentialKind?: "user" | "mcp";
  subject: string;
  userId: string;
  email: string;
  workspaceId: string;
  role: WorkspaceRole;
  oauthConnectionId?: string;
  mcpTokenId?: string;
};

export type ServicePrincipal = {
  kind: "service";
  credentialKind?: "service";
  subject: "scry-service";
  workspaceId?: never;
  role?: never;
};

export type Principal = UserPrincipal | ServicePrincipal;

export type AuthenticatedRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  principal?: Principal;
};
