import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { OAuthService } from "./oauth.service.js";

/** Mount before Fastify's body parser; the standards library owns protocol routes. */
export async function mountOAuth(app: NestFastifyApplication) {
  const oauth = app.get(OAuthService);
  if (!oauth.provider || !oauth.config) return;
  await oauth.assertReady();
  const server = app.getHttpAdapter().getInstance();
  app.use("/oauth", oauth.provider.callback());
  // RFC 8414 places the issuer path after the well-known name.
  server.get(
    "/.well-known/oauth-authorization-server/oauth",
    async (_request: unknown, reply: { redirect(url: string): unknown }) =>
      reply.redirect(`${oauth.config!.issuer}/.well-known/openid-configuration`),
  );
}
