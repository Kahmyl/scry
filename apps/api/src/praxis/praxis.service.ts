import { Injectable, Inject } from "@nestjs/common";
import { Database } from "../infrastructure/index.js";
import { RunQueueService } from "../runtime/index.js";
import { PraxisRuntimeRepository } from "./repositories/praxis-runtime.repository.js";

@Injectable()
export class PraxisService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(RunQueueService) private readonly queue: RunQueueService,
    @Inject(PraxisRuntimeRepository)
    private readonly runtime: PraxisRuntimeRepository,
  ) {}

  getInspection(requestId: string) {
    return this.runtime.get(requestId);
  }

  async createInspection(input: {
    intent: unknown;
    allowedOrigins: string[];
    probeSessionId: string;
  }) {
    const browserLeaseId = undefined;

    if (!browserLeaseId) {
      throw new Error("AUTHORING_BROWSER_SESSION_UNAVAILABLE");
    }

    const id = crypto.randomUUID();

    await this.database.query(
      `INSERT INTO praxis_candidate_requests(id,status,payload)
       VALUES($1,'queued',$2::jsonb)`,
      [
        id,
        JSON.stringify({
          intent: input.intent,
          allowedOrigins: input.allowedOrigins,
          probeSessionId: input.probeSessionId,
        }),
      ],
    );

    await this.queue.praxisQueue.add(
      "inspect",
      {
        requestId: id,
        releaseId: process.env.SCRY_RELEASE_ID ?? "development",
        schemaFingerprint:
          process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
      },
      { jobId: id },
    );

    return { requestId: id, status: "queued" };
  }
}
