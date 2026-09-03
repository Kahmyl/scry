import { randomBytes } from "node:crypto";

import { VeilPublicValueAdmissionError, admitVeilPublicValue } from "@scry/veil";
import type {
  InspectPraxisBrowserResourcesResult,
  ReadPraxisPublicResourceResult,
} from "@scry/contracts";
import type { Frame, Page, Request, Response } from "playwright";

import { observationIdentity, PraxisDocumentEpoch, PraxisDocumentIdentity } from "./observation.js";

const MAX_RESOURCE_CANDIDATES = 16;
export const MAX_RESOURCE_REFERENCES = 8;
const MAX_PENDING_RESOURCE_REQUESTS = 64;
const MAX_RESOURCE_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESOURCE_READ_BYTES = 2_048;
const MAX_RESOURCE_READ_BYTES = 4_096;

type ResourceKind = "json" | "text" | "xml";
type Candidate = { response: Response; generation: number; sequence: number; kind: ResourceKind };
type Entry = {
  authority: Awaited<ReturnType<typeof authority>>;
  kind: ResourceKind;
  text: string;
  bytes: number;
};
type Registry = {
  candidates: Candidate[];
  entries: Map<string, Entry>;
  requests: Map<Request, number>;
  generation: number;
  observedEligible: number;
  nextSequence: number;
};
const registries = new WeakMap<Page, Registry>();

export class PraxisPublicResourceError extends Error {
  override readonly name = "PraxisPublicResourceError";
  constructor(
    readonly code:
      | "PUBLIC_RESOURCE_REFERENCE_UNKNOWN"
      | "PUBLIC_RESOURCE_REFERENCE_STALE"
      | "PUBLIC_RESOURCE_CLASSIFICATION_REFUSED"
      | "PUBLIC_RESOURCE_READ_OFFSET_INVALID",
  ) {
    super(code);
  }
}

export type PraxisPublicResourceReadInput = {
  reference: string;
  offset?: number;
  maxBytes?: number;
};

/** Records only already-received browser responses; it never issues a request. */
export function installPraxisBrowserResourcePerception(page: Page) {
  const registry: Registry = {
    candidates: [],
    entries: new Map(),
    requests: new Map(),
    generation: 0,
    observedEligible: 0,
    nextSequence: 0,
  };
  registries.set(page, registry);
  const releaseEntries = () => {
    for (const entry of registry.entries.values()) entry.text = "";
    registry.entries.clear();
  };
  const onRequest = (request: Request) => {
    if (request.method() !== "GET" || request.frame() !== page.mainFrame()) return;
    registry.requests.set(request, registry.generation);
    if (registry.requests.size > MAX_PENDING_RESOURCE_REQUESTS)
      registry.requests.delete(registry.requests.keys().next().value!);
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    const generation = registry.requests.get(request);
    registry.requests.delete(request);
    const kind = resourceKind(response.headers()["content-type"]);
    if (generation === undefined || !kind) return;
    registry.observedEligible += 1;
    registry.candidates.push({ response, generation, sequence: registry.nextSequence++, kind });
    registry.candidates.sort(compareCandidates);
    registry.candidates.splice(MAX_RESOURCE_CANDIDATES);
  };
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      registry.generation += 1;
      registry.observedEligible = 0;
      registry.candidates.length = 0;
      registry.requests.clear();
      releaseEntries();
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("framenavigated", onNavigation);
  return () => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("framenavigated", onNavigation);
    releaseEntries();
    registry.candidates.length = 0;
    registry.requests.clear();
    registries.delete(page);
  };
}

export async function inspectPraxisBrowserResources(
  page: Page,
): Promise<InspectPraxisBrowserResourcesResult> {
  const registry = registries.get(page);
  if (!registry) return emptyInspection(await authority(page));
  const current = await authority(page);
  const currentOrigin = origin(page.url());
  const candidates = registry.candidates.slice(0, MAX_RESOURCE_CANDIDATES).sort(compareCandidates);
  releaseEntries(registry);
  const resources: Array<{ reference: string; kind: ResourceKind; bytes: number }> = [];

  for (const candidate of candidates) {
    if (resources.length >= MAX_RESOURCE_REFERENCES) break;
    if (candidate.generation !== registry.generation) continue;
    const kind = candidate.kind;
    if (!kind || candidate.response.status() < 200 || candidate.response.status() >= 300) continue;
    if (!currentOrigin || origin(candidate.response.url()) !== currentOrigin) continue;
    const declaredBytes = Number(candidate.response.headers()["content-length"]);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESOURCE_SOURCE_BYTES) continue;
    const body = await candidate.response.body().catch(() => undefined);
    if (!body || body.byteLength > MAX_RESOURCE_SOURCE_BYTES) continue;
    const text = decodeText(body);
    if (text === undefined) continue;
    try {
      admitVeilPublicValue({
        kind: "annotated",
        text,
        redactedBoundary: false,
        editableBoundary: false,
      });
    } catch {
      continue;
    }
    const reference = `context-resource-${randomBytes(16).toString("hex")}`;
    registry.entries.set(reference, { authority: current, kind, text, bytes: body.byteLength });
    resources.push({ reference, kind, bytes: body.byteLength });
  }
  return {
    authority: { referenceVersion: 1, ...current },
    resources,
    completeness: {
      kind: "bounded" as const,
      observed: registry.observedEligible,
      returned: resources.length,
      truncated:
        registry.observedEligible > candidates.length || resources.length < candidates.length,
    },
  };
}

