import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyReply } from "fastify";
import { OAuthService } from "./oauth.service.js";
import {
  testingScope,
  oauthClientAuthMethods,
  oauthGrantTypes,
  oauthResponseTypes,
} from "./config.js";

/** Mount before Fastify's body parser; the standards library owns protocol routes. */
export async function mountOAuth(app: NestFastifyApplication) {
  const oauth = app.get(OAuthService);
  const { provider, config } = oauth;
  if (!provider || !config) return;
  await oauth.assertReady();
  const server = app.getHttpAdapter().getInstance();
  app.use("/oauth", provider.callback());
  // RFC 8414 places the issuer path after the well-known name.
  server.get(
    "/.well-known/oauth-authorization-server/oauth",
    async (_request: unknown, reply: FastifyReply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff");
      return {
        issuer: config.issuer,
        authorization_endpoint: provider.urlFor("authorization"),
        token_endpoint: provider.urlFor("token"),
        registration_endpoint: provider.urlFor("registration"),
        revocation_endpoint: provider.urlFor("revocation"),
        jwks_uri: provider.urlFor("jwks"),
        response_types_supported: [...oauthResponseTypes],
        grant_types_supported: [...oauthGrantTypes],
        token_endpoint_auth_methods_supported: [...oauthClientAuthMethods],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        // MCP discovery advertises resource permissions, not optional OIDC scopes.
        // Redirecting to OIDC discovery made clients refresh testing-only grants
        // with openid/offline_access, which correctly failed scope validation.
        // The provider's separate OIDC discovery and grant checks stay intact.
        scopes_supported: [testingScope],
      };
    },
  );
}
