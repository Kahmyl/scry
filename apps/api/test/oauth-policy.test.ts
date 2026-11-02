import { describe, expect, it } from "vitest";
import { oauthConfiguration } from "../src/auth/oauth/config.js";
import { validateClient } from "../src/auth/oauth/oauth.service.js";

describe("OAuth activation and registration policy", () => {
  const settings = {
    SCRY_OAUTH_ENABLED: "true",
    SCRY_OAUTH_ISSUER: "https://scry.example/oauth",
    SCRY_OAUTH_RESOURCE: "https://scry.example/mcp",
    SCRY_OAUTH_COOKIE_KEYS_JSON: JSON.stringify([
      "fictional-cookie-key-for-configuration-test-only",
    ]),
    SCRY_OAUTH_JWKS_JSON: JSON.stringify({
      keys: [{ kty: "RSA", alg: "RS256", kid: "fictional", d: "configuration-only" }],
    }),
  };
  it("stays inactive by default and refuses incomplete or mismatched public configuration", () => {
    expect(oauthConfiguration({})).toBeUndefined();
    expect(oauthConfiguration(settings)?.resource).toBe(settings.SCRY_OAUTH_RESOURCE);
    for (const patch of [
      { SCRY_OAUTH_COOKIE_KEYS_JSON: "[]" },
      { SCRY_OAUTH_JWKS_JSON: "null" },
      { SCRY_OAUTH_RESOURCE: "https://different.example/mcp" },
      { SCRY_OAUTH_ISSUER: "http://public.example/oauth" },
      { SCRY_OAUTH_ISSUER: "https://scry.example/oauth?secret=not-real" },
    ])
      expect(() => oauthConfiguration({ ...settings, ...patch })).toThrow(
        "SCRY_OAUTH_CONFIGURATION_INVALID",
      );
  });
  it("allows normal public PKCE callbacks but no external metadata fetches or unrelated grants", () => {
    expect(() =>
      validateClient({
        client_id: "fictional-client",
        redirect_uris: ["https://client.example/callback", "http://127.0.0.1:49199/callback"],
      }),
    ).not.toThrow();
    for (const metadata of [
      { redirect_uris: ["http://public.example/callback"] },
      { redirect_uris: ["https://user:password@client.example/callback"] },
      { redirect_uris: ["https://client.example/callback#fragment"] },
      { jwks_uri: "https://internal.example/keys" },
      { sector_identifier_uri: "https://internal.example/sector" },
      { grant_types: ["client_credentials"] },
      { response_types: ["id_token"] as const },
    ])
      expect(() => validateClient({ client_id: "fictional-client", ...metadata })).toThrow();
  });
});
