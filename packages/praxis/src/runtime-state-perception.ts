import { randomBytes } from "node:crypto";

import { VeilPublicValueAdmissionError, admitVeilPublicValue } from "@scry/veil";
import type {
  InspectPraxisRuntimeStateResult,
  ReadPraxisPublicRuntimeValueInput,
  ReadPraxisPublicRuntimeValueResult,
} from "@scry/contracts";
import type { Page } from "playwright";

import { observationIdentity } from "./observation.js";

const MAX_CANDIDATES = 32;
const MAX_REFERENCES = 16;
const MAX_DEPTH = 4;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_RELEASE_CHARACTERS = 4_096;
type Kind = "scalar" | "object" | "array";
type Authority = {
  pageId: string;
  frameId: string;
  documentEpoch: number;
  documentIdentity: string;
};
type Entry = {
  authority: Authority;
  kind: Kind;
  text: string;
  bytes: number;
  memberCount: number;
};
type Registry = {
  baseline: Set<string>;
  entries: Map<string, Entry>;
  documentEpoch: number;
  documentIdentity: string;
};
const registries = new WeakMap<Page, Registry>();

export class PraxisRuntimeStateError extends Error {
  override readonly name = "PraxisRuntimeStateError";
  constructor(
    readonly code:
      | "PUBLIC_RUNTIME_REFERENCE_UNKNOWN"
      | "PUBLIC_RUNTIME_REFERENCE_STALE"
      | "PUBLIC_RUNTIME_CLASSIFICATION_REFUSED",
  ) {
    super(code);
  }
}

export async function installPraxisRuntimeStatePerception(page: Page) {
  const registry: Registry = {
    baseline: new Set(),
    entries: new Map(),
    documentEpoch: 0,
    documentIdentity: randomBytes(16).toString("hex"),
  };
  registries.set(page, registry);
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const property of await globalPropertyNames(cdp)) registry.baseline.add(property);
  } catch {
    /* no baseline means fail closed below */
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  const release = () => registry.entries.clear();
  const navigation = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) {
      registry.documentEpoch += 1;
      registry.documentIdentity = randomBytes(16).toString("hex");
      release();
    }
  };
  page.on("framenavigated", navigation);
  return () => {
    page.off("framenavigated", navigation);
    release();
    registries.delete(page);
  };
}

