import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { TestResourcesRepository } from "../src/test-resources/test-resources.repository.js";
import { TestResourcesService } from "../src/test-resources/test-resources.service.js";
import { TestResourceProviders } from "../src/test-resources/providers.js";
import { seedSession } from "./fixtures/browser-session.js";

const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(target ? describe : describe.skip)("captured message protection upgrades", () => {
  let db: Database, repo: TestResourcesRepository, service: TestResourcesService;
  let workspace: string, mission: string, session: string, run: string;
  const claim = "fictional-owner-claim-20261125";
  const link = `https://fixture.example/partner-team-invitations/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/accept#token=${claim}`;
  const content = () => ({
    text: "Join as Owner: https://fixture.example/accept#[PROTECTED:ASSIGNMENT-SECRET]",
    html: [`<a href="${link.replace("#token=", "#token&#x3D;")}">Join as Owner</a>`],
    from: { address: "invites@fixture.example" },
  });
  beforeAll(async () => {
    process.env.DATABASE_URL = target;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    db = new Database();
    const cipher = new BrowserProtectedValueCipher();
    repo = new TestResourcesRepository(db, cipher);
    const providers = new TestResourceProviders(db);
    vi.spyOn(providers, "messages").mockRejectedValue(Error("PROVIDER_FETCH_NOT_ALLOWED"));
    service = new TestResourcesService(repo, providers, new BrowserCommandRepository(db, cipher));
    session = await seedSession(
      db,
      new BrowserExecutionRepository(db, cipher),
      "https://fixture.example",
    );
    const facts = (
      await db.query(
        "SELECT r.id,r.mission_id,p.workspace_id FROM runs r JOIN projects p ON p.id=r.project_id JOIN browser_execution_sessions s ON s.run_id=r.id WHERE s.id=$1",
        [session],
      )
    ).rows[0]!;
    workspace = facts.workspace_id;
    mission = facts.mission_id;
    run = facts.id;
    await db.query("UPDATE runs SET state='running' WHERE id=$1", [run]);
  });
  afterAll(async () => {
    if (session)
      await db.query(
        "UPDATE browser_execution_sessions SET state='completed',terminal_at=now() WHERE id=$1",
        [session],
      );
    await db?.onModuleDestroy();
  });
  async function resource() {
    const row = await repo.allocate(workspace, mission, {
      kind: "mailbox",
      name: "Owner invitation fixture",
      idempotencyKey: randomUUID(),
      expiresInSeconds: 3600,
    });
    const lease = (await repo.claim(row))!;
    await repo.ready(row.id, lease, "fictional@example.test", {});
    await repo.release(row.id, lease);
    return repo.resource(workspace, row.id);
  }
  async function legacy(savedContent: unknown = content(), age = "0 seconds") {
    const row = await resource(),
      id = randomUUID(),
      providerId = randomUUID();
    await db.query(
      "INSERT INTO test_resource_events(id,resource_id,provider_event_id,received_at,recorded_at,title,safe_content) VALUES($1,$2,$3,now()-interval '2 minutes',now()-$5::interval,'Owner invitation',$4::jsonb)",
      [id, row.id, providerId, JSON.stringify(savedContent), age],
    );
    return { row, id, providerId };
  }
  const countSecrets = async (id: string) =>
    Number(
      (
        await db.query("SELECT count(*) AS n FROM protected_values WHERE display_name=$1", [
          `Test link ${id}`,
        ])
      ).rows[0]!.n,
    );

  it("recovers the existing event with one encrypted exact-value handoff and no provider request", async () => {
    const { row, id, providerId } = await legacy();
    const before = (
      await db.query("SELECT received_at,recorded_at FROM test_resource_events WHERE id=$1", [id])
    ).rows[0];
    const first = await service.read(workspace, row.id, { refresh: false, waitSeconds: 0 });
    expect(first).toMatchObject({ status: "received", cached: true });
    expect(first.timing.providerRequests).toBe(0);
    expect(first.events).toHaveLength(1);
    const event = first.events[0]!;
    expect(event.id).toBe(id);
    expect(event.secrets).toHaveLength(1);
    expect(event.secrets[0]!.kind).toBe("link");
    expect(JSON.stringify(event)).not.toContain(claim);
    expect(JSON.stringify(event)).toContain("Join as Owner");
    const ref = event.secrets[0]!.protectedValueId;
    expect(await service.useSecret(workspace, row.id, run, ref)).toMatchObject({ added: 1 });
    expect(await service.commands.protectedValueForBrowser(session, ref)).toBe(link);
    const saved = (
      await db.query(
        "SELECT provider_event_id,received_at,recorded_at,safe_content,protection_version FROM test_resource_events WHERE id=$1",
        [id],
      )
    ).rows[0]!;
    expect(saved).toMatchObject({
      ...before,
      provider_event_id: providerId,
      protection_version: 1,
    });
    expect(JSON.stringify(saved)).not.toContain(claim);
    const encrypted = (
      await db.query("SELECT ciphertext,mission_id FROM protected_values WHERE id=$1", [ref])
    ).rows[0]!;
    expect(encrypted.mission_id).toBe(mission);
    expect(encrypted.ciphertext.toString()).not.toContain(claim);
    expect(
      (await service.read(workspace, row.id, { refresh: false, waitSeconds: 0 })).events,
    ).toEqual(first.events);
    expect(await countSecrets(id)).toBe(1);
  });
  it("serializes concurrent cached reads and a lost-response retry into one reference set", async () => {
    const { row, id } = await legacy();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repo.events(workspace, row.id)),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await countSecrets(id)).toBe(1);
    expect(await repo.events(workspace, row.id)).toEqual(results[0]);
  });
  it("rolls back reference creation with a failed projection write and safely retries", async () => {
    const { row, id } = await legacy();
    await db.query(
      `CREATE FUNCTION fixture_reject_message_upgrade() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${id}'::uuid THEN RAISE EXCEPTION 'FICTIONAL_PROJECTION_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    await db.query(
      "CREATE TRIGGER fixture_reject_message_upgrade BEFORE UPDATE ON test_resource_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_message_upgrade()",
    );
    try {
      await expect(repo.events(workspace, row.id)).rejects.toThrow("FICTIONAL_PROJECTION_FAILURE");
      expect(await countSecrets(id)).toBe(0);
      expect(
        (
          await db.query(
            "SELECT protection_version,protected_refs FROM test_resource_events WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toMatchObject({ protection_version: 0, protected_refs: [] });
    } finally {
      await db.query("DROP TRIGGER fixture_reject_message_upgrade ON test_resource_events");
      await db.query("DROP FUNCTION fixture_reject_message_upgrade()");
    }
    expect((await repo.events(workspace, row.id))[0]!.secrets).toHaveLength(1);
    expect(await countSecrets(id)).toBe(1);
  });
  it("denies foreign workspace repair before creating references", async () => {
    const { row, id } = await legacy();
    await expect(repo.events(randomUUID(), row.id)).rejects.toThrow("TEST_RESOURCE_NOT_FOUND");
    expect(await countSecrets(id)).toBe(0);
    expect(
      (await db.query("SELECT protection_version FROM test_resource_events WHERE id=$1", [id]))
        .rows[0]!.protection_version,
    ).toBe(0);
  });
  it("repairs a disconnected resource without renewing expired access", async () => {
    const { row, id } = await legacy(content(), "2 days");
    await db.query("UPDATE test_resources SET state='closed',address=NULL WHERE id=$1", [row.id]);
    const event = (await repo.events(workspace, row.id))[0]!;
    expect(event.secrets).toHaveLength(1);
    await expect(
      service.useSecret(workspace, row.id, run, event.secrets[0]!.protectedValueId),
    ).rejects.toThrow("SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE");
    expect(
      (
        await db.query(
          "SELECT v.expires_at=e.recorded_at+interval '1 day' AS anchored FROM protected_values v JOIN test_resource_events e ON e.id=$1 WHERE v.id=$2",
          [id, event.secrets[0]!.protectedValueId],
        )
      ).rows[0]!.anchored,
    ).toBe(true);
  });
  it("preserves revoked references without fabricating replacements from masked content", async () => {
    const row = await resource(),
      lease = (await repo.claim(row))!;
    await repo.record(row, lease, [
      {
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        title: "Owner invitation",
        content: content(),
      },
    ]);
    await repo.release(row.id, lease);
    const before = (await repo.events(workspace, row.id))[0]!;
    await db.query("UPDATE protected_values SET state='revoked' WHERE id=$1", [
      before.secrets[0]!.protectedValueId,
    ]);
    await db.query("UPDATE test_resource_events SET protection_version=0 WHERE id=$1", [before.id]);
    const after = (await repo.events(workspace, row.id))[0]!;
    expect(after).toEqual(before);
    expect(await countSecrets(before.id)).toBe(1);
    await expect(
      service.useSecret(workspace, row.id, run, after.secrets[0]!.protectedValueId),
    ).rejects.toThrow("SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE");
  });
  it("bounds oversized legacy/new messages while committing an honest withheld observation", async () => {
    const { row } = await legacy({ text: "x".repeat(16385) });
    const repaired = (await repo.events(workspace, row.id))[0]!;
    expect(repaired).toMatchObject({
      title: "Message withheld",
      content: "[PROTECTED:MESSAGE_LIMIT]",
      secrets: [],
    });
    const fresh = await resource(),
      lease = (await repo.claim(fresh))!;
    await repo.record(fresh, lease, [
      {
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        title: "Large",
        content: { text: "x".repeat(16385) },
      },
    ]);
    await repo.release(fresh.id, lease);
    expect((await repo.events(workspace, fresh.id))[0]).toMatchObject({
      title: "Message withheld",
      content: "[PROTECTED:MESSAGE_LIMIT]",
      secrets: [],
    });
  });
  it("does not reactivate a revoked claim when a legacy HTML alias still contains it", async () => {
    const { row } = await legacy();
    const first = (await repo.events(workspace, row.id))[0]!;
    const ref = first.secrets[0]!.protectedValueId;
    await db.query("UPDATE protected_values SET state='revoked' WHERE id=$1", [ref]);
    await db.query(
      "UPDATE test_resource_events SET safe_content=$2::jsonb,protection_version=0 WHERE id=$1",
      [first.id, JSON.stringify(content())],
    );
    const next = (await repo.events(workspace, row.id))[0]!;
    expect(next.secrets).toEqual(first.secrets);
    expect(JSON.stringify(next)).not.toContain(claim);
    expect(await countSecrets(first.id)).toBe(1);
    await expect(service.useSecret(workspace, row.id, run, ref)).rejects.toThrow(
      "SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE",
    );
  });
  it("handles the full 200-event legacy resource within the normal cached-read budget", async () => {
    const row = await resource();
    const maximal = {
      html: Array.from(
        { length: 20 },
        (_, i) =>
          `<a href="https://fixture.example/accept#token&#61;fictional-capacity-${i}">Owner</a>`,
      ),
    };
    await db.query(
      "INSERT INTO test_resource_events(id,resource_id,provider_event_id,received_at,title,safe_content) SELECT gen_random_uuid(),$1,'fixture-'||n,now(),'Owner invitation',$2::jsonb FROM generate_series(1,200) n",
      [row.id, JSON.stringify(maximal)],
    );
    const result = await service.read(workspace, row.id, { refresh: false, waitSeconds: 0 });
    expect(result.events).toHaveLength(200);
    expect(result.events.every((event) => event.secrets.length === 20)).toBe(true);
    expect(result.timing.elapsedMs).toBeLessThan(result.timing.serverBudgetMs);
    expect(result.timing.providerRequests).toBe(0);
    expect(JSON.stringify(result)).not.toContain("fictional-capacity");
  });
});
