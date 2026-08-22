import path from "node:path";

import {
  VEIL_CONTRACT_VERSION,
  type Artifact,
  type VeilCapturePermit,
  type VeilEvidenceChannel,
  type VeilEvidenceManifest,
  type VeilLeaseRequest,
  type VeilVideoSegmentFinalization,
} from "@scry/contracts";

import { VeilAuthority } from "./authority.js";

export type VeilSanitationEvidence = Readonly<{
  stage: "pre_capture" | "post_capture" | "not_required";
  method:
    | "veil_capture_permit"
    | "veil_init_style_and_dynamic_masking"
    | "veil_dynamic_masking_and_protected_recording_gaps"
    | "SecretRedactor.redact"
    | "SecretRedactor.redactValue"
    | "sanitizeTraceArchive"
    | "classified_public_at_source";
  attestedAt: string;
  capturePermitDigest?: string;
  maskDigest?: string;
  documentEpoch?: number;
  checkpointChainDigest?: string;
  checkpointCount?: number;
}>;

export type VeilArtifactEvidence = Readonly<{
  classification: "public" | "sensitive" | "secret" | "unknown";
  sanitation?: VeilSanitationEvidence;
  capturePermit?: VeilCapturePermit;
  videoFinalization?: VeilVideoSegmentFinalization;
}>;

export type VeilEvidenceAdmissionRuntime = Readonly<{
  root: string;
  authority: VeilAuthority;
  admissionKey: string;
  context: () => VeilLeaseRequest["context"];
  visualAdmission?: (permit: VeilCapturePermit) => {
    capturePermitDigest: string;
    maskDigest: string;
    documentEpoch: number;
  };
  videoAdmission?: (finalization: VeilVideoSegmentFinalization) => VeilVideoSegmentFinalization;
}>;

export type PreparedVeilArtifactEvidence = Readonly<{
  admissionKey: string;
  channel: VeilEvidenceChannel;
  classification: "public" | "sensitive";
  disposition: "allow" | "sanitize";
  policyDigest: string;
  decisionId: string;
  transactionId: string;
  sanitation: VeilSanitationEvidence;
  privacyClassification: "safe" | "sanitized";
}>;

export type FinalizedVeilArtifactEvidence = Readonly<{
  admissionKey: string;
  manifest: VeilEvidenceManifest;
  sanitation: VeilSanitationEvidence;
  privacyClassification: "safe" | "sanitized";
}>;

const admissionRuntimes = new Map<string, VeilEvidenceAdmissionRuntime>();

export function registerVeilEvidenceAdmission(runtime: VeilEvidenceAdmissionRuntime): () => void {
  const root = path.resolve(runtime.root);

  if (admissionRuntimes.has(root)) {
    throw new Error("VEIL_EVIDENCE_ADMISSION_ALREADY_REGISTERED");
  }

  admissionRuntimes.set(root, {
    ...runtime,
    root,
  });

  return () => {
    admissionRuntimes.delete(root);
  };
}

export function prepareVeilArtifactEvidence(
  input: Readonly<{
    kind: Artifact["kind"];
    filePath: string;
    evidence: VeilArtifactEvidence | undefined;
  }>,
): PreparedVeilArtifactEvidence {
  if (!input.evidence) {
    throw new Error("VEIL_EVIDENCE_CLASSIFICATION_REQUIRED");
  }

  const classification = input.evidence.classification;

  if (classification === "secret" || classification === "unknown") {
    throw new Error("VEIL_EVIDENCE_CLASSIFICATION_REFUSED");
  }

  const resolved = path.resolve(input.filePath);

  const runtime = [...admissionRuntimes.values()].find(({ root }) => {
    const relative = path.relative(root, resolved);

    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });

  if (!runtime) {
    throw new Error("VEIL_EVIDENCE_ADMISSION_REQUIRED");
  }

  let sanitation = input.evidence.sanitation;

  if (input.kind === "screenshot") {
    if (!input.evidence.capturePermit || !runtime.visualAdmission) {
      throw new Error("VEIL_CAPTURE_PERMIT_BINDING_REQUIRED");
    }

    sanitation = {
      stage: "pre_capture",
      method: "veil_capture_permit",
      ...runtime.visualAdmission(input.evidence.capturePermit),
      attestedAt: new Date().toISOString(),
    };
  }

  if (input.kind === "video") {
    if (!input.evidence.videoFinalization || !runtime.videoAdmission) {
      throw new Error("VEIL_VIDEO_CAPTURE_PERMIT_REQUIRED");
    }

    const finalization = runtime.videoAdmission(input.evidence.videoFinalization);

    sanitation = {
      stage: "pre_capture",
      method: "veil_dynamic_masking_and_protected_recording_gaps",
      attestedAt: finalization.finalizedAt,
      documentEpoch: finalization.documentEpoch,
      checkpointChainDigest: finalization.checkpointChainDigest,
      checkpointCount: finalization.checkpointCount,
    };
  }

  if (
    (input.kind === "screenshot" || input.kind === "video") &&
    sanitation?.stage !== "pre_capture"
  ) {
    throw new Error("VEIL_VISUAL_PRECAPTURE_SANITATION_REQUIRED");
  }

  const admittedSanitation = sanitation ?? {
    stage: "not_required" as const,
    method: "classified_public_at_source" as const,
    attestedAt: new Date().toISOString(),
  };

  const channel = artifactChannel(input.kind);

  const request: VeilLeaseRequest = {
    context: runtime.context(),
    operation: "admit_evidence",
    channel,
    classification,
    scope: "document",
  };

  const { decision, lease } = runtime.authority.issueLease(request);

  const validated = runtime.authority.validateLease(lease, request);

  if (
    decision.policyDigest !== validated.policyDigest ||
    decision.disposition !== validated.disposition
  ) {
    throw new Error("VEIL_EVIDENCE_DECISION_MISMATCH");
  }

  if (decision.disposition !== "allow" && decision.disposition !== "sanitize") {
    throw new Error("VEIL_EVIDENCE_NOT_ADMITTED");
  }

  return {
    admissionKey: runtime.admissionKey,
    channel,
    classification,
    disposition: decision.disposition,
    policyDigest: decision.policyDigest,
    decisionId: decision.decisionId,
    transactionId: request.context.transactionId,
    sanitation: admittedSanitation,
    privacyClassification: decision.disposition === "sanitize" ? "sanitized" : "safe",
  };
}

export function finalizeVeilArtifactEvidence(
  prepared: PreparedVeilArtifactEvidence,
  binding: Readonly<{
    evidenceId: string;
    contentDigest: string;
  }>,
): FinalizedVeilArtifactEvidence {
  return {
    admissionKey: prepared.admissionKey,
    manifest: {
      schemaVersion: VEIL_CONTRACT_VERSION,
      evidenceId: binding.evidenceId,
      channel: prepared.channel,
      classification: prepared.classification,
      disposition: prepared.disposition,
      policyDigest: prepared.policyDigest,
      decisionId: prepared.decisionId,
      transactionId: prepared.transactionId,
      contentDigest: binding.contentDigest,
      omissionIntervals: [],
      createdAt: new Date().toISOString(),
    },
    sanitation: prepared.sanitation,
    privacyClassification: prepared.privacyClassification,
  };
}

function artifactChannel(kind: Artifact["kind"]): VeilEvidenceChannel {
  const channels = {
    screenshot: "screenshot",
    video: "video",
    dom: "dom",
    network: "network",
    trace: "trace",
    report: "report",
  } as const;

  return channels[kind];
}
