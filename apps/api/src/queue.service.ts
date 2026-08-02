import {
  ConflictException,
  Inject,
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Queue } from "bullmq";

import { ExecutionRepository } from "./execution.repository.js";
import { RedisConnection } from "./redis.js";
import { Database } from "./database.js";

export const RUN_QUEUE_NAME = "scry-runs";
export const CALIBRATION_QUEUE_NAME = "scry-calibrations";
export const PROBE_QUEUE_NAME = "scry-probes";
export type RunJob = { runId: string; releaseId: string; schemaFingerprint: string };
export type CalibrationJob = { calibrationSessionId: string; releaseId: string; schemaFingerprint: string };
export type ProbeJob = { probeSessionId: string; releaseId: string; schemaFingerprint: string };

@Injectable()
export class RunQueueService implements OnModuleDestroy, OnModuleInit {
  readonly queue: Queue<RunJob>;
  readonly calibrationQueue: Queue<CalibrationJob>;
  readonly probeQueue: Queue<ProbeJob>;
  private dispatcher?: NodeJS.Timeout;

  constructor(
    @Inject(RedisConnection) redis: RedisConnection,
    @Inject(ExecutionRepository) private readonly executions: ExecutionRepository,
    @Inject(Database) private readonly database: Database,
  ) {
    this.queue = new Queue<RunJob>(RUN_QUEUE_NAME, {
      connection: redis.client,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
    this.calibrationQueue = new Queue<CalibrationJob>(CALIBRATION_QUEUE_NAME, {
      connection: redis.client,
      defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 },
    });
    this.probeQueue = new Queue<ProbeJob>(PROBE_QUEUE_NAME, { connection: redis.client, defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 } });
  }

  async onModuleInit() {
    await this.dispatchPending().catch(() => undefined);
    this.dispatcher = setInterval(() => void this.dispatchPending().catch(() => undefined), 1_000);
  }

  async dispatchPending(limit = 100) {
    const pending = await this.database.query<RunJob>(
      `SELECT run_id AS "runId", release_id AS "releaseId", schema_fingerprint AS "schemaFingerprint"
       FROM run_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    ).catch(() => ({ rows: [], rowCount: 0 }));
    for (const item of pending.rows) {
      try {
        const existing = await this.queue.getJob(item.runId);
        if (!existing) await this.queue.add("execute", item, { jobId: item.runId });
        await this.database.query(`UPDATE run_outbox SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL WHERE run_id = $1`, [item.runId]);
      } catch (error) {
        await this.database.query(`UPDATE run_outbox SET publish_attempts = publish_attempts + 1, last_error = $2 WHERE run_id = $1`, [item.runId, error instanceof Error ? error.message : String(error)]);
      }
    }
    const calibrations = await this.database.query<CalibrationJob>(
      `SELECT calibration_session_id AS "calibrationSessionId", release_id AS "releaseId", schema_fingerprint AS "schemaFingerprint"
       FROM calibration_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    ).catch(() => ({ rows: [], rowCount: 0 }));
    for (const item of calibrations.rows) {
      try {
        const existing = await this.calibrationQueue.getJob(item.calibrationSessionId);
        if (existing) {
          const state = await existing.getState();
          if (state === "completed" || state === "failed") await existing.remove();
          else {
            await this.database.query(`UPDATE calibration_outbox SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL WHERE calibration_session_id = $1`, [item.calibrationSessionId]);
            continue;
          }
        }
        await this.calibrationQueue.add("calibrate", item, { jobId: item.calibrationSessionId });
        await this.database.query(`UPDATE calibration_outbox SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL WHERE calibration_session_id = $1`, [item.calibrationSessionId]);
      } catch (error) {
        await this.database.query(`UPDATE calibration_outbox SET publish_attempts = publish_attempts + 1, last_error = $2 WHERE calibration_session_id = $1`, [item.calibrationSessionId, error instanceof Error ? error.message : String(error)]);
      }
    }
    const probes=await this.database.query<ProbeJob>(`SELECT probe_session_id AS "probeSessionId",release_id AS "releaseId",schema_fingerprint AS "schemaFingerprint" FROM probe_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,[limit]).catch(()=>({rows:[],rowCount:0}));
    for(const item of probes.rows){try{const existing=await this.probeQueue.getJob(item.probeSessionId);if(!existing)await this.probeQueue.add("probe",item,{jobId:item.probeSessionId});await this.database.query(`UPDATE probe_outbox SET published_at=now(),publish_attempts=publish_attempts+1,last_error=NULL WHERE probe_session_id=$1`,[item.probeSessionId]);}catch(error){await this.database.query(`UPDATE probe_outbox SET publish_attempts=publish_attempts+1,last_error=$2 WHERE probe_session_id=$1`,[item.probeSessionId,error instanceof Error?error.message:String(error)]);}}
  }

  async start(runId: string) {
    const state = await this.executions.markQueued(runId);
    try {
      const existing = await this.queue.getJob(runId);
      if (!existing) {
        await this.queue.add("execute", {
          runId,
          releaseId: process.env.SCRY_RELEASE_ID ?? "development",
          schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
        }, { jobId: runId });
      }
    } catch (error) {
      throw new ConflictException(
        `Run was marked queued but could not be submitted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return state;
  }

  async cancel(runId: string) {
    const state = await this.executions.requestCancellation(runId);
    const job = await this.queue.getJob(runId);
    if (job) {
      const jobState = await job.getState();
      if (jobState === "waiting" || jobState === "delayed") {
        await job.remove();
        await this.executions.cancelQueuedRun(runId);
      }
    }
    return state;
  }

  async onModuleDestroy() {
    if (this.dispatcher) clearInterval(this.dispatcher);
    await this.queue.close();
    await this.calibrationQueue.close();
    await this.probeQueue.close();
  }
}
