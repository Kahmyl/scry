export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export type UserPrincipal = {
  kind: "user";
  subject: string;
  userId: string;
  email: string;
  workspaceId: string;
  role: WorkspaceRole;
};

export type ServicePrincipal = {
  kind: "service";
  subject: "scry-service";
  workspaceId?: never;
  role?: never;
};

export type Principal = UserPrincipal | ServicePrincipal;

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  principal?: Principal;
};
