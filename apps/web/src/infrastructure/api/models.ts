export type Project = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

export type McpAccessToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  token?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
};
