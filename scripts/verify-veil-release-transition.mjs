import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const digest = /^[a-f0-9]{64}$/;

export function verifyTransition(input) {
  const required = [
    "transition",
    "currentReleaseId",
    "currentSchemaFingerprint",
    "currentPrivacyAuthority",
    "previousReleaseId",
    "previousSchemaFingerprint",
    "previousPrivacyAuthority",
    "activeSchemaFingerprint",
  ];
  for (const field of required)
    if (!input[field]) throw new Error(`VEIL_RELEASE_TRANSITION_MISSING:${field}`);
  if (!["upgrade", "rollback", "restore_current"].includes(input.transition))
    throw new Error("VEIL_RELEASE_TRANSITION_INVALID");
  for (const field of [
    "currentSchemaFingerprint",
    "previousSchemaFingerprint",
    "activeSchemaFingerprint",
  ])
    if (!digest.test(input[field])) throw new Error(`VEIL_RELEASE_FINGERPRINT_INVALID:${field}`);
  if (
    input.currentPrivacyAuthority !== "veil-only" ||
    input.previousPrivacyAuthority !== "veil-only"
  )
    throw new Error("VEIL_MIXED_LEGACY_ROLLBACK_REFUSED");
  if (input.currentReleaseId === input.previousReleaseId)
    throw new Error("VEIL_RELEASE_ID_REUSE_REFUSED");
  if (input.writersStopped !== true) throw new Error("VEIL_TRANSITION_WRITERS_ACTIVE");
  const expected =
    input.transition === "rollback"
      ? input.previousSchemaFingerprint
      : input.currentSchemaFingerprint;
  if (input.activeSchemaFingerprint !== expected)
    throw new Error(
      `VEIL_ACTIVE_SCHEMA_MISMATCH:expected=${expected}:actual=${input.activeSchemaFingerprint}`,
    );
  if (input.currentSchemaFingerprint !== input.previousSchemaFingerprint) {
    if (input.transition === "upgrade" && input.migrationProof !== "passed")
      throw new Error("VEIL_UPGRADE_MIGRATION_PROOF_REQUIRED");
    if (input.transition === "rollback") {
      requireProof(input, "snapshotProof", "VEIL_ROLLBACK_SNAPSHOT_PROOF_REQUIRED");
      requireProof(input, "restoreProof", "VEIL_ROLLBACK_RESTORE_PROOF_REQUIRED");
      requireProof(input, "priorImageBootProof", "VEIL_PRIOR_IMAGE_BOOT_PROOF_REQUIRED");
      requireProof(input, "priorApiReadinessProof", "VEIL_PRIOR_API_READINESS_PROOF_REQUIRED");
      requireProof(input, "priorMcpReadinessProof", "VEIL_PRIOR_MCP_READINESS_PROOF_REQUIRED");
      requireProof(
        input,
        "priorWorkerReadinessProof",
        "VEIL_PRIOR_WORKER_READINESS_PROOF_REQUIRED",
      );
      requireProof(input, "priorImageIdentityProof", "VEIL_PRIOR_IMAGE_IDENTITY_PROOF_REQUIRED");
      requireProof(input, "representativeDataProof", "VEIL_ROLLBACK_DATA_PROOF_REQUIRED");
      requireProof(input, "veilAuthorityProof", "VEIL_ROLLBACK_AUTHORITY_PROOF_REQUIRED");
      requireProof(input, "mixedSchemaRefusalProof", "VEIL_MIXED_SCHEMA_REFUSAL_PROOF_REQUIRED");
    }
    if (input.transition === "restore_current") {
      requireProof(input, "currentRestoreProof", "VEIL_CURRENT_RESTORE_PROOF_REQUIRED");
      requireProof(input, "currentImageBootProof", "VEIL_CURRENT_IMAGE_BOOT_PROOF_REQUIRED");
      requireProof(input, "representativeDataProof", "VEIL_CURRENT_DATA_PROOF_REQUIRED");
      requireProof(input, "veilAuthorityProof", "VEIL_CURRENT_AUTHORITY_PROOF_REQUIRED");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    gate: "veil-release-transition",
    status: "passed",
    transition: input.transition,
    previousReleaseId: input.previousReleaseId,
    currentReleaseId: input.currentReleaseId,
    activeSchemaFingerprint: input.activeSchemaFingerprint,
    privacyAuthority: "veil-only",
    transitionDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  });
}

function requireProof(input, field, code) {
  if (input[field] !== "passed") throw new Error(code);
}

export function verifyRollbackWorkflow(source) {
  const required = [
    "http://127.0.0.1:4000/api/ready",
    "http://127.0.0.1:4100/health",
    "FROM worker_heartbeats WHERE release_id='$SCRY_PREVIOUS_RELEASE_ID'",
    'docker image inspect "$SCRY_PREVIOUS_IMAGE_REF"',
    "org.scry.privacy-authority",
    "SCRY_PRIOR_API_READINESS_PROOF=passed",
    "SCRY_PRIOR_MCP_READINESS_PROOF=passed",
    "SCRY_PRIOR_WORKER_READINESS_PROOF=passed",
    "SCRY_PRIOR_IMAGE_IDENTITY_PROOF=passed",
  ];
  for (const evidence of required)
    if (!source.includes(evidence))
      throw new Error(`VEIL_ROLLBACK_WORKFLOW_EVIDENCE_MISSING:${evidence}`);
  return true;
}