export type PraxisPublicResourceRead = ReadPraxisPublicResourceResult;

export async function readPraxisPublicResource(
  page: Page,
  input: PraxisPublicResourceReadInput,
): Promise<PraxisPublicResourceRead> {
  const entry = registries.get(page)?.entries.get(input.reference);
  if (!entry) throw new PraxisPublicResourceError("PUBLIC_RESOURCE_REFERENCE_UNKNOWN");
  const current = await authority(page).catch(() => undefined);
  if (
    !current ||
    current.documentIdentity !== entry.authority.documentIdentity ||
    current.documentEpoch !== entry.authority.documentEpoch
  )
    throw new PraxisPublicResourceError("PUBLIC_RESOURCE_REFERENCE_STALE");
  let admission;
  try {
    admission = admitVeilPublicValue({
      kind: "annotated",
      text: entry.text,
      redactedBoundary: false,
      editableBoundary: false,
    });
  } catch (error) {
    if (error instanceof VeilPublicValueAdmissionError)
      throw new PraxisPublicResourceError("PUBLIC_RESOURCE_CLASSIFICATION_REFUSED");
    throw error;
  }
  const bytes = Buffer.from(entry.text, "utf8");
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length)
    throw new PraxisPublicResourceError("PUBLIC_RESOURCE_READ_OFFSET_INVALID");
  const maxBytes = Math.min(
    MAX_RESOURCE_READ_BYTES,
    Math.max(1, Math.floor(input.maxBytes ?? DEFAULT_RESOURCE_READ_BYTES)),
  );
  const { text, end } = utf8Slice(bytes, offset, maxBytes);
  return {
    reference: input.reference,
    classification: "public" as const,
    provenance: { referenceVersion: 1 as const, ...entry.authority },
    resource: { kind: entry.kind },
    text,
    offset,
    returnedBytes: end - offset,
    totalBytes: bytes.length,
    truncated: end < bytes.length,
    ...(end < bytes.length ? { nextOffset: end } : {}),
    admission: {
      admissionRevision: admission.admissionRevision,
      contentDigest: admission.contentDigest,
      admissionDigest: admission.admissionDigest,
    },
  };
}

async function authority(page: Page) {
  const frame = page.mainFrame();
  const documentEpoch = await PraxisDocumentEpoch.current(page, frame);
  const identity = observationIdentity(
    page,
    { kind: "browser_resource" },
    "public",
    documentEpoch,
    frame,
  );
  return {
    pageId: identity.pageId,
    frameId: identity.frameId,
    documentEpoch,
    documentIdentity: await PraxisDocumentIdentity.current(page, frame),
  };
}
function emptyInspection(
  current: Awaited<ReturnType<typeof authority>>,
): InspectPraxisBrowserResourcesResult {
  return {
    authority: { referenceVersion: 1, ...current },
    resources: [],
    completeness: { kind: "bounded" as const, observed: 0, returned: 0, truncated: false },
  };
}
function origin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
function resourceKind(contentType: string | undefined): ResourceKind | undefined {
  const value = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (value === "application/json" || value?.endsWith("+json")) return "json";
  if (value === "text/plain") return "text";
  if (value === "application/xml" || value === "text/xml" || value?.endsWith("+xml")) return "xml";
  return undefined;
}
function compareCandidates(left: Candidate, right: Candidate) {
  return (
    resourceKindPriority(left.kind) - resourceKindPriority(right.kind) ||
    left.sequence - right.sequence
  );
}
function resourceKindPriority(kind: ResourceKind) {
  return kind === "json" ? 0 : kind === "text" ? 1 : 2;
}
function decodeText(body: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}
function releaseEntries(registry: Registry) {
  for (const entry of registry.entries.values()) entry.text = "";
  registry.entries.clear();
}
function utf8Slice(bytes: Buffer, requestedStart: number, maxBytes: number) {
  let start = requestedStart;
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  let end = Math.min(bytes.length, start + maxBytes);
  while (end < bytes.length && end > start && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: bytes.subarray(start, end).toString("utf8"), end };
}
