import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { errors, type TokenEndpointGrantContext } from "oidc-provider";
import { BrowserProtectedValueCipher } from "@scry/veil";
import type { Database } from "../../infrastructure/database.js";
import { digest } from "./provider-adapter.js";
import { recordConnectionEvent } from "./connection-events.js";

/** Wrap the provider's authenticated refresh handler, never its protocol validation.
 * All provider writes and the retry receipt commit together. The DB grant lock
 * coordinates independent processes; an ambient client avoids nested pool leases.
 */
export class OAuthRenewal {
  private readonly scope = new AsyncLocalStorage<PoolClient>();
  private readonly cipher = new BrowserProtectedValueCipher();
  readonly storage: Pick<Database, "query" | "transaction">;
  constructor(
    private readonly database: Database,
    private readonly resource: string,
  ) {
    this.storage = {
      query: (text, values) => {
        const client = this.scope.getStore();
        return client ? client.query(text, values) : database.query(text, values);
      },
      transaction: (work) => {
        const client = this.scope.getStore();
        return client ? work(client) : database.transaction(work);
      },
    };
  }

  async handle(ctx: TokenEndpointGrantContext, execute: () => Promise<void> | void) {
    const value = ctx.oidc.params.refresh_token;
    if (typeof value !== "string" || value.length > 4096) return execute();
    // This is only a lock locator, not authentication. The standard handler
    // still owns client/token validation and all issuance.
    const predecessor = digest(value);
    const row = (
      await this.database.query(
        "SELECT grant_hash FROM oauth_provider_records WHERE model='RefreshToken' AND id_hash=$1",
        [predecessor],
      )
    ).rows[0];
    if (!row?.grant_hash) return execute();
    const grantHash = String(row.grant_hash);
    const requestDigest = digest(
      JSON.stringify({
        issuer: ctx.oidc.provider.issuer,
        configuredResource: this.resource,
        client: ctx.oidc.client.clientId,
        scope: ctx.oidc.params.scope ?? null,
        resource: ctx.oidc.params.resource ?? null,
        authorizationDetails: ctx.oidc.params.authorization_details ?? null,
      }),
    );
    try {
      const result = await this.database.boundedTransaction(async (transactionClient) => {
        // The provider deliberately performs some revocation operations with
        // Promise.all. A single atomic transaction must queue their SQL rather
        // than execute concurrent queries on one PostgreSQL connection.
        const client = serialClient(transactionClient);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,731927))", [
          grantHash,
        ]);
        return this.scope.run(client, async () => {
          const token = await ctx.oidc.provider.RefreshToken.find(value);
          // Wrong clients must not read a receipt or revoke another client's grant.
          if (!token || token.clientId !== ctx.oidc.client.clientId) {
            await execute();
            return {};
          }
          const connection = (
            await client.query(
              `SELECT c.id FROM oauth_connections c
             JOIN workspace_memberships m ON m.user_id=c.user_id AND m.workspace_id=c.workspace_id
             JOIN oauth_provider_records g ON g.model='Grant' AND g.id_hash=c.grant_hash
             WHERE c.grant_hash=$1 AND c.client_id=$2 AND c.revoked_at IS NULL
               AND g.expires_at>clock_timestamp()
             FOR SHARE OF c,m,g`,
              [grantHash, ctx.oidc.client.clientId],
            )
          ).rows[0];
          if (!connection) throw new errors.InvalidGrant();
          if (token.consumed) {
            const receipt = (
              await client.query(
                `SELECT r.* FROM oauth_renewal_receipts r
               JOIN oauth_provider_records s ON s.model='RefreshToken' AND s.id_hash=r.successor_hash
               WHERE r.grant_hash=$1 AND r.predecessor_hash=$2 AND r.request_digest=$3
                 AND r.expires_at>clock_timestamp() AND s.grant_hash=r.grant_hash
                 AND s.consumed_at IS NULL AND s.expires_at>clock_timestamp()`,
                [grantHash, predecessor, requestDigest],
              )
            ).rows[0];
            if (receipt) {
              const body = JSON.parse(
                this.cipher.decrypt(
                  {
                    ciphertext: receipt.ciphertext,
                    nonce: receipt.nonce,
                    authenticationTag: receipt.authentication_tag,
                    valueDigest: receipt.value_digest,
                    keyId: receipt.key_id,
                  },
                  { purpose: "oauth-renewal", grantHash, predecessor, requestDigest },
                ),
              );
              // Preserve the server's original access-token expiry on replay.
              const access = await ctx.oidc.provider.AccessToken.find(body.access_token);
              if (
                access &&
                access.aud === this.resource &&
                access.grantId === token.grantId &&
                access.clientId === token.clientId &&
                digest(body.refresh_token) === receipt.successor_hash
              ) {
                ctx.body = {
                  ...body,
                  expires_in: Math.max(0, access.remainingTTL),
                };
                ctx.status = 200;
                await recordConnectionEvent(client, connection.id, "retry_recovered");
                return {};
              }
            }
            // Outside the exact bounded retry contract, retain the provider's
            // replay detection and commit its family revocation before replying.
            try {
              await execute();
            } catch (error) {
              const revoked = (
                await client.query(
                  "SELECT revoked_at IS NOT NULL AS revoked FROM oauth_connections WHERE id=$1",
                  [connection.id],
                )
              ).rows[0]?.revoked;
              if (revoked) {
                await client.query("DELETE FROM oauth_renewal_receipts WHERE grant_hash=$1", [
                  grantHash,
                ]);
                await recordConnectionEvent(client, connection.id, "replay_refused");
                return { error };
              }
              throw error;
            }
            return {};
          }
          await execute();
          const body = ctx.body as Record<string, unknown>;
          if (
            typeof body?.access_token !== "string" ||
            typeof body.refresh_token !== "string" ||
            body.refresh_token === value
          )
            throw new Error("OAUTH_RENEWAL_RESPONSE_INVALID");
          const encrypted = this.cipher.encrypt(JSON.stringify(body), {
            purpose: "oauth-renewal",
            grantHash,
            predecessor,
            requestDigest,
          });
          await client.query(
            `INSERT INTO oauth_renewal_receipts
              (grant_hash,predecessor_hash,successor_hash,request_digest,ciphertext,nonce,authentication_tag,value_digest,key_id,created_at,expires_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,statement_timestamp(),statement_timestamp()+interval '10 seconds')
             ON CONFLICT(grant_hash) DO UPDATE SET predecessor_hash=EXCLUDED.predecessor_hash,
               successor_hash=EXCLUDED.successor_hash,request_digest=EXCLUDED.request_digest,
               ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,authentication_tag=EXCLUDED.authentication_tag,
               value_digest=EXCLUDED.value_digest,key_id=EXCLUDED.key_id,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at`,
            [
              grantHash,
              predecessor,
              digest(body.refresh_token),
              requestDigest,
              encrypted.ciphertext,
              encrypted.nonce,
              encrypted.authenticationTag,
              encrypted.valueDigest,
              encrypted.keyId,
            ],
          );
          await recordConnectionEvent(client, connection.id, "renewed");
          return {};
        });
      });
      if ("error" in result) throw result.error;
    } catch (error) {
      if (error instanceof errors.OIDCProviderError) throw error;
      // A DB/key/commit failure is retryable, never "invalid_grant". The old
      // refresh token remains unconsumed when the transaction rolls back.
      throw new errors.TemporarilyUnavailable(
        "Scry could not complete renewal. Try again shortly.",
      );
    }
  }
}

function serialClient(client: PoolClient): PoolClient {
  let tail = Promise.resolve();
  return new Proxy(client, {
    get(target, key) {
      if (key === "query")
        return (text: string, values: unknown[] = []) => {
          const result = tail.then(() => target.query(text, values));
          tail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
