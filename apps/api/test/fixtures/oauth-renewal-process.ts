import "reflect-metadata";
import { createServer } from "node:http";
import { Database } from "../../src/infrastructure/database.js";
import { createOAuthProvider } from "../../src/auth/oauth/oauth.service.js";
import { oauthConfiguration } from "../../src/auth/oauth/config.js";
import { BrowserProtectedValueCipher } from "@scry/veil";

// Disposable fixture only: refuse all non-loopback/non-fictional databases.
const target = new URL(process.env.DATABASE_URL!);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !/^\/scry_oauth_[a-f0-9]{32}$/.test(target.pathname)
)
  throw new Error("FICTIONAL_DATABASE_REQUIRED");
const database = new Database();
const config = oauthConfiguration()!;
if (new URL(config.issuer).hostname !== "127.0.0.1") throw new Error("FICTIONAL_ISSUER_REQUIRED");
if (process.env.SCRY_OAUTH_FIXTURE_CRASH === "before_receipt") {
  const encrypt = BrowserProtectedValueCipher.prototype.encrypt;
  BrowserProtectedValueCipher.prototype.encrypt = function (value, context) {
    if (context.purpose === "oauth-renewal") process.kill(process.pid, "SIGKILL");
    return encrypt.call(this, value, context);
  };
}
const provider = createOAuthProvider(config, database);
if (process.env.SCRY_OAUTH_FIXTURE_CRASH === "after_commit_drop") {
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.path === "/token" && ctx.method === "POST" && ctx.status === 200)
      ctx.req.socket.destroy();
  });
}
const handler = provider.callback();
const server = createServer((request, response) => {
  if (request.url?.startsWith("/oauth/")) request.url = request.url.slice("/oauth".length);
  handler(request, response);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(JSON.stringify({ port: address.port }));
});
process.on("SIGTERM", () =>
  server.close(() => {
    void database.onModuleDestroy().then(() => process.exit(0));
  }),
);
