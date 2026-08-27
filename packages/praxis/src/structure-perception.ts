import { randomBytes } from "node:crypto";

import { VeilPublicValueAdmissionError, admitVeilPublicValue } from "@scry/veil";
import type {
  InspectPraxisStructureResult,
  ReadPraxisPublicStructureValueInput,
  ReadPraxisPublicStructureValueResult,
} from "@scry/contracts";
import type { Page } from "playwright";

import { observationIdentity, PraxisDocumentEpoch, PraxisDocumentIdentity } from "./observation.js";

const MAX_CANDIDATES = 128;
const MAX_REFERENCES = 32;
const MAX_TEXT = 4_096;
type Field = ReadPraxisPublicStructureValueInput["field"];
type Source = "dom" | "accessibility";
type BoundaryFacts = {
  inaccessibleBoundary: boolean;
  redactedBoundary: boolean;
  editableBoundary: boolean;
  protectedBoundary: boolean;
};
type Entry = {
  authority: Awaited<ReturnType<typeof authority>>;
  source: Source;
  role?: InspectPraxisStructureResult["structures"][number]["role"];
  depth: number;
  childCount: number;
  values: Partial<Record<Field, string>>;
} & BoundaryFacts;
type SnapshotIndex = {
  strings: string[];
  nodes: any;
  attributes: Array<Map<string, string>>;
  boundaries: BoundaryFacts[];
  backendNodeIndexes: Map<number, number>;
  layout: Map<number, { display?: string; visibility?: string; bounds?: number[] }>;
};
type Registry = { entries: Map<string, Entry> };
const registries = new WeakMap<Page, Registry>();

export class PraxisStructureError extends Error {
  override readonly name = "PraxisStructureError";
  constructor(
    readonly code:
      | "PUBLIC_STRUCTURE_REFERENCE_UNKNOWN"
      | "PUBLIC_STRUCTURE_REFERENCE_STALE"
      | "PUBLIC_STRUCTURE_CLASSIFICATION_REFUSED",
  ) {
    super(code);
  }
}

export function installPraxisStructurePerception(page: Page) {
  const registry: Registry = { entries: new Map() };
  registries.set(page, registry);
  const release = () => registry.entries.clear();
  const navigation = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) release();
  };
  page.on("framenavigated", navigation);
  return () => {
    page.off("framenavigated", navigation);
    release();
    registries.delete(page);
  };
}

