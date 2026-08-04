import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { browserObservationRuntimeHealth } from "@scry/praxis";
import {
  PRAXIS_CONTRACT_VERSION,
  PRAXIS_RUNTIME_VERSION,
  PRAXIS_SCORING_POLICY_VERSION,
} from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

export type ReleaseAdmissionStatus = {
  ready: boolean;
  schemaReady: boolean;
  compatibleWorkerCount: number;
  incompatibleWorkers: Array<{
    workerId: string;
    releaseId: string;
    schemaFingerprint: string;
    praxisContractVersion: number;
    praxisRuntimeVersion: string;
    praxisScoringPolicyVersion: number;
  }>;
  releaseId: string;
  schemaFingerprint: string;
  browserRuntimeReady: boolean;
  praxisReady: boolean;
  praxis: { contractVersion: number; runtimeVersion: string; scoringPolicyVersion: number };
};

@Injectable()
export class ReleaseAdmissionService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async status(): Promise<ReleaseAdmissionStatus> {
    const releaseId = process.env.SCRY_RELEASE_ID ?? "development";
    const schemaFingerprint = process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline";
    const [baseline, workers, runtime] = await Promise.all([
      this.database.query<{ schemaFingerprint: string }>(
        `SELECT schema_fingerprint AS "schemaFingerprint" FROM schema_baseline WHERE singleton = true`,
      ),
      this.database.query<{
        workerId: string;
        releaseId: string;
        schemaFingerprint: string;
        praxisContractVersion: number;
        praxisRuntimeVersion: string;
        praxisScoringPolicyVersion: number;
      }>(
        `SELECT worker_id AS "workerId", release_id AS "releaseId", schema_fingerprint AS "schemaFingerprint",
                praxis_contract_version AS "praxisContractVersion", praxis_runtime_version AS "praxisRuntimeVersion",
                praxis_scoring_policy_version AS "praxisScoringPolicyVersion"
         FROM worker_heartbeats WHERE heartbeat_at > now() - interval '30 seconds'`,
      ),
      this.database.query<{ ready: boolean; runtimeHash: string; capabilityManifestHash: string }>(
        `SELECT ready,runtime_hash AS "runtimeHash",capability_manifest_hash AS "capabilityManifestHash" FROM browser_runtime_manifests WHERE release_id=$1 AND schema_fingerprint=$2 ORDER BY created_at DESC LIMIT 1`,
        [releaseId, schemaFingerprint],
      ),
    ]);
    const incompatibleWorkers = workers.rows.filter(
      (worker) =>
        worker.releaseId !== releaseId ||
        worker.schemaFingerprint !== schemaFingerprint ||
        worker.praxisContractVersion !== PRAXIS_CONTRACT_VERSION ||
        worker.praxisRuntimeVersion !== PRAXIS_RUNTIME_VERSION ||
        worker.praxisScoringPolicyVersion !== PRAXIS_SCORING_POLICY_VERSION,
    );
    const compatibleWorkerCount = workers.rows.length - incompatibleWorkers.length;
    const schemaReady = baseline.rows[0]?.schemaFingerprint === schemaFingerprint;
    const expectedRuntime = browserObservationRuntimeHealth();
    const browserRuntimeReady =
      runtime.rows[0]?.ready === true &&
      runtime.rows[0]?.runtimeHash === expectedRuntime.runtimeHash &&
      runtime.rows[0]?.capabilityManifestHash === expectedRuntime.capabilityManifestHash;
    const praxisReady = compatibleWorkerCount > 0 && incompatibleWorkers.length === 0;
    return {
      ready: schemaReady && browserRuntimeReady && praxisReady,
      schemaReady,
      compatibleWorkerCount,
      incompatibleWorkers,
      releaseId,
      schemaFingerprint,
      browserRuntimeReady,
      praxisReady,
      praxis: {
        contractVersion: PRAXIS_CONTRACT_VERSION,
        runtimeVersion: PRAXIS_RUNTIME_VERSION,
        scoringPolicyVersion: PRAXIS_SCORING_POLICY_VERSION,
      },
    };
  }

  async assertAcceptingWork() {
    let status: ReleaseAdmissionStatus;
    try {
      status = await this.status();
    } catch {
      throw new ServiceUnavailableException({
        code: "RELEASE_ADMISSION_UNAVAILABLE",
        message: "Scry cannot prove release and schema compatibility.",
      });
    }
    if (!status.ready) {
      throw new ServiceUnavailableException({
        code: "RELEASE_ADMISSION_BLOCKED",
        message:
          "Scry is not accepting executable work until API, worker, and schema agreement is restored.",
        status,
      });
    }
    return status;
  }
}
