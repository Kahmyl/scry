import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import Provider, {
  errors,
  type Configuration,
  type ClientMetadata,
  type TokenEndpointGrantContext,
  type UnknownObject,
} from "oidc-provider";
import { Database } from "../../infrastructure/database.js";
import {
  oauthConfiguration,
  testingScope,
  oauthClientAuthMethods,
  oauthGrantTypes,
  oauthResponseTypes,
  type OAuthConfiguration,
} from "./config.js";
import { ConnectionsRepository } from "./connections.repository.js";
import { providerAdapter } from "./provider-adapter.js";
import { BrowserProtectedValueCipher } from "@scry/veil";
import { OAuthRenewal } from "./renewal.js";

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
      await this.database.query(`DELETE FROM oauth_renewal_receipts WHERE ctid IN (
        SELECT ctid FROM oauth_renewal_receipts WHERE expires_at<=clock_timestamp()
        ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
      await this.database.query(`DELETE FROM oauth_connection_events WHERE id IN (
        SELECT id FROM oauth_connection_events WHERE created_at<now()-interval '30 days'
        ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
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
    await this.database.query(
      "SELECT grant_hash,request_digest,expires_at FROM oauth_renewal_receipts LIMIT 0",
    );
    await this.database.query(
      "SELECT connection_id,outcome,created_at FROM oauth_connection_events LIMIT 0",
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
      !oauthClientAuthMethods.includes(metadata.token_endpoint_auth_method))
  )
    throw new errors.InvalidClientMetadata("Use a standard authorization-code client with PKCE.");
  if (
    metadata.client_name &&
    (metadata.client_name.length > 100 || /[\x00-\x1f]/u.test(metadata.client_name))
  )
    throw new errors.InvalidClientMetadata("Choose a short client name.");
  if (metadata.grant_types?.some((grant) => !oauthGrantTypes.includes(grant)))
    throw new errors.InvalidClientMetadata("Unsupported grant type.");
  if (
    metadata.response_types?.some(
      (response) => !oauthResponseTypes.some((allowed) => allowed === response),
    )
  )
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
): Provider {
  const renewal = new OAuthRenewal(database, config.resource);
  // The public registration hook wraps the maintained provider's own handler.
  // Client authentication, duplicate-parameter and scope validation run before it.
  class RenewalProvider extends Provider {
    override registerGrantType<Params extends object = UnknownObject>(
      name: string,
      handler: (ctx: TokenEndpointGrantContext<Params>) => void | Promise<void>,
      params?: string | readonly string[] | ReadonlySet<string>,
      duplicates?: string | readonly string[] | ReadonlySet<string>,
    ) {
      super.registerGrantType(
        name,
        name === "refresh_token"
          ? (ctx: TokenEndpointGrantContext<Params>) => renewal.handle(ctx, () => handler(ctx))
          : handler,
        params,
        duplicates,
      );
    }
  }
  const provider = new RenewalProvider(config.issuer, {
    adapter: providerAdapter(renewal.storage),
    jwks: config.jwks,
    cookies: {
      keys: config.cookieKeys,
      short: { httpOnly: true, sameSite: "lax" },
      long: { httpOnly: true, sameSite: "lax" },
    },
    clients: [],
    clientDefaults: {
      grant_types: [...oauthGrantTypes],
      response_types: [...oauthResponseTypes],
      token_endpoint_auth_method: "none",
    },
    responseTypes: [...oauthResponseTypes],
    // MCP clients repeat the resource scope during dynamic registration. It
    // must be advertised here as well as in resourceIndicators; grants still
    // bind it exclusively to the configured Scry resource and workspace.
    scopes: ["openid", "offline_access", testingScope],
    claims: { openid: ["sub"] },
    pkce: { required: () => true },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    // The consent screen approves a durable workspace connection, not access
    // only while the consent browser session remains signed in. OIDC's default
    // ties testing-only grants to that shorter session unless offline_access
    // was requested; MCP needs only scry:testing. Keep other OIDC behavior.
    expiresWithSession: (_ctx, source) =>
      !source.scopes.has(testingScope) && !source.scopes.has("offline_access"),
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
      const row = (await renewal.storage.query("SELECT id FROM app_users WHERE id=$1", [id]))
        .rows[0];
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
