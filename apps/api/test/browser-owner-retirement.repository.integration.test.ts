import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PraxisOwnerRetirement } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
live("durable confirmed-owner retirement", () => {
  let database: Database, effects: BrowserExecutionRepository;
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    effects = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
  });
  afterAll(async () => database?.onModuleDestroy());
  const owned = async () => {
    const sessionId = await seedSession(database, effects, "https://fixture.example");
    const claim = await effects.claimOwner(sessionId, "fixture", 60000);
    return { sessionId, generation: claim.generation, leaseToken: claim.leaseToken };
  };
  const receipt = (owner: Awaited<ReturnType<typeof owned>>): PraxisOwnerRetirement => ({
    owner,
    browserStopped: true,
    recordingDrained: true,
  });
  const admitted = async () => {
    const owner = await owned();
    const input = {
      sessionId: owner.sessionId,
      ownerGeneration: owner.generation,
      documentEpoch: 1,
      idempotencyKey: randomUUID(),
      effectClass: "authentication" as const,
      expectedOrigin: "https://fixture.example",
      targetDigest: "a".repeat(64),
      actionDigest: "b".repeat(64),
      intentSummary: "fixture intent",
    };
    return { owner, input, effect: (await effects.admitEffect(input)).effect };
  };
  const facts = async (id: string) =>
    (
      await database.query(
        "SELECT mutation_outcome,determination_source,dispatch_state FROM browser_effects WHERE id=$1",
        [id],
      )
    ).rows[0]!;
  const state = async (sessionId: string, generation: number) =>
    (
      await database.query(
        "SELECT state,replacement_reason,terminal_at FROM browser_owner_generations WHERE session_id=$1 AND generation=$2",
        [sessionId, generation],
      )
    ).rows[0]!;
  const budget = async (sessionId: string) =>
    (
      await database.query<{ used: number }>(
        "SELECT authentication_commits_used AS used FROM browser_execution_sessions WHERE id=$1",
        [sessionId],
      )
    ).rows[0]!.used;
  it("releases a confirmed stopped current owner and permits immediate replacement", async () => {
    const owner = await owned();
    await effects.retireOwner(receipt(owner));
    expect(await state(owner.sessionId, owner.generation)).toMatchObject({
      state: "released",
      replacement_reason: "physical_retirement_confirmed",
    });
    expect((await effects.claimOwner(owner.sessionId, "replacement", 60000)).generation).toBe(2);
  });
  it("fences buffered evidence and effect writes after confirmed retirement", async () => {
    const { owner, effect } = await admitted();
    await effects.markDispatchStarted(effect.id, owner.generation);
    await effects.retireOwner(receipt(owner));
    await expect(effects.assertOwner(owner)).rejects.toThrow("OWNER_FENCED");
    expect(effects).not.toHaveProperty("withOwner");
    await expect(
      effects.markUnknown(effect.id, owner.generation, "late_old_owner"),
    ).rejects.toThrow("OWNER_FENCED");
    expect((await facts(effect.id)).determination_source).toBe("owner_retired_after_dispatch");
  });
  it("does not rewrite already determined effect facts during retirement", async () => {
    const { owner, effect } = await admitted();
    await effects.determine(
      effect.id,
      owner.generation,
      "not_applied",
      "fixture_proven_before_stop",
    );
    const before = await database.query("SELECT * FROM browser_effects WHERE id=$1", [effect.id]);
    const events = await database.query(
      "SELECT * FROM browser_effect_events WHERE effect_id=$1 ORDER BY sequence",
      [effect.id],
    );
    await effects.retireOwner(receipt(owner));
    expect(
      (await database.query("SELECT * FROM browser_effects WHERE id=$1", [effect.id])).rows,
    ).toEqual(before.rows);
    expect(
      (
        await database.query(
          "SELECT * FROM browser_effect_events WHERE effect_id=$1 ORDER BY sequence",
          [effect.id],
        )
      ).rows,
    ).toEqual(events.rows);
  });
  it("refunds never-dispatched intent exactly once across repeated receipts", async () => {
    const { owner, effect } = await admitted();
    await effects.retireOwner(receipt(owner));
    await effects.retireOwner(receipt(owner));
    expect(await facts(effect.id)).toMatchObject({
      mutation_outcome: "not_applied",
      determination_source: "owner_retired_before_dispatch",
      dispatch_state: "not_started",
    });
    expect(await budget(owner.sessionId)).toBe(0);
    const events = await database.query(
      "SELECT 1 FROM browser_effect_events WHERE effect_id=$1 AND type='not_applied'",
      [effect.id],
    );
    expect(events.rowCount).toBe(1);
  });
  it.each(["started", "acknowledged", "unknown"] as const)(
    "preserves possible external application after %s dispatch",
    async (dispatch) => {
      const { owner, effect, input } = await admitted();
      await effects.markDispatchStarted(effect.id, owner.generation);
      if (dispatch !== "started")
        await database.query(
          "UPDATE browser_effects SET dispatch_state=$2,response_observed_at=CASE WHEN $2='acknowledged' THEN clock_timestamp() ELSE NULL END WHERE id=$1",
          [effect.id, dispatch],
        );
      await effects.retireOwner(receipt(owner));
      expect(await facts(effect.id)).toMatchObject({
        mutation_outcome: "unknown",
        determination_source: "owner_retired_after_dispatch",
        dispatch_state: dispatch === "started" ? "unknown" : dispatch,
      });
      expect(await budget(owner.sessionId)).toBe(1);
      const next = await effects.claimOwner(owner.sessionId, "replacement", 60000);
      await expect(
        effects.admitEffect({
          ...input,
          ownerGeneration: next.generation,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow("EFFECT_UNRESOLVED");
    },
  );
  it("may reduce expired current authority without renewing it", async () => {
    const owner = await owned();
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
      [owner.sessionId],
    );
    await effects.retireOwner(receipt(owner));
    expect((await state(owner.sessionId, owner.generation)).state).toBe("released");
  });
  it("rejects a forged token without settling effects or returning budget", async () => {
    const { owner, effect } = await admitted();
    await expect(
      effects.retireOwner(receipt({ ...owner, leaseToken: randomUUID() })),
    ).rejects.toThrow("OWNER_FENCED");
    expect((await state(owner.sessionId, owner.generation)).state).toBe("active");
    expect((await facts(effect.id)).mutation_outcome).toBe("pending");
    expect(await budget(owner.sessionId)).toBe(1);
  });
  it.each(["replaced", "retired"] as const)(
    "cannot release or reconcile a new owner using an old %s receipt",
    async (mode) => {
      const owner = await owned();
      if (mode === "retired") await effects.retireOwner(receipt(owner));
      else
        await database.query(
          "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
          [owner.sessionId],
        );
      const next = await effects.claimOwner(owner.sessionId, "replacement", 60000);
      const { effect } = await effects.admitEffect({
        sessionId: owner.sessionId,
        ownerGeneration: next.generation,
        documentEpoch: 1,
        idempotencyKey: randomUUID(),
        effectClass: "authentication",
        expectedOrigin: "https://fixture.example",
        targetDigest: "a".repeat(64),
        actionDigest: "b".repeat(64),
        intentSummary: "new owner intent",
      });
      await effects.retireOwner(receipt(owner));
      expect((await state(owner.sessionId, next.generation)).state).toBe("active");
      expect((await facts(effect.id)).mutation_outcome).toBe("pending");
      expect(await budget(owner.sessionId)).toBe(1);
    },
  );
  it("serializes concurrent receipts without duplicate refund or event", async () => {
    const { owner, effect } = await admitted();
    await Promise.all(Array.from({ length: 8 }, () => effects.retireOwner(receipt(owner))));
    expect(await budget(owner.sessionId)).toBe(0);
    expect(
      (
        await database.query(
          "SELECT 1 FROM browser_effect_events WHERE effect_id=$1 AND type='not_applied'",
          [effect.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("serializes replacement against retirement without two active owners", async () => {
    const { owner, effect } = await admitted();
    const [retired, claimed] = await Promise.allSettled([
      effects.retireOwner(receipt(owner)),
      effects.claimOwner(owner.sessionId, "replacement", 60000),
    ]);
    expect(retired.status).toBe("fulfilled");
    if (claimed.status === "rejected")
      expect(claimed.reason.message).toBe("SCRY_BROWSER_OWNER_ACTIVE");
    const next =
      claimed.status === "fulfilled"
        ? claimed.value
        : await effects.claimOwner(owner.sessionId, "retry", 60000);
    expect(next.generation).toBe(2);
    expect((await facts(effect.id)).mutation_outcome).toBe("not_applied");
    expect(
      (
        await database.query(
          "SELECT 1 FROM browser_owner_generations WHERE session_id=$1 AND state='active'",
          [owner.sessionId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("rolls back owner state, effect outcome, budget and events together on a late SQL failure", async () => {
    const { owner, effect } = await admitted();
    const transaction = database.transaction.bind(database);
    const inject = vi.spyOn(database, "transaction").mockImplementationOnce((async (
      work: (client: PoolClient) => Promise<unknown>,
    ) =>
      transaction((client) =>
        work(
          new Proxy(client, {
            get(target, key, receiver) {
              if (key === "query")
                return (...args: unknown[]) => {
                  if (
                    typeof args[0] === "string" &&
                    args[0].includes("physical_retirement_confirmed")
                  )
                    return Promise.reject(new Error("injected_retirement_sql_failure"));
                  return Reflect.apply(target.query, target, args);
                };
              return Reflect.get(target, key, receiver);
            },
          }),
        ),
      )) as Database["transaction"]);
    try {
      await expect(effects.retireOwner(receipt(owner))).rejects.toThrow(
        "injected_retirement_sql_failure",
      );
    } finally {
      inject.mockRestore();
    }
    expect((await state(owner.sessionId, owner.generation)).state).toBe("active");
    expect((await facts(effect.id)).mutation_outcome).toBe("pending");
    expect(await budget(owner.sessionId)).toBe(1);
    expect(
      (
        await database.query(
          "SELECT 1 FROM browser_effect_events WHERE effect_id=$1 AND type='not_applied'",
          [effect.id],
        )
      ).rowCount,
    ).toBe(0);
    await effects.retireOwner(receipt(owner));
    expect(await budget(owner.sessionId)).toBe(0);
  });
  it.each(["browserStopped", "recordingDrained", "owner"] as const)(
    "rejects a receipt missing confirmed %s before any state changes",
    async (field) => {
      const owner = await owned(),
        invalid = { ...receipt(owner), [field]: field === "owner" ? undefined : false };
      await expect(
        effects.retireOwner(invalid as unknown as PraxisOwnerRetirement),
      ).rejects.toThrow("OWNER_RETIREMENT_UNCONFIRMED");
      expect((await state(owner.sessionId, owner.generation)).state).toBe("active");
    },
  );
  it("rejects an inconsistent active generation rather than reducing another owner's authority", async () => {
    const owner = await owned();
    await database.query(
      "UPDATE browser_execution_sessions SET active_owner_generation=$2 WHERE id=$1",
      [owner.sessionId, owner.generation + 1],
    );
    await expect(effects.retireOwner(receipt(owner))).rejects.toThrow("OWNER_FENCED");
    expect((await state(owner.sessionId, owner.generation)).state).toBe("active");
  });
});
