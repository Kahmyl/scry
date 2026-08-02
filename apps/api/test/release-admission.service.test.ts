import { afterEach, describe, expect, it, vi } from "vitest";

import { FlowController } from "../src/flow.controller.js";
import { FlowService } from "../src/flow.service.js";
import { ReleaseAdmissionService } from "../src/release-admission.service.js";

const releaseId = "verification-release";
const schemaFingerprint = "verification-schema";
const praxis = { praxisContractVersion: 1, praxisRuntimeVersion: "1", praxisScoringPolicyVersion: 1 };

afterEach(() => {
  delete process.env.SCRY_RELEASE_ID;
  delete process.env.SCRY_SCHEMA_FINGERPRINT;
});

function configureRelease() {
  process.env.SCRY_RELEASE_ID = releaseId;
  process.env.SCRY_SCHEMA_FINGERPRINT = schemaFingerprint;
}

describe("release admission", () => {
  it("requires a fresh compatible worker and rejects a fresh incompatible worker", async () => {
    configureRelease();
    const { runtimeHash,capabilityManifestHash }=(await import("@scry/executor")).browserObservationRuntimeHealth();
    const database = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ schemaFingerprint }] })
        .mockResolvedValueOnce({ rows: [{ workerId: "current", releaseId, schemaFingerprint, ...praxis }] })
        .mockResolvedValueOnce({ rows: [{ ready: true,runtimeHash,capabilityManifestHash }] })
        .mockResolvedValueOnce({ rows: [{ schemaFingerprint }] })
        .mockResolvedValueOnce({ rows: [
          { workerId: "current", releaseId, schemaFingerprint, ...praxis },
          { workerId: "old", releaseId: "old-release", schemaFingerprint: "old-schema", praxisContractVersion: 0, praxisRuntimeVersion: "legacy", praxisScoringPolicyVersion: 0 },
        ] })
        .mockResolvedValueOnce({ rows: [{ ready: true,runtimeHash,capabilityManifestHash }] }),
    };
    const admission = new ReleaseAdmissionService(database as never);
    await expect(admission.status()).resolves.toMatchObject({ ready: true, compatibleWorkerCount: 1 });
    await expect(admission.assertAcceptingWork()).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: "RELEASE_ADMISSION_BLOCKED" }),
    });
  });

  it("fails closed when compatibility cannot be queried", async () => {
    configureRelease();
    const admission = new ReleaseAdmissionService({ query: vi.fn(async () => { throw new Error("database unavailable"); }) } as never);
    await expect(admission.assertAcceptingWork()).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: "RELEASE_ADMISSION_UNAVAILABLE" }),
    });
  });

  it("rejects a healthy manifest produced by a different executor runtime", async()=>{
    configureRelease();
    const database={query:vi.fn()
      .mockResolvedValueOnce({rows:[{schemaFingerprint}]})
      .mockResolvedValueOnce({rows:[{workerId:"current",releaseId,schemaFingerprint,...praxis}]})
      .mockResolvedValueOnce({rows:[{ready:true,runtimeHash:"a".repeat(64),capabilityManifestHash:"b".repeat(64)}]})};
    await expect(new ReleaseAdmissionService(database as never).status()).resolves.toMatchObject({ready:false,browserRuntimeReady:false});
  });

  it("rejects a worker with a mixed Praxis contract or runtime version", async () => {
    configureRelease();
    const { runtimeHash, capabilityManifestHash } = (await import("@scry/executor")).browserObservationRuntimeHealth();
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ schemaFingerprint }] })
      .mockResolvedValueOnce({ rows: [{ workerId: "mixed", releaseId, schemaFingerprint, ...praxis, praxisRuntimeVersion: "0" }] })
      .mockResolvedValueOnce({ rows: [{ ready: true, runtimeHash, capabilityManifestHash }] }) };
    await expect(new ReleaseAdmissionService(database as never).status()).resolves.toMatchObject({ ready: false, praxisReady: false, compatibleWorkerCount: 0 });
  });

  it("rejects legacy direct Flow publication before opening a transaction", async () => {
    const database = { transaction: vi.fn() };
    const admission = { assertAcceptingWork: vi.fn(async () => { throw new Error("blocked"); }) };
    const service = new FlowService(database as never, admission as never);
    await expect(service.createFlow({ kind: "service", subject: "scry-service" }, "project", {} as never)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "AUTHORING_DRAFT_REQUIRED" }),
    });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("returns HTTP 503 from readiness when work admission is blocked", async () => {
    const core = { readiness: vi.fn(async () => ({ ready: false })) };
    const reply = { status: vi.fn() };
    const controller = new FlowController(core as never, {} as never);
    await expect(controller.readiness(reply as never)).resolves.toEqual({ ready: false });
    expect(reply.status).toHaveBeenCalledWith(503);
  });
});
