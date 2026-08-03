import { randomUUID } from "node:crypto";
import type { ArtifactStore, VeilEvidenceAdmissionProof } from "@scry/artifact";
import type { Database } from "./database.js";

type DueArtifact = { id: string; storageKey: string; observation: Record<string, unknown>; attempts: number; claimToken: string };
export type RetentionResult = Readonly<{ artifactId: string; status: "destroyed" | "retry"; outcome: "deleted" | "missing" | "tampered" | "storage_failure"; attempts: number }>;

export class ArtifactRetentionService {
  constructor(private readonly database: Pick<Database, "query">, private readonly store: ArtifactStore, private readonly now: () => Date = () => new Date()) {}

  async runBatch(limit = 50): Promise<readonly RetentionResult[]> {
    const claimed = await this.claim(Math.max(1, Math.min(500, Math.floor(limit))));
    return Promise.all(claimed.map((artifact) => this.destroy(artifact)));
  }

  private async claim(limit: number): Promise<DueArtifact[]> {
    const claimToken = randomUUID();
    const result = await this.database.query<DueArtifact>(
      `WITH due AS (
         SELECT id FROM artifacts
         WHERE availability='available' AND retention_until <= $1
           AND (destruction_next_attempt_at IS NULL OR destruction_next_attempt_at <= $1)
           AND (destruction_status IN ('pending','retry') OR (destruction_status='deleting' AND destruction_claimed_at < $1::timestamptz - interval '5 minutes'))
         ORDER BY retention_until,id FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE artifacts a SET destruction_status='deleting', destruction_claim_token=$3,
         destruction_claimed_at=$1, destruction_attempts=destruction_attempts+1
       FROM due WHERE a.id=due.id
       RETURNING a.id,a.storage_key AS "storageKey",a.metadata AS observation,
         a.destruction_attempts AS attempts,a.destruction_claim_token AS "claimToken"`,
      [this.now().toISOString(), limit, claimToken],
    );
    return result.rows;
  }

  private async destroy(artifact: DueArtifact): Promise<RetentionResult> {
    try {
      const proof = proofFrom(artifact);
      const destruction = await this.store.destroy(artifact.storageKey, proof);
      await this.database.query(
        `UPDATE artifacts SET availability='destroyed',privacy_classification='uncertain',storage_key=NULL,
           destruction_status='destroyed',destruction_claim_token=NULL,destruction_claimed_at=NULL,
           destruction_next_attempt_at=NULL,destroyed_at=$3,reason_code='RETENTION_EXPIRED',
           metadata=(metadata - 'veilAdmissionToken' - 'veilManifest' - 'veilSanitation') || $4::jsonb
         WHERE id=$1 AND destruction_status='deleting' AND destruction_claim_token=$2`,
        [artifact.id, artifact.claimToken, this.now().toISOString(), JSON.stringify({ retentionDestruction: { outcome: destruction.outcome, bytesDestroyed: true, attempts: artifact.attempts } })],
      );
      return Object.freeze({ artifactId: artifact.id, status: "destroyed", outcome: destruction.outcome, attempts: artifact.attempts });
    } catch {
      const delaySeconds = Math.min(3600, 2 ** Math.min(artifact.attempts, 10));
      await this.database.query(
        `UPDATE artifacts SET destruction_status='retry',destruction_claim_token=NULL,destruction_claimed_at=NULL,
           destruction_next_attempt_at=$3::timestamptz + ($4 || ' seconds')::interval,
           metadata=metadata || $5::jsonb
         WHERE id=$1 AND destruction_status='deleting' AND destruction_claim_token=$2`,
        [artifact.id, artifact.claimToken, this.now().toISOString(), delaySeconds, JSON.stringify({ retentionDestruction: { outcome: "storage_failure", bytesDestroyed: false, attempts: artifact.attempts } })],
      );
      return Object.freeze({ artifactId: artifact.id, status: "retry", outcome: "storage_failure", attempts: artifact.attempts });
    }
  }
}

function proofFrom(artifact: DueArtifact): VeilEvidenceAdmissionProof {
  // The storage boundary deliberately receives malformed proofs too: it
  // classifies them as tampered and still destroys the bytes fail-safely.
  return {
    manifest: artifact.observation.veilManifest as VeilEvidenceAdmissionProof["manifest"],
    token: typeof artifact.observation.veilAdmissionToken === "string" ? artifact.observation.veilAdmissionToken : "",
    sanitation: artifact.observation.veilSanitation && typeof artifact.observation.veilSanitation === "object" ? artifact.observation.veilSanitation as Record<string, unknown> : {},
  };
}
