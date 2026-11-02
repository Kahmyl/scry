import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import Provider, { errors, type Configuration, type ClientMetadata } from "oidc-provider";
import { Database } from "../../infrastructure/database.js";
import { oauthConfiguration, testingScope, type OAuthConfiguration } from "./config.js";
import { ConnectionsRepository } from "./connections.repository.js";
import { providerAdapter } from "./provider-adapter.js";
import { BrowserProtectedValueCipher } from "@scry/veil";

@Injectable()
export class OAuthService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  readonly config: OAuthConfiguration | undefined;
  readonly provider: Provider | undefined;
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ConnectionsRepository) readonly connections: ConnectionsRepository,
  ) {
    this.config = oauthConfiguration();
    if (this.config) this.provider = createOAuthProvider(this.config, database);
  }
  require() {
    if (!this.provider || !this.config)
      throw new ServiceUnavailableException(
        "Account linking is not available yet. Existing connections still work.",
      );
    return { provider: this.provider, config: this.config };
  }
  onModuleInit() {
    if (!this.provider) return;
    this.timer = setInterval(() => {
      void this.sweepExpired().catch(() =>
        new Logger(OAuthService.name).warn(
          "OAuth expiry cleanup deferred; expired access remains refused.",
        ),
      );
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async sweepExpired() {
    if (this.sweeping || !this.provider) return;
    this.sweeping = true;
    try {
      // One bounded batch per minute; expired rows are already unreadable even
      // if cleanup is delayed. Multiple API replicas can sweep safely.
      await this.database.query(`DELETE FROM oauth_provider_records WHERE ctid IN (
        SELECT ctid FROM oauth_provider_records WHERE expires_at<=now()
        ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    } finally {
      this.sweeping = false;
    }
  }
  async discardGrant(grantId: string) {
    await new (providerAdapter(this.database))("AccessToken").revokeByGrantId(grantId);
  }
  async authenticate(token: string) {
    if (!this.provider || !this.config) return undefined;
    const access = await this.provider.AccessToken.find(token);
    if (
      !access ||
      access.aud !== this.config.resource ||
      !access.scope?.split(" ").includes(testingScope) ||
      !access.grantId ||
      !access.accountId ||
      !access.clientId
    )
      return undefined;
    if (!(await this.provider.Grant.find(access.grantId))) return undefined;
    return this.connections.principal(access.grantId, access.accountId, access.clientId);
  }
  async assertReady() {
    new BrowserProtectedValueCipher().activeKeyId();
    await this.database.query("SELECT id,grant_hash FROM oauth_connections LIMIT 0");
    await this.database.query(
      "SELECT model,id_hash,consumed_at,expires_at FROM oauth_provider_records LIMIT 0",
    );
  }
}

export function validateClient(metadata: ClientMetadata) {
  // Public PKCE clients do not need remote key/sector documents. Refuse
  // metadata that would make registration fetch an untrusted server URL.
  if (
    metadata.jwks_uri ||
    metadata.sector_identifier_uri ||
    metadata.jwks ||
    (metadata.subject_type && metadata.subject_type !== "public") ||
    (metadata.token_endpoint_auth_method &&
      !["none", "client_secret_basic", "client_secret_post"].includes(
        metadata.token_endpoint_auth_method,
      ))
  )
    throw new errors.InvalidClientMetadata("Use a standard authorization-code client with PKCE.");
  if (
    metadata.client_name &&
    (metadata.client_name.length > 100 || /[\x00-\x1f]/u.test(metadata.client_name))
  )
    throw new errors.InvalidClientMetadata("Choose a short client name.");
  if (
    metadata.grant_types?.some((grant) => !["authorization_code", "refresh_token"].includes(grant))
  )
    throw new errors.InvalidClientMetadata("Unsupported grant type.");
  if (metadata.response_types?.some((response) => response !== "code"))
    throw new errors.InvalidClientMetadata("Only authorization code responses are supported.");
  for (const value of metadata.redirect_uris ?? []) {
    const url = new URL(value);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new errors.InvalidClientMetadata("Use an HTTPS or local loopback callback.");
  }
}

export function createOAuthProvider(
  config: OAuthConfiguration,
  database: Database,
  overrides: Partial<Configuration> = {},
) {
  const provider = new Provider(config.issuer, {
    adapter: providerAdapter(database),
    jwks: config.jwks,
    cookies: {
      keys: config.cookieKeys,
      short: { httpOnly: true, sameSite: "lax" },
      long: { httpOnly: true, sameSite: "lax" },
    },
    clients: [],
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    responseTypes: ["code"],
    scopes: ["openid", "offline_access"],
    claims: { openid: ["sub"] },
    pkce: { required: () => true },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: true,
    revokeGrantPolicy: () => true,
    loadExistingGrant: async (ctx) => {
      // Honor this interaction's explicit decision, never silently reuse an old
      // session grant for a new connection or a different signed-in account.
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    ttl: {
      AccessToken: 300,
      AuthorizationCode: 60,
      Interaction: 600,
      Session: 7200,
      RefreshToken: 30 * 86400,
      Grant: 30 * 86400,
    },
    routes: {
      authorization: "/authorize",
      token: "/token",
      registration: "/register",
      jwks: "/jwks",
      revocation: "/revoke",
    },
    features: {
      devInteractions: { enabled: false },
      clientIdMetadataDocument: { enabled: false },
      dPoP: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== config.resource)
            throw new errors.InvalidTarget("This connection is only for Scry.");
          return {
            scope: testingScope,
            audience: config.resource,
            accessTokenTTL: 300,
            accessTokenFormat: "opaque",
          };
        },
      },
    },
    extraClientMetadata: {
      properties: ["scry_policy"],
      validator: (_ctx, _key, _value, metadata) => validateClient(metadata),
    },
    interactions: {
      url: (_ctx, interaction) =>
        `${config.webOrigin}/api/integrations/authorize/${interaction.uid}`,
    },
    findAccount: async (_ctx, id) => {
      const row = (await database.query("SELECT id FROM app_users WHERE id=$1", [id])).rows[0];
      return row ? { accountId: row.id, claims: async () => ({ sub: row.id }) } : undefined;
    },
    renderError: async (ctx) => {
      ctx.type = "html";
      ctx.body =
        "<!doctype html><title>Connection could not be completed</title><h1>Connection could not be completed</h1><p>Return to Scry and try connecting again.</p>";
    },
    ...overrides,
  });
  provider.proxy = new URL(config.issuer).protocol === "https:";
  // This counter limits public registration work. Durable total capacity is also
  // enforced by the adapter across all replicas.
  let registrationWindow = 0,
    registrations = 0;
  provider.use(async (ctx, next) => {
    ctx.set("Cache-Control", "no-store");
    ctx.set("Referrer-Policy", "no-referrer");
    ctx.set("X-Content-Type-Options", "nosniff");
    if (ctx.path === "/register" && ctx.method === "POST") {
      const window = Math.floor(Date.now() / 60000);
      if (window !== registrationWindow) {
        registrationWindow = window;
        registrations = 0;
      }
      if (++registrations > 30) {
        ctx.status = 429;
        ctx.set("Retry-After", "60");
        ctx.body = { error: "temporarily_unavailable" };
        return;
      }
    }
    await next();
  });
  return provider;
}