export async function inspectPraxisRuntimeState(
  page: Page,
): Promise<InspectPraxisRuntimeStateResult> {
  const registry = registries.get(page);
  if (!registry) return empty(authority(page, 0, randomBytes(16).toString("hex")));
  const current = authority(page, registry.documentEpoch, registry.documentIdentity);
  if (registry.baseline.size === 0) return empty(current);
  registry.entries.clear();
  const cdp = await page.context().newCDPSession(page);
  try {
    const global = await globalObject(cdp);
    if (!global?.objectId) return empty(current);
    const properties = await cdp.send("Runtime.getProperties", {
      objectId: global.objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false,
    });
    const eligible = properties.result.filter(
      (property: any) =>
        !registry.baseline.has(property.name) &&
        !property.get &&
        !property.set &&
        !property.symbol &&
        property.value,
    );
    const candidates = eligible.slice(0, MAX_CANDIDATES);
    const values: InspectPraxisRuntimeStateResult["values"] = [];
    for (const property of candidates) {
      if (values.length >= MAX_REFERENCES) break;
      const serial = await serialize(cdp, property.value, 0);
      if (!serial) continue;
      const bytes = Buffer.byteLength(serial.text, "utf8");
      if (bytes > MAX_SOURCE_BYTES || serial.text.length > MAX_RELEASE_CHARACTERS) continue;
      const reference = `context-runtime-${randomBytes(16).toString("hex")}`;
      registry.entries.set(reference, { authority: current, ...serial, bytes });
      values.push({ reference, kind: serial.kind, bytes, memberCount: serial.memberCount });
    }
    return {
      authority: { referenceVersion: 1, ...current },
      values,
      completeness: {
        kind: "bounded",
        observed: eligible.length,
        returned: values.length,
        truncated: eligible.length > candidates.length || candidates.length > values.length,
      },
    };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export async function readPraxisPublicRuntimeValue(
  page: Page,
  input: ReadPraxisPublicRuntimeValueInput,
): Promise<ReadPraxisPublicRuntimeValueResult> {
  const entry = registries.get(page)?.entries.get(input.reference);
  if (!entry) throw new PraxisRuntimeStateError("PUBLIC_RUNTIME_REFERENCE_UNKNOWN");
  const registry = registries.get(page);
  if (
    !registry ||
    registry.documentEpoch !== entry.authority.documentEpoch ||
    registry.documentIdentity !== entry.authority.documentIdentity
  )
    throw new PraxisRuntimeStateError("PUBLIC_RUNTIME_REFERENCE_STALE");
  try {
    const admission = admitVeilPublicValue({
      kind: "annotated",
      text: entry.text,
      redactedBoundary: false,
      editableBoundary: false,
    });
    return {
      reference: input.reference,
      classification: "public",
      provenance: { referenceVersion: 1, ...entry.authority },
      kind: entry.kind,
      text: entry.text,
      admission: {
        admissionRevision: admission.admissionRevision,
        contentDigest: admission.contentDigest,
        admissionDigest: admission.admissionDigest,
      },
    };
  } catch (error) {
    if (error instanceof VeilPublicValueAdmissionError)
      throw new PraxisRuntimeStateError("PUBLIC_RUNTIME_CLASSIFICATION_REFUSED");
    throw error;
  }
}

async function globalObject(cdp: any) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "globalThis",
    returnByValue: false,
    awaitPromise: false,
    userGesture: false,
    throwOnSideEffect: true,
    objectGroup: "scry-runtime-state",
  });
  if (result.exceptionDetails || result.result?.subtype === "error") return undefined;
  return result.result;
}
async function globalPropertyNames(cdp: any): Promise<string[]> {
  const global = await globalObject(cdp);
  if (!global?.objectId) return [];
  const properties = await cdp.send("Runtime.getProperties", {
    objectId: global.objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: false,
  });
  return properties.result
    .filter((property: any) => !property.get && !property.set)
    .map((property: any) => property.name);
}
async function serialize(
  cdp: any,
  value: any,
  depth: number,
): Promise<{ kind: Kind; text: string; memberCount: number } | undefined> {
  if (
    depth > MAX_DEPTH ||
    !value ||
    value.type === "function" ||
    value.type === "symbol" ||
    value.subtype === "node" ||
    value.subtype === "proxy"
  )
    return undefined;
  if (["boolean", "number", "string"].includes(value.type) || value.subtype === "null") {
    if (value.type === "number" && !Number.isFinite(value.value)) return undefined;
    return { kind: "scalar", text: JSON.stringify(value.value ?? null), memberCount: 0 };
  }
  if (
    value.type !== "object" ||
    !value.objectId ||
    ![undefined, "array"].includes(value.subtype) ||
    (value.className && value.className !== "Object" && value.className !== "Array")
  )
    return undefined;
  const properties = await cdp.send("Runtime.getProperties", {
    objectId: value.objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: false,
  });
  if (
    properties.internalProperties?.some(
      (property: any) => property.name === "[[Handler]]" || property.name === "[[Target]]",
    )
  )
    return undefined;
  const data = properties.result.filter((property: any) => {
    if (property.get || property.set || property.symbol || !property.value) return false;
    return value.subtype !== "array" || /^(?:0|[1-9]\d*)$/.test(property.name);
  });
  if (data.length > 512) return undefined;
  const pairs = await Promise.all(
    data.map(
      async (property: any) =>
        [property.name, await serialize(cdp, property.value, depth + 1)] as const,
    ),
  );
  if (pairs.some(([, child]) => !child)) return undefined;
  const object =
    value.subtype === "array"
      ? pairs.map(([, child]) => JSON.parse(child!.text))
      : Object.fromEntries(pairs.map(([name, child]) => [name, JSON.parse(child!.text)]));
  return {
    kind: value.subtype === "array" ? "array" : "object",
    text: JSON.stringify(object),
    memberCount: pairs.length,
  };
}
function authority(page: Page, documentEpoch: number, documentIdentity: string): Authority {
  const frame = page.mainFrame();
  const identity = observationIdentity(
    page,
    { kind: "runtime_state" },
    "public",
    documentEpoch,
    frame,
  );
  return {
    pageId: identity.pageId,
    frameId: identity.frameId,
    documentEpoch,
    documentIdentity,
  };
}
function empty(current: Authority): InspectPraxisRuntimeStateResult {
  return {
    authority: { referenceVersion: 1, ...current },
    values: [],
    completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
  };
}
