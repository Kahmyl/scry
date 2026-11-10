import { createHash } from "node:crypto";
import { errors, type AdapterPayload, type AdapterConstructor } from "oidc-provider";
import { BrowserProtectedValueCipher } from "@scry/veil";
import type { Database } from "../../infrastructure/database.js";
import { testingScope } from "./config.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Provider protocol state is encrypted by Veil; PostgreSQL owns expiry and consumption. */
export function providerAdapter(
  database: Pick<Database, "query" | "transaction">,
): AdapterConstructor {
  return class PostgreSqlOAuthAdapter {
    private readonly cipher = new BrowserProtectedValueCipher();
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
      const idHash = digest(id);
      const grantHash = payload.grantId
        ? digest(payload.grantId)
        : this.model === "Grant"
          ? idHash
          : null;
      const encrypted = this.cipher.encrypt(JSON.stringify(payload), {
        purpose: "oauth-provider",
        model: this.model,
        idHash,
      });
      await database.transaction(async (client) => {
        if (grantHash) {
          const grant = await client.query(
            "SELECT revoked_at FROM oauth_connections WHERE grant_hash=$1 FOR SHARE",
            [grantHash],
          );
          if (
            grant.rows[0]?.revoked_at ||
            (["AccessToken", "RefreshToken", "AuthorizationCode"].includes(this.model) &&
              !grant.rowCount)
          )
            throw new errors.InvalidGrant("The connection is no longer available.");
        }
        if (this.model === "Client") {
          await client.query("SELECT pg_advisory_xact_lock(731926)");
          const count = await client.query(
            "SELECT count(*)::int AS count FROM oauth_provider_records WHERE model='Client'",
          );
          if (count.rows[0]!.count >= 5000)
            throw new errors.InvalidClientMetadata("Registration capacity is currently in use.");
        }
        const result = await client.query(
          `INSERT INTO oauth_provider_records
          (model,id_hash,uid_hash,grant_hash,ciphertext,nonce,authentication_tag,value_digest,key_id,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10::int IS NULL THEN NULL ELSE now()+make_interval(secs=>$10) END)
          ON CONFLICT(model,id_hash) DO UPDATE SET uid_hash=EXCLUDED.uid_hash,grant_hash=EXCLUDED.grant_hash,
          ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,authentication_tag=EXCLUDED.authentication_tag,
          value_digest=EXCLUDED.value_digest,key_id=EXCLUDED.key_id,expires_at=EXCLUDED.expires_at
          WHERE $11::boolean=false OR oauth_provider_records.expires_at <= now()
          RETURNING id_hash`,
          [
            this.model,
            idHash,
            payload.uid ? digest(payload.uid) : null,
            grantHash,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.authenticationTag,
            encrypted.valueDigest,
            encrypted.keyId,
            expiresIn ?? null,
            this.model === "ReplayDetection",
          ],
        );
        if (!result.rowCount) throw new errors.InvalidGrant("This request has already been used.");
      });
    }

    private async lookup(column: "id_hash" | "uid_hash", value: string) {
      const result = await database.query(
        `SELECT * FROM oauth_provider_records
        WHERE model=$1 AND ${column}=$2 AND (expires_at IS NULL OR expires_at>now())`,
        [this.model, digest(value)],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const payload = JSON.parse(
        this.cipher.decrypt(
          {
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            authenticationTag: row.authentication_tag,
            valueDigest: row.value_digest,
            keyId: row.key_id,
          },
          { purpose: "oauth-provider", model: this.model, idHash: row.id_hash },
        ),
      ) as AdapterPayload;
      // Older testing-only tokens inherited OIDC's browser-session binding.
      // Honor their already-approved connection lifetime without rewriting or
      // resurrecting a token. The query still enforces token expiry; provider
      // grant validation and the workspace connection remain authoritative.
      if (
        ["AccessToken", "RefreshToken"].includes(this.model) &&
        payload.grantId &&
        typeof payload.scope === "string" &&
        payload.scope.split(" ").includes(testingScope)
      )
        payload.expiresWithSession = false;
      if (row.consumed_at)
        payload.consumed = Math.floor(new Date(row.consumed_at).getTime() / 1000);
      return payload;
    }
    find(id: string) {
      return this.lookup("id_hash", id);
    }
    findByUid(uid: string) {
      return this.lookup("uid_hash", uid);
    }
    async findByUserCode() {
      return undefined;
    } // Device authorization is not enabled.
    async consume(id: string) {
      const result = await database.query(
        "UPDATE oauth_provider_records SET consumed_at=now() WHERE model=$1 AND id_hash=$2 AND consumed_at IS NULL RETURNING id_hash",
        [this.model, digest(id)],
      );
      if (!result.rowCount) throw new errors.InvalidGrant("This request has already been used.");
    }
    async destroy(id: string) {
      await database.query("DELETE FROM oauth_provider_records WHERE model=$1 AND id_hash=$2", [
        this.model,
        digest(id),
      ]);
    }
    async revokeByGrantId(grantId: string) {
      await database.transaction(async (client) => {
        await client.query(
          "UPDATE oauth_connections SET revoked_at=COALESCE(revoked_at,now()) WHERE grant_hash=$1",
          [digest(grantId)],
        );
        await client.query("DELETE FROM oauth_provider_records WHERE grant_hash=$1", [
          digest(grantId),
        ]);
        await client.query("DELETE FROM oauth_renewal_receipts WHERE grant_hash=$1", [
          digest(grantId),
        ]);
      });
    }
  };
}
