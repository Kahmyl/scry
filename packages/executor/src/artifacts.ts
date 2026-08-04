import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  VEIL_CONTRACT_VERSION,
  type Artifact,
  type VeilCapabilityLease,
  type VeilCapturePermit,
  type VeilVideoSegmentFinalization,
  type VeilDecision,
  type VeilEvidenceChannel,
  type VeilLeaseRequest,
} from "@scry/contracts";
import { signVeilEvidenceAdmission } from "@scry/artifact";

import { VeilAuthority } from "@scry/veil";

type AdmissionRuntime = {
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
};
const admissionRuntimes = new Map<string, AdmissionRuntime>();
type VeilSanitationEvidence = {
  stage: "pre_capture" | "post_capture";
  method:
    | "veil_capture_permit"
    | "veil_init_style_and_dynamic_masking"
    | "veil_dynamic_masking_and_protected_recording_gaps"
    | "SecretRedactor.redact"
    | "SecretRedactor.redactValue"
    | "sanitizeTraceArchive";
  attestedAt: string;
  capturePermitDigest?: string;
  maskDigest?: string;
  documentEpoch?: number;
  checkpointChainDigest?: string;
  checkpointCount?: number;
};

export function registerVeilEvidenceAdmission(runtime: AdmissionRuntime): () => void {
  const root = path.resolve(runtime.root);
  if (admissionRuntimes.has(root)) throw new Error("VEIL_EVIDENCE_ADMISSION_ALREADY_REGISTERED");
  admissionRuntimes.set(root, { ...runtime, root });
  return () => {
    admissionRuntimes.delete(root);
  };
}

export async function ensureOutputDirectories(root: string) {
  await Promise.all(
    ["screenshots", "dom", "network", "video"].map((directory) =>
      mkdir(path.join(root, directory), { recursive: true }),
    ),
  );
}

export async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function availableArtifact(
  kind: Artifact["kind"],
  contentType: string,
  filePath: string,
  relativePath?: string,
  evidence?: {
    classification: "public" | "sensitive" | "secret" | "unknown";
    sanitation?: VeilSanitationEvidence;
    capturePermit?: VeilCapturePermit;
    videoFinalization?: VeilVideoSegmentFinalization;
  },
): Promise<Artifact> {
  if (!evidence) throw new Error("VEIL_EVIDENCE_CLASSIFICATION_REQUIRED");
  const classification = evidence.classification;
  if (classification === "secret" || classification === "unknown")
    throw new Error("VEIL_EVIDENCE_CLASSIFICATION_REFUSED");
  const resolved = path.resolve(filePath);
  const runtime = [...admissionRuntimes.values()].find(({ root }) => {
    const relative = path.relative(root, resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!runtime) throw new Error("VEIL_EVIDENCE_ADMISSION_REQUIRED");
  let sanitation = evidence.sanitation;
  if (kind === "screenshot") {
    if (!evidence.capturePermit || !runtime.visualAdmission)
      throw new Error("VEIL_CAPTURE_PERMIT_BINDING_REQUIRED");
    sanitation = {
      stage: "pre_capture",
      method: "veil_capture_permit",
      ...runtime.visualAdmission(evidence.capturePermit),
      attestedAt: new Date().toISOString(),
    };
  }
  if (kind === "video") {
    if (!evidence.videoFinalization || !runtime.videoAdmission)
      throw new Error("VEIL_VIDEO_CAPTURE_PERMIT_REQUIRED");
    const finalization = runtime.videoAdmission(evidence.videoFinalization);
    sanitation = {
      stage: "pre_capture",
      method: "veil_dynamic_masking_and_protected_recording_gaps",
      attestedAt: finalization.finalizedAt,
      documentEpoch: finalization.documentEpoch,
      checkpointChainDigest: finalization.checkpointChainDigest,
      checkpointCount: finalization.checkpointCount,
    };
  }
  if ((kind === "screenshot" || kind === "video") && sanitation?.stage !== "pre_capture")
    throw new Error("VEIL_VISUAL_PRECAPTURE_SANITATION_REQUIRED");
  const admittedEvidence: {
    classification: "public" | "sensitive";
    sanitation?: VeilSanitationEvidence;
  } = {
    classification,
    ...(sanitation ? { sanitation } : {}),
  };
  const channel = artifactChannel(kind);
  const request: VeilLeaseRequest = {
    context: runtime.context(),
    operation: "admit_evidence",
    channel,
    classification,
    scope: "document",
  };
  const { decision, lease } = runtime.authority.issueLease(request);
  return admittedArtifact({
    authority: runtime.authority,
    request,
    decision,
    lease,
    admissionKey: runtime.admissionKey,
    channel,
    kind,
    contentType,
    filePath,
    evidence: admittedEvidence,
    ...(relativePath ? { relativePath } : {}),
  });
}

function artifactChannel(kind: Artifact["kind"]): VeilEvidenceChannel {
  return (
    {
      screenshot: "screenshot",
      video: "video",
      dom: "dom",
      network: "network",
      console: "console",
      trace: "trace",
      report: "report",
    } as const
  )[kind];
}

async function admittedArtifact(input: {
  authority: VeilAuthority;
  request: VeilLeaseRequest;
  lease: VeilCapabilityLease;
  decision: VeilDecision;
  channel: VeilEvidenceChannel;
  kind: Artifact["kind"];
  contentType: string;
  filePath: string;
  relativePath?: string;
  admissionKey: string;
  evidence: { classification: "public" | "sensitive"; sanitation?: VeilSanitationEvidence };
}): Promise<Artifact> {
  const validated = input.authority.validateLease(input.lease, input.request);
  if (input.request.operation !== "admit_evidence" || input.request.channel !== input.channel) {
    throw new Error("VEIL_EVIDENCE_LEASE_SCOPE_MISMATCH");
  }
  if (
    input.decision.policyDigest !== validated.policyDigest ||
    input.decision.disposition !== validated.disposition
  ) {
    throw new Error("VEIL_EVIDENCE_DECISION_MISMATCH");
  }
  if (input.decision.disposition !== "allow" && input.decision.disposition !== "sanitize") {
    throw new Error("VEIL_EVIDENCE_NOT_ADMITTED");
  }
  const [data, metadata] = await Promise.all([readFile(input.filePath), stat(input.filePath)]);
  const id = randomUUID();
  const contentDigest = createHash("sha256").update(data).digest("hex");
  const veilManifest = {
    schemaVersion: VEIL_CONTRACT_VERSION,
    evidenceId: id,
    channel: input.channel,
    classification: input.request.classification,
    disposition: input.decision.disposition,
    policyDigest: input.decision.policyDigest,
    decisionId: input.decision.decisionId,
    transactionId: input.request.context.transactionId,
    contentDigest,
    omissionIntervals: [] as Array<{ startMs: number; endMs: number }>,
    createdAt: new Date().toISOString(),
  } as const;
  const sanitation = input.evidence.sanitation ?? {
    stage: "not_required",
    method: "classified_public_at_source",
    attestedAt: new Date().toISOString(),
  };
  const proof = signVeilEvidenceAdmission(veilManifest, input.admissionKey, sanitation);
  return {
    id,
    kind: input.kind,
    availability: "available",
    privacyClassification: input.decision.disposition === "sanitize" ? "sanitized" : "safe",
    contentType: input.contentType,
    sizeBytes: metadata.size,
    checksumSha256: contentDigest,
    ...(input.relativePath ? { relativePath: input.relativePath } : {}),
    observation: {
      veilManifest: proof.manifest,
      veilAdmissionToken: proof.token,
      veilSanitation: sanitation,
    },
  };
}
