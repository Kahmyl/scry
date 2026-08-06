import { Inject, Injectable } from "@nestjs/common";

import { Database } from "../../infrastructure/index.js";

export type AuthenticationAttemptDispatchState =
  | "created"
  | "dispatching"
  | "dispatched"
  | "uncertain"
  | "blocked";

@Injectable()
export class AuthenticationAttemptRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async create(input: {
    probeSessionId: string;
    submissionMethod: string;
    credentialReferenceId?: string;
    safeMetadata?: Record<string, unknown>;
  }) {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO authentication_attempts(
         probe_session_id,
         submission_method,
         credential_reference_id,
         dispatch_state,
         safe_metadata
       )
       VALUES($1,$2,$3,'created',$4::jsonb)
       RETURNING id`,
      [
        input.probeSessionId,
        input.submissionMethod,
        input.credentialReferenceId ?? null,
        JSON.stringify(input.safeMetadata ?? {}),
      ],
    );

    return result.rows[0]!.id;
  }

  async beginDispatch(attemptId: string) {
    const result = await this.db.query(
      `UPDATE authentication_attempts
       SET dispatch_state='dispatching',
           dispatch_started_at=now()
       WHERE id=$1
         AND dispatch_state='created'`,
      [attemptId],
    );

    return Boolean(result.rowCount);
  }

  async finish(input: {
    attemptId: string;
    dispatchState: AuthenticationAttemptDispatchState;
    mutationBoundaryObserved: boolean;
    resultClassification: string;
    safeMetadata?: Record<string, unknown>;
  }) {
    await this.db.query(
      `UPDATE authentication_attempts
       SET dispatch_state=$2,
           mutation_boundary_observed=$3,
           result_classification=$4,
           safe_metadata=safe_metadata || $5::jsonb
       WHERE id=$1`,
      [
        input.attemptId,
        input.dispatchState,
        input.mutationBoundaryObserved,
        input.resultClassification,
        JSON.stringify(input.safeMetadata ?? {}),
      ],
    );
  }
}
