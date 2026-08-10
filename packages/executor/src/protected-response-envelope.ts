import type { AcquisitionIntent, ProtectedTransaction } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import type { Page, Response } from "playwright";

const MAX_RESPONSE_BYTES = 64 * 1024;
const envelopes = new WeakMap<Page, {
  responses: unknown[];
  pending: Set<Promise<void>>;
  observedAllowedResponses: number;
  rejectionCodes: string[];
}>();

export function beginProtectedResponseEnvelope(
  page: Page,
  allowedOrigins: string[],
  redactor: SecretRedactor,
  options?: {
    outputs: ProtectedTransaction["extraction"]["outputs"];
    stage: (outputs: Array<{
      reference: string;
      classification: "public" | "protected";
      name: string;
      value: string;
      scope: "run" | "project";
    }>) => Promise<void>;
  },
) {
  const allowed = new Set(allowedOrigins);
  const envelope = {
    responses: [] as unknown[], pending: new Set<Promise<void>>(),
    observedAllowedResponses: 0, rejectionCodes: [] as string[],
  };
  envelopes.set(page, envelope);
  let staged = false;
  const listener = (response: Response) => {
    const method = response.request().method();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
    if (!allowed.has(new URL(response.url()).origin)) return;
    envelope.observedAllowedResponses += 1;
    if (response.status() < 200 || response.status() >= 400) {
      envelope.rejectionCodes.push("PROTECTED_RESPONSE_HTTP_REJECTED");
      return;
    }
    const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
    if (!contentType.includes("json")) {
      envelope.rejectionCodes.push("PROTECTED_RESPONSE_NON_JSON");
      return;
    }
    const declared = Number(response.headers()["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      envelope.rejectionCodes.push("PROTECTED_RESPONSE_OVERSIZED");
      return;
    }
    let work: Promise<void>;
    work = response.body()
      .then((body) => {
        if (body.byteLength > MAX_RESPONSE_BYTES) {
          envelope.rejectionCodes.push("PROTECTED_RESPONSE_OVERSIZED");
          return;
        }
        const parsed = JSON.parse(body.toString("utf8")) as unknown;
        for (const value of stringLeaves(parsed)) redactor.add(value);
        envelope.responses.push(parsed);
        if (!options || staged) return;
        const outputs = responseOutputs(parsed, options.outputs);
        if (!outputs) return;
        return options.stage(outputs).then(() => { staged = true; });
      })
      .catch(() => { envelope.rejectionCodes.push("PROTECTED_RESPONSE_PARSE_FAILED"); })
      .finally(() => envelope.pending.delete(work));
    envelope.pending.add(work);
  };
  page.on("response", listener);
  return {
    async settle() {
      await Promise.allSettled([...envelope.pending]);
    },
    async close() {
      page.off("response", listener);
      await Promise.allSettled([...envelope.pending]);
      envelope.responses.length = 0;
      envelopes.delete(page);
    },
  };
}

function responseOutputs(
  response: unknown,
  outputs: ProtectedTransaction["extraction"]["outputs"],
) {
  const acquired: Array<{
    reference: string;
    classification: "public" | "protected";
    name: string;
    value: string;
    scope: "run" | "project";
  }> = [];
  for (const output of outputs) {
    if (!output.acquisition.permittedMethods.includes("protected_network_value")) return undefined;
    const values = rankedResponseValues(response, output.acquisition);
    if (values.length !== 1) return undefined;
    acquired.push({
      reference: output.reference,
      classification: output.classification,
      name: output.classification === "protected" ? output.storage.credentialName : output.storage.name,
      value: values[0]!,
      scope: output.storage.scope,
    });
  }
  return acquired;
}

export async function acquireProtectedResponseValue(
  page: Page,
  acquisition: AcquisitionIntent,
) {
  const envelope = envelopes.get(page);
  if (!envelope) throw new Error("PROTECTED_RESPONSE_ENVELOPE_UNAVAILABLE");
  await Promise.allSettled([...envelope.pending]);
  const unique = rankedResponseValues(envelope.responses, acquisition);
  if (unique.length !== 1) {
    if (unique.length) throw new Error("PROTECTED_RESPONSE_VALUE_AMBIGUOUS");
    if (!envelope.responses.length) {
      throw new Error(
        envelope.rejectionCodes.at(-1) ??
        (envelope.observedAllowedResponses ? "PROTECTED_RESPONSE_NOT_ACCEPTED" : "PROTECTED_RESPONSE_NOT_OBSERVED"),
      );
    }
    throw new Error("PROTECTED_RESPONSE_VALUE_UNAVAILABLE");
  }
  return unique[0]!;
}

function semanticIdentities(acquisition: AcquisitionIntent) {
  const values = [
    ...acquisition.target.preferredEvidence.names,
    ...acquisition.target.preferredEvidence.labels,
    acquisition.target.preferredEvidence.expectedText,
    acquisition.target.concept,
  ].filter((value): value is string => Boolean(value));
  const identities = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    identities.add(normalized);
    if (normalized.endsWith("value")) identities.add(normalized.slice(0, -"value".length));
  }
  return identities;
}

function rankedResponseValues(response: unknown, acquisition: AcquisitionIntent) {
  const identities = semanticIdentities(acquisition);
  const context = semanticContext(acquisition);
  const candidates = keyedStringLeaves(response)
    .filter((leaf) => identities.has(normalize(leaf.key)) && leaf.value)
    .map((leaf) => ({
      ...leaf,
      overlap: leaf.path.reduce((score, segment) => score + (context.has(normalize(segment)) ? 1 : 0), 0),
    }));
  if (!candidates.length) return [];
  const bestOverlap = Math.max(...candidates.map((candidate) => candidate.overlap));
  const contextual = candidates.filter((candidate) => candidate.overlap === bestOverlap);
  const shallowest = Math.min(...contextual.map((candidate) => candidate.path.length));
  return [...new Set(
    contextual.filter((candidate) => candidate.path.length === shallowest).map((candidate) => candidate.value),
  )];
}

function semanticContext(acquisition: AcquisitionIntent) {
  const keyIdentities = semanticIdentities(acquisition);
  return new Set(
    [
      acquisition.target.concept,
      ...acquisition.target.preferredEvidence.names,
      ...acquisition.target.preferredEvidence.labels,
      acquisition.target.preferredEvidence.expectedText,
    ]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.normalize("NFKC").toLocaleLowerCase().split(/[^a-z0-9]+/))
      .map(normalize)
      .filter((value) => value && !keyIdentities.has(value) && !["retrieved", "response", "value"].includes(value)),
  );
}

function keyedStringLeaves(value: unknown, path: string[] = []): Array<{ key: string; path: string[]; value: string }> {
  if (typeof value === "string") return [{ key: path.at(-1) ?? "", path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => keyedStringLeaves(item, [...path, String(index)]));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, child]) => keyedStringLeaves(child, [...path, childKey]));
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringLeaves);
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}