export async function inspectPraxisStructure(page: Page): Promise<InspectPraxisStructureResult> {
  const registry = registries.get(page);
  const current = await authority(page);
  if (!registry) return empty(current);
  registry.entries.clear();
  const cdp = await page.context().newCDPSession(page);
  try {
    const [snapshot, ax] = await Promise.all([
      cdp.send("DOMSnapshot.captureSnapshot", {
        computedStyles: ["display", "visibility"],
        includeDOMRects: true,
        includePaintOrder: false,
      }),
      cdp.send("Accessibility.getFullAXTree"),
    ]);
    const snapshotIndex = indexSnapshot(snapshot);
    const eligible = snapshotIndex
      ? [...domCandidates(snapshotIndex), ...axCandidates(ax, snapshotIndex)]
      : [];
    const candidates = eligible.slice(0, MAX_CANDIDATES);
    const structures: InspectPraxisStructureResult["structures"] = [];
    for (const candidate of candidates) {
      if (structures.length >= MAX_REFERENCES) break;
      const values = Object.fromEntries(
        Object.entries(candidate.values).filter(
          ([, value]) => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT,
        ),
      );
      if (!Object.keys(values).length) continue;
      const reference = `context-structure-${randomBytes(16).toString("hex")}`;
      registry.entries.set(reference, { authority: current, ...candidate, values });
      structures.push({
        reference,
        source: candidate.source,
        ...(candidate.role ? { role: candidate.role } : {}),
        depth: Math.min(candidate.depth, 128),
        childCount: Math.min(candidate.childCount, 10_000),
        readableFields: Object.keys(values) as Field[],
      });
    }
    return {
      authority: { referenceVersion: 1, ...current },
      structures,
      completeness: {
        kind: "bounded",
        observed: eligible.length,
        returned: structures.length,
        truncated: eligible.length > candidates.length || candidates.length > structures.length,
      },
    };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export async function readPraxisPublicStructureValue(
  page: Page,
  input: ReadPraxisPublicStructureValueInput,
): Promise<ReadPraxisPublicStructureValueResult> {
  const entry = registries.get(page)?.entries.get(input.reference);
  if (!entry || !entry.values[input.field])
    throw new PraxisStructureError("PUBLIC_STRUCTURE_REFERENCE_UNKNOWN");
  const current = await authority(page).catch(() => undefined);
  if (
    !current ||
    current.documentEpoch !== entry.authority.documentEpoch ||
    current.documentIdentity !== entry.authority.documentIdentity
  )
    throw new PraxisStructureError("PUBLIC_STRUCTURE_REFERENCE_STALE");
  try {
    const admission = admitVeilPublicValue({
      kind: "annotated",
      text: entry.values[input.field]!,
      redactedBoundary: entry.redactedBoundary,
      editableBoundary: entry.editableBoundary,
    });
    return {
      reference: input.reference,
      field: input.field,
      classification: "public",
      provenance: { referenceVersion: 1, ...entry.authority },
      text: entry.values[input.field]!,
      admission: {
        admissionRevision: admission.admissionRevision,
        contentDigest: admission.contentDigest,
        admissionDigest: admission.admissionDigest,
      },
    };
  } catch (error) {
    if (error instanceof VeilPublicValueAdmissionError)
      throw new PraxisStructureError("PUBLIC_STRUCTURE_CLASSIFICATION_REFUSED");
    throw error;
  }
}

async function authority(page: Page) {
  const frame = page.mainFrame();
  const epoch = await PraxisDocumentEpoch.current(page, frame);
  const identity = observationIdentity(page, { kind: "structure" }, "public", epoch, frame);
  return {
    pageId: identity.pageId,
    frameId: identity.frameId,
    documentEpoch: epoch,
    documentIdentity: await PraxisDocumentIdentity.current(page, frame),
  };
}
function empty(current: Awaited<ReturnType<typeof authority>>): InspectPraxisStructureResult {
  return {
    authority: { referenceVersion: 1, ...current },
    structures: [],
    completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
  };
}
function role(value: unknown): Entry["role"] | undefined {
  const normalized = String(value ?? "").toLowerCase();
  return [
    "button",
    "checkbox",
    "combobox",
    "dialog",
    "field",
    "form",
    "heading",
    "link",
    "region",
  ].includes(normalized)
    ? (normalized as Entry["role"])
    : "text";
}
function domCandidates(snapshot: SnapshotIndex): Array<Omit<Entry, "authority">> {
  const { strings, nodes } = snapshot;
  const parents: number[] = nodes.parentIndex ?? [];
  const children: number[][] = nodes.childNodeIndexes ?? [];
  return (nodes.nodeValue ?? []).flatMap((valueIndex: number, index: number) => {
    const text = strings[valueIndex];
    const boundary = snapshot.boundaries[index];
    if (!text?.trim() || !boundary || unsafe(boundary) || !layoutVisible(snapshot, index))
      return [];
    let depth = 0;
    let parent = parents[index] ?? -1;
    while (parent >= 0) {
      depth += 1;
      parent = parents[parent] ?? -1;
    }
    return [
      {
        source: "dom" as const,
        role: "text" as const,
        depth,
        childCount: children[index]?.length ?? 0,
        values: { text },
        ...boundary,
      },
    ];
  });
}
function axCandidates(
  accessibility: any,
  snapshot: SnapshotIndex,
): Array<Omit<Entry, "authority">> {
  const nodes = accessibility.nodes ?? [];
  return nodes.flatMap((node: any) => {
    if (node.ignored === true || accessibilityHidden(node)) return [];
    const nodeIndex = snapshot.backendNodeIndexes.get(node.backendDOMNodeId);
    if (nodeIndex === undefined || !layoutVisible(snapshot, nodeIndex)) return [];
    const boundary = snapshot.boundaries[nodeIndex];
    if (!boundary || unsafe(boundary)) return [];
    const values: Partial<Record<Field, string>> = {};
    for (const field of ["name", "value", "description"] as const) {
      const value = node[field]?.value;
      if (typeof value === "string" && value.trim()) values[field] = value;
    }
    if (!Object.keys(values).length) return [];
    return [
      {
        source: "accessibility" as const,
        role: role(node.role?.value),
        depth: 0,
        childCount: Array.isArray(node.childIds) ? node.childIds.length : 0,
        values,
        ...boundary,
      },
    ];
  });
}

function indexSnapshot(snapshot: any): SnapshotIndex | undefined {
  const document = snapshot.documents?.[0];
  if (!document?.nodes) return undefined;
  const strings: string[] = snapshot.strings ?? [];
  const nodes = document.nodes;
  const nodeCount = nodes.parentIndex?.length ?? 0;
  const attributes = Array.from({ length: nodeCount }, (_, index) =>
    snapshotAttributes(nodes.attributes?.[index], strings),
  );
  const layout = new Map<number, { display?: string; visibility?: string; bounds?: number[] }>();
  for (let index = 0; index < (document.layout?.nodeIndex?.length ?? 0); index += 1) {
    const nodeIndex = document.layout.nodeIndex[index];
    const styles = document.layout.styles?.[index] ?? [];
    layout.set(nodeIndex, {
      display: snapshotString(strings, styles[0]),
      visibility: snapshotString(strings, styles[1]),
      bounds: document.layout.bounds?.[index],
    });
  }
  const backendNodeIndexes = new Map<number, number>();
  for (let index = 0; index < nodeCount; index += 1) {
    const backendNodeId = nodes.backendNodeId?.[index];
    if (typeof backendNodeId === "number") backendNodeIndexes.set(backendNodeId, index);
  }
  const protectedForms = new Set<number>();
  const protectedInputs = new Set<number>();
  for (let index = 0; index < nodeCount; index += 1) {
    if (!isProtectedInput(snapshotString(strings, nodes.nodeName?.[index]), attributes[index]!))
      continue;
    protectedInputs.add(index);
    let ancestor = nodes.parentIndex[index] ?? -1;
    while (ancestor >= 0) {
      if (isForm(snapshotString(strings, nodes.nodeName?.[ancestor]), attributes[ancestor]!)) {
        protectedForms.add(ancestor);
        break;
      }
      ancestor = nodes.parentIndex[ancestor] ?? -1;
    }
  }
  const boundaries: BoundaryFacts[] = [];
  const resolve = (index: number): BoundaryFacts => {
    if (boundaries[index]) return boundaries[index]!;
    const parentIndex = nodes.parentIndex[index] ?? -1;
    const parent = parentIndex >= 0 ? resolve(parentIndex) : safeBoundary();
    const tagName = snapshotString(strings, nodes.nodeName?.[index]).toLowerCase();
    const attrs = attributes[index]!;
    const style = layout.get(index);
    return (boundaries[index] = {
      inaccessibleBoundary:
        parent.inaccessibleBoundary ||
        attrs.has("hidden") ||
        attrs.has("inert") ||
        attrs.get("aria-hidden")?.toLowerCase() === "true" ||
        style?.display === "none" ||
        style?.visibility === "hidden" ||
        style?.visibility === "collapse",
      redactedBoundary:
        parent.redactedBoundary || attrs.get("data-scry-redacted")?.toLowerCase() === "true",
      editableBoundary: parent.editableBoundary || isEditable(tagName, attrs),
      protectedBoundary:
        parent.protectedBoundary || protectedInputs.has(index) || protectedForms.has(index),
    });
  };
  for (let index = 0; index < nodeCount; index += 1) resolve(index);
  return { strings, nodes, attributes, boundaries, backendNodeIndexes, layout };
}

function snapshotAttributes(indexes: number[] | undefined, strings: string[]) {
  const attributes = new Map<string, string>();
  for (let index = 0; index < (indexes?.length ?? 0); index += 2) {
    const name = snapshotString(strings, indexes![index]).toLowerCase();
    if (name) attributes.set(name, snapshotString(strings, indexes![index + 1]));
  }
  return attributes;
}

function snapshotString(strings: string[], index: unknown) {
  return typeof index === "number" && index >= 0 ? (strings[index] ?? "") : "";
}

function safeBoundary(): BoundaryFacts {
  return {
    inaccessibleBoundary: false,
    redactedBoundary: false,
    editableBoundary: false,
    protectedBoundary: false,
  };
}

function unsafe(boundary: BoundaryFacts) {
  return (
    boundary.inaccessibleBoundary ||
    boundary.redactedBoundary ||
    boundary.editableBoundary ||
    boundary.protectedBoundary
  );
}

function layoutVisible(snapshot: SnapshotIndex, nodeIndex: number) {
  const layout = snapshot.layout.get(nodeIndex);
  const bounds = layout?.bounds;
  return Boolean(
    layout &&
    layout.display !== "none" &&
    layout.visibility !== "hidden" &&
    layout.visibility !== "collapse" &&
    bounds &&
    bounds[2]! > 0 &&
    bounds[3]! > 0,
  );
}

function isEditable(tagName: string, attributes: Map<string, string>) {
  if (["input", "textarea", "select"].includes(tagName)) return true;
  return (
    attributes.has("contenteditable") &&
    attributes.get("contenteditable")?.toLowerCase() !== "false"
  );
}

function isProtectedInput(tagName: string, attributes: Map<string, string>) {
  if (tagName.toLowerCase() !== "input") return false;
  return (
    attributes.get("type")?.toLowerCase() === "password" ||
    ["current-password", "new-password", "one-time-code"].includes(
      attributes.get("autocomplete")?.toLowerCase() ?? "",
    )
  );
}

function isForm(tagName: string, attributes: Map<string, string>) {
  return tagName.toLowerCase() === "form" || attributes.get("role")?.toLowerCase() === "form";
}

function accessibilityHidden(node: any) {
  return (node.properties ?? []).some(
    (property: any) =>
      ["hidden", "invisible"].includes(String(property.name).toLowerCase()) &&
      property.value?.value === true,
  );
}