function fromEnvironment() {
  return {
    transition: process.env.SCRY_TRANSITION,
    currentReleaseId: process.env.SCRY_CURRENT_RELEASE_ID,
    currentSchemaFingerprint: process.env.SCRY_CURRENT_SCHEMA_FINGERPRINT,
    currentPrivacyAuthority: process.env.SCRY_CURRENT_PRIVACY_AUTHORITY,
    previousReleaseId: process.env.SCRY_PREVIOUS_RELEASE_ID,
    previousSchemaFingerprint: process.env.SCRY_PREVIOUS_SCHEMA_FINGERPRINT,
    previousPrivacyAuthority: process.env.SCRY_PREVIOUS_PRIVACY_AUTHORITY,
    activeSchemaFingerprint: process.env.SCRY_ACTIVE_SCHEMA_FINGERPRINT,
    writersStopped: process.env.SCRY_WRITERS_STOPPED === "true",
    migrationProof: process.env.SCRY_MIGRATION_PROOF,
    restoreProof: process.env.SCRY_ROLLBACK_RESTORE_PROOF,
    snapshotProof: process.env.SCRY_ROLLBACK_SNAPSHOT_PROOF,
    priorImageBootProof: process.env.SCRY_PRIOR_IMAGE_BOOT_PROOF,
    priorApiReadinessProof: process.env.SCRY_PRIOR_API_READINESS_PROOF,
    priorMcpReadinessProof: process.env.SCRY_PRIOR_MCP_READINESS_PROOF,
    priorWorkerReadinessProof: process.env.SCRY_PRIOR_WORKER_READINESS_PROOF,
    priorImageIdentityProof: process.env.SCRY_PRIOR_IMAGE_IDENTITY_PROOF,
    currentRestoreProof: process.env.SCRY_CURRENT_RESTORE_PROOF,
    currentImageBootProof: process.env.SCRY_CURRENT_IMAGE_BOOT_PROOF,
    representativeDataProof: process.env.SCRY_REPRESENTATIVE_DATA_PROOF,
    veilAuthorityProof: process.env.SCRY_VEIL_AUTHORITY_PROOF,
    mixedSchemaRefusalProof: process.env.SCRY_MIXED_SCHEMA_REFUSAL_PROOF,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.env.SCRY_TRANSITION)
    process.stdout.write(`${JSON.stringify(verifyTransition(fromEnvironment()))}\n`);
  else {
    verifyRollbackWorkflow(
      await readFile(new URL("../.github/workflows/docker-publish.yml", import.meta.url), "utf8"),
    );
    const a = "a".repeat(64),
      b = "b".repeat(64),
      base = {
        currentReleaseId: "release-current",
        currentSchemaFingerprint: b,
        currentPrivacyAuthority: "veil-only",
        previousReleaseId: "release-previous",
        previousSchemaFingerprint: a,
        previousPrivacyAuthority: "veil-only",
        writersStopped: true,
      };
    const upgrade = verifyTransition({
      ...base,
      transition: "upgrade",
      activeSchemaFingerprint: b,
      migrationProof: "passed",
    });
    const rollbackProofs = {
      snapshotProof: "passed",
      restoreProof: "passed",
      priorImageBootProof: "passed",
      priorApiReadinessProof: "passed",
      priorMcpReadinessProof: "passed",
      priorWorkerReadinessProof: "passed",
      priorImageIdentityProof: "passed",
      representativeDataProof: "passed",
      veilAuthorityProof: "passed",
      mixedSchemaRefusalProof: "passed",
    };
    const rollback = verifyTransition({
      ...base,
      ...rollbackProofs,
      transition: "rollback",
      activeSchemaFingerprint: a,
    });
    const restoreCurrent = verifyTransition({
      ...base,
      transition: "restore_current",
      activeSchemaFingerprint: b,
      currentRestoreProof: "passed",
      currentImageBootProof: "passed",
      representativeDataProof: "passed",
      veilAuthorityProof: "passed",
    });
    for (const field of [
      "priorApiReadinessProof",
      "priorMcpReadinessProof",
      "priorWorkerReadinessProof",
      "priorImageIdentityProof",
    ]) {
      const incomplete = {
        ...base,
        ...rollbackProofs,
        transition: "rollback",
        activeSchemaFingerprint: a,
      };
      delete incomplete[field];
      let refused = false;
      try {
        verifyTransition(incomplete);
      } catch (error) {
        refused = error instanceof Error && error.message.includes("PROOF_REQUIRED");
      }
      if (!refused) throw new Error(`Rollback validator accepted missing ${field}`);
    }
    let unsafeRefused = false;
    try {
      verifyTransition({ ...base, transition: "rollback", activeSchemaFingerprint: b });
    } catch (error) {
      unsafeRefused = error instanceof Error && /RESTORE_PROOF|ACTIVE_SCHEMA/.test(error.message);
    }
    if (!unsafeRefused) throw new Error("Unsafe mixed-schema rollback was not refused");
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, gate: "veil-release-transition-matrix", status: "passed", upgrade, rollback, restoreCurrent, componentReadinessProofsRequired: true, unsafeMixedSchemaRollbackRefused: true })}\n`,
    );
  }
}
