export const testingScope = "scry:testing";

export interface OAuthConfiguration {
  issuer: string;
  resource: string;
  webOrigin: string;
  cookieKeys: string[];
  jwks: { keys: Record<string, unknown>[] };
}

export function oauthConfiguration(env = process.env): OAuthConfiguration | undefined {
  if (env.SCRY_OAUTH_ENABLED !== "true") return undefined;
  try {
    const issuer = publicUrl(env.SCRY_OAUTH_ISSUER, "/oauth");
    const resource = publicUrl(env.SCRY_OAUTH_RESOURCE, "/mcp");
    const webOrigin = new URL(issuer).origin;
    if (new URL(resource).origin !== webOrigin) throw new Error("origin");
    const cookieKeys: unknown = JSON.parse(env.SCRY_OAUTH_COOKIE_KEYS_JSON ?? "null");
    const jwks = JSON.parse(env.SCRY_OAUTH_JWKS_JSON ?? "null");
    if (
      !Array.isArray(cookieKeys) ||
      !cookieKeys.length ||
      cookieKeys.some((key) => typeof key !== "string" || key.length < 32)
    )
      throw new Error("cookies");
    if (
      !jwks ||
      !Array.isArray(jwks.keys) ||
      !jwks.keys.length ||
      jwks.keys.some(
        (key: Record<string, unknown>) =>
          !key.d || !key.kid || key.kty !== "RSA" || key.alg !== "RS256",
      )
    )
      throw new Error("jwks");
    return { issuer, resource, webOrigin, cookieKeys, jwks };
  } catch {
    throw new Error("SCRY_OAUTH_CONFIGURATION_INVALID");
  }
}

function publicUrl(value: string | undefined, pathname: string) {
  const url = new URL(value ?? "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== pathname
  )
    throw new Error("url");
  return url.href;
}
