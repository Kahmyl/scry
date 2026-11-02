export function toolAuthMetadata() {
  return process.env.SCRY_OAUTH_ENABLED === "true"
    ? { securitySchemes: [{ type: "oauth2", scopes: ["scry:testing"] }] }
    : {};
}

export function protectedResourceMetadata(env = process.env) {
  if (env.SCRY_OAUTH_ENABLED !== "true") return undefined;
  const resource = new URL(env.SCRY_OAUTH_RESOURCE ?? "");
  const issuer = new URL(env.SCRY_OAUTH_ISSUER ?? "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(resource.hostname);
  if (
    (resource.protocol !== "https:" && !(local && resource.protocol === "http:")) ||
    issuer.origin !== resource.origin ||
    resource.pathname !== "/mcp" ||
    issuer.pathname !== "/oauth" ||
    resource.search ||
    resource.hash ||
    resource.username ||
    resource.password ||
    issuer.search ||
    issuer.hash ||
    issuer.username ||
    issuer.password
  )
    throw new Error("SCRY_OAUTH_CONFIGURATION_INVALID");
  return {
    resource: resource.href,
    authorization_servers: [issuer.href],
    scopes_supported: ["scry:testing"],
    bearer_methods_supported: ["header"],
  };
}

export function authenticationChallenge(
  metadata: NonNullable<ReturnType<typeof protectedResourceMetadata>>,
) {
  return `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", metadata.resource).href}", scope="scry:testing"`;
}
