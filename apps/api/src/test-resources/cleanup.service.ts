import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { cleanupDecisionSchema, type CleanupDecision } from "@scry/contracts";
import { TestResourcesRepository } from "./test-resources.repository.js";
import { TestResourcesService } from "./test-resources.service.js";
import { workflowDigest, immutableWorkflowInput } from "../browser-execution/workflow-input.js";
import { resourceError } from "./provider-http.js";

@Injectable()
export class CleanupService {
  constructor(
    @Inject(TestResourcesRepository) private readonly resources: TestResourcesRepository,
    @Inject(TestResourcesService) private readonly service: TestResourcesService,
  ) {}

  async list(workspace: string | undefined, mission: string) {
    await this.resources.requireMission(workspace, mission);
    const items = await this.resources.db.boundedTransaction(async (c) => {
      const resources = await c.query(
        `SELECT id,'resource' AS kind,name AS label,state,ownership,expires_at AS "expiresAt" FROM test_resources WHERE mission_id=$1`,
        [mission],
      );
      const credentials = await c.query(
        `SELECT v.id,'credential' AS kind,v.display_name AS label,v.state,CASE WHEN v.mission_id=$1 THEN 'mission' ELSE 'shared_preexisting' END AS ownership,v.expires_at AS "expiresAt" FROM protected_values v WHERE v.mission_id=$1 OR EXISTS(SELECT 1 FROM browser_session_protected_inputs b JOIN browser_execution_sessions s ON s.id=b.session_id JOIN runs r ON r.id=s.run_id WHERE b.protected_value_id=v.id AND r.mission_id=$1) OR EXISTS(SELECT 1 FROM test_resources t WHERE t.mission_id=$1 AND t.password_credential_id=v.id)`,
        [mission],
      );
      const decisions = await c.query(
        `SELECT DISTINCT ON(kind,item_id) kind,item_id AS "itemId",decision,reason,created_at AS "decidedAt" FROM mission_cleanup_decisions WHERE mission_id=$1 ORDER BY kind,item_id,created_at DESC,id DESC`,
        [mission],
      );
      return [...resources.rows, ...credentials.rows].map((item) => {
        const decision = decisions.rows.find((d) => d.kind === item.kind && d.itemId === item.id);
        const ended =
          item.kind === "resource"
            ? item.state === "closed"
            : ["revoked", "expired", "deleted", "compromised"].includes(item.state) ||
              !!(item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now());
        return {
          ...item,
          ...(decision
            ? {
                decision: decision.decision,
                reason: decision.reason,
                decidedAt: decision.decidedAt,
              }
            : {}),
          cleanupStatus: ended
            ? "ended"
            : decision?.decision === "retain"
              ? "retained"
              : decision
                ? "pending"
                : "decision_required",
          allowedDecisions:
            item.kind === "resource"
              ? ["retain", "close"]
              : item.ownership === "mission"
                ? ["retain", "revoke"]
                : ["retain"],
        };
      });
    }, 3000);
    return {
      missionId: mission,
      items,
      complete: items.every((i) => ["ended", "retained"].includes(i.cleanupStatus)),
      note: "Recorded observations remain available. Shared credentials are never revoked by this ledger. Retained resources still expire normally.",
    };
  }

  async decide(workspace: string | undefined, mission: string, requested: CleanupDecision) {
    const input = immutableWorkflowInput(cleanupDecisionSchema.parse(requested)),
      digest = workflowDigest(input);
    await this.resources.requireMission(workspace, mission);
    await this.resources.db.boundedTransaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [mission + ":cleanup"]);
      const prior = await c.query(
        "SELECT input_digest FROM mission_cleanup_decisions WHERE mission_id=$1 AND idempotency_key=$2",
        [mission, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].input_digest !== digest)
          resourceError("CLEANUP_IDEMPOTENCY_CONFLICT", 409);
        return;
      }
      if (input.kind === "resource") {
        if (input.decision === "revoke") resourceError("CLEANUP_DECISION_INVALID", 400);
        const item = await c.query(
          "SELECT id FROM test_resources WHERE id=$1 AND mission_id=$2 FOR UPDATE",
          [input.itemId, mission],
        );
        if (!item.rowCount) resourceError("CLEANUP_ITEM_NOT_FOUND", 404);
      } else {
        if (input.decision === "close") resourceError("CLEANUP_DECISION_INVALID", 400);
        const item = await c.query(
          `SELECT v.mission_id FROM protected_values v WHERE v.id=$1 AND (v.mission_id=$2 OR EXISTS(SELECT 1 FROM browser_session_protected_inputs b JOIN browser_execution_sessions s ON s.id=b.session_id JOIN runs r ON r.id=s.run_id WHERE b.protected_value_id=v.id AND r.mission_id=$2) OR EXISTS(SELECT 1 FROM test_resources t WHERE t.mission_id=$2 AND t.password_credential_id=v.id)) FOR UPDATE`,
          [input.itemId, mission],
        );
        if (!item.rowCount) resourceError("CLEANUP_ITEM_NOT_FOUND", 404);
        if (input.decision === "revoke") {
          if (item.rows[0].mission_id !== mission)
            resourceError("CLEANUP_SHARED_CREDENTIAL_RETAINED", 409);
          const active = await c.query(
            `SELECT 1 FROM browser_session_protected_inputs b JOIN browser_execution_sessions s ON s.id=b.session_id WHERE b.protected_value_id=$1 AND s.state NOT IN ('completed','failed','cancelled') LIMIT 1`,
            [input.itemId],
          );
          if (active.rowCount) resourceError("CLEANUP_CREDENTIAL_IN_USE", 409);
          await c.query(
            "UPDATE protected_values SET state='revoked' WHERE id=$1 AND state='active'",
            [input.itemId],
          );
        }
      }
      await c.query(
        "INSERT INTO mission_cleanup_decisions(id,mission_id,kind,item_id,decision,reason,idempotency_key,input_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          randomUUID(),
          mission,
          input.kind,
          input.itemId,
          input.decision,
          input.reason,
          input.idempotencyKey,
          digest,
        ],
      );
    }, 3000);
    // The durable intent precedes external cleanup. Failure remains pending;
    // exact retry resumes the SAME resource and never provisions a replacement.
    if (input.kind === "resource" && input.decision === "close")
      await this.service.close(workspace, input.itemId);
    return this.list(workspace, mission);
  }
}
