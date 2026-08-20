import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectConfigurationRepository } from "../src/access/repositories/project-configuration.repository.js";
import { Database } from "../src/infrastructure/index.js";

const databaseUrl = process.env.SCRY_CREDENTIAL_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Project credential PostgreSQL ownership", () => {
  let database: Database;
  let repository: ProjectConfigurationRepository;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const missionA = randomUUID();
  const missionB = randomUUID();
  const principal = {
    kind: "user" as const,
    subject: "owner",
    userId: randomUUID(),
    email: "owner@example.test",
    workspaceId,
    role: "owner" as const,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    repository = new ProjectConfigurationRepository(database);
    await database.query(
      `INSERT INTO workspaces(id,name,slug) VALUES
      ($1,'Credential scope',$3),($2,'Other scope',$4)`,
      [workspaceId, otherWorkspaceId, `credential-${workspaceId}`, `other-${otherWorkspaceId}`],
    );
    await database.query(
      `INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Credential scope')`,
      [projectId, workspaceId],
    );
  });

  afterAll(async () => database?.onModuleDestroy());

  it("creates without Missions and remains discoverable after later Mission completion", async () => {
    const created = await repository.createCredential(principal, projectId, {
      name: `Reusable ${randomUUID()}`,
      value: "integration-secret-canary",
    });
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status)
      VALUES($1,$3,'Mission A','Use existing credential','completed'),
            ($2,$3,'Mission B','Reuse existing credential','running')`,
      [missionA, missionB, projectId],
    );
    const listed = await repository.listCredentialCandidates(principal, projectId);
    expect(listed.items).toContainEqual(
      expect.objectContaining({
        id: created.id,
        projectId,
        securityStatus: "active",
        eligibleForAuthorization: true,
      }),
    );
    const persisted = await database.query(
      `SELECT origin_mission_id,origin_objective_id,
      created_by_agent_session_id FROM project_credentials WHERE id=$1`,
      [created.id],
    );
    expect(persisted.rows[0]).toEqual({
      origin_mission_id: null,
      origin_objective_id: null,
      created_by_agent_session_id: null,
    });
  });

  it("does not disclose Project credentials across workspace scope", async () => {
    const otherPrincipal = { ...principal, workspaceId: otherWorkspaceId };
    await expect(repository.listCredentials(otherPrincipal, projectId)).rejects.toThrow(
      "Project not found",
    );
  });
});
