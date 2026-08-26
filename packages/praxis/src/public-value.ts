import { randomBytes } from "node:crypto";

import {
  VeilPublicValueAdmissionError,
  admitVeilPublicValue,
  classifyVeilPublicValue,
  type VeilPublicValueClassification,
  type VeilPublicValueKind,
} from "@scry/veil";
import type { ElementHandle, Locator, Page } from "playwright";

import { PraxisStaleTargetError } from "./observation.js";
import {
  observeExactTargetReference,
  observeTargetReference,
  type PraxisTargetReference,
} from "./references/target-reference.js";

const PUBLIC_VALUE_SELECTOR = "code,pre,output,[data-scry-public-value]";
const MAX_PUBLIC_VALUE_CANDIDATES = 100;
const MAX_PUBLIC_VALUE_REFERENCES = 24;
export const MAX_REGION_PUBLIC_VALUE_CANDIDATES = 128;
export const MAX_REGION_PUBLIC_VALUE_REFERENCES = 32;
const DEFAULT_PUBLIC_VALUE_READ_BYTES = 2_048;
const MAX_PUBLIC_VALUE_READ_BYTES = 4_096;

export type PraxisReadableValue = Readonly<{
  reference: string;
  kind: VeilPublicValueKind;
  classification: VeilPublicValueClassification;
  context?: string;
}>;

export type PraxisReadableValueObservation = Readonly<{
  values: readonly PraxisReadableValue[];
  completeness: Readonly<{
    kind: "bounded";
    observed: number;
    returned: number;
    truncated: boolean;
  }>;
}>;

export type PraxisPublicValueReadInput = Readonly<{
  reference: string;
  offset?: number;
  maxBytes?: number;
}>;

export type PraxisPublicValueRead = Readonly<{
  reference: string;
  classification: "public";
  provenance: Readonly<{
    referenceVersion: 1;
    pageId: string;
    frameId: string;
    documentEpoch: number;
    documentIdentity: string;
  }>;
  element: Readonly<{
    kind: VeilPublicValueKind;
    context?: string;
  }>;
  text: string;
  offset: number;
  returnedBytes: number;
  totalBytes: number;
  truncated: boolean;
  nextOffset?: number;
  admission: Readonly<{
    admissionRevision: number;
    contentDigest: string;
    admissionDigest: string;
  }>;
}>;

type ReadableValueEntry = {
  target: PraxisTargetReference;
  kind: VeilPublicValueKind;
  classification: VeilPublicValueClassification;
  context?: string;
};

type ReadableValueRegistry = {
  entries: Map<string, ReadableValueEntry>;
  regionReferences: Set<string>;
};

const readableValues = new WeakMap<Page, ReadableValueRegistry>();

export class PraxisPublicValueReadError extends Error {
  override readonly name = "PraxisPublicValueReadError";

  constructor(
    readonly code:
      | "PUBLIC_VALUE_REFERENCE_UNKNOWN"
      | "PUBLIC_VALUE_REFERENCE_STALE"
      | "PUBLIC_VALUE_CLASSIFICATION_REFUSED"
      | "PUBLIC_VALUE_READ_OFFSET_INVALID",
  ) {
    super(code);
  }
}

export async function observePublicValueCandidates(
  page: Page,
): Promise<PraxisReadableValueObservation> {
  const candidates = page.locator(PUBLIC_VALUE_SELECTOR);
  return observePublicValueCandidateSource(page, {
    observed: await candidates.count(),
    maximumCandidates: MAX_PUBLIC_VALUE_CANDIDATES,
    maximumReferences: MAX_PUBLIC_VALUE_REFERENCES,
    registryScope: "document",
    candidate: async (index) => ({ locator: candidates.nth(index) }),
  });
}

/**
 * Discover public-value candidates beneath one exact semantic region handle.
 * This never scans the document outside that handle and never reads candidates
 * within hidden, editable, inert, aria-hidden, or explicitly redacted bounds.
 */
export async function observePublicValueCandidatesInRegion(
  page: Page,
  region: ElementHandle<HTMLElement>,
): Promise<PraxisReadableValueObservation> {
  const observed = await region.evaluate(
    (element, selector) =>
      (element.matches(selector) ? 1 : 0) + element.querySelectorAll(selector).length,
    PUBLIC_VALUE_SELECTOR,
  );

  return observePublicValueCandidateSource(page, {
    observed,
    maximumCandidates: MAX_REGION_PUBLIC_VALUE_CANDIDATES,
    maximumReferences: MAX_REGION_PUBLIC_VALUE_REFERENCES,
    registryScope: "region",
    excludeUnsafeBoundaries: true,
    candidate: async (index) => {
      const candidate = await region.evaluateHandle(
        (element, input) => {
          if (element.matches(input.selector)) {
            if (input.index === 0) return element;
            return element.querySelectorAll(input.selector).item(input.index - 1);
          }
          return element.querySelectorAll(input.selector).item(input.index);
        },
        { selector: PUBLIC_VALUE_SELECTOR, index },
      );
      const element = candidate.asElement() as ElementHandle<HTMLElement> | null;
      if (!element) {
        await candidate.dispose().catch(() => undefined);
        return undefined;
      }
      return { element };
    },
  });
}

type PublicValueCandidate =
  | Readonly<{ locator: Locator; element?: never }>
  | Readonly<{ element: ElementHandle<HTMLElement>; locator?: never }>;

async function observePublicValueCandidateSource(
  page: Page,
  input: Readonly<{
    observed: number;
    maximumCandidates: number;
    maximumReferences: number;
    registryScope: "document" | "region";
    excludeUnsafeBoundaries?: boolean;
    candidate(index: number): Promise<PublicValueCandidate | undefined>;
  }>,
): Promise<PraxisReadableValueObservation> {
  const registry = await prepareReadableValueRegistry(page, input.registryScope);

  const examined = Math.min(input.observed, input.maximumCandidates);
  const values: PraxisReadableValue[] = [];

  for (let index = 0; index < examined; index += 1) {
    if (values.length >= input.maximumReferences) break;

    const candidate = await input.candidate(index).catch(() => undefined);
    if (!candidate) continue;
    const metadata = await (
      candidate.locator
        ? candidate.locator.evaluate(
            readPublicValueCandidateMetadata,
            Boolean(input.excludeUnsafeBoundaries),
          )
        : candidate.element.evaluate(
            readPublicValueCandidateMetadata,
            Boolean(input.excludeUnsafeBoundaries),
          )
    ).catch(() => null);

    if (!metadata) {
      await candidate.element?.dispose().catch(() => undefined);
      continue;
    }

    let target: PraxisTargetReference;

    try {
      target = candidate.locator
        ? await observeTargetReference(page, candidate.locator, { timeoutMs: 1_000 })
        : await observeExactTargetReference(page, candidate.element);
    } catch {
      await candidate.element?.dispose().catch(() => undefined);
      continue;
    }

    const classification = classifyVeilPublicValue(metadata);
    let context: string | undefined;

    if (classification === "public") {
      try {
        context = observationSafeContext(admitVeilPublicValue(metadata).safeContext, metadata.text);
      } catch {
        context = undefined;
      }
    }

    const reference = `context-value-${randomBytes(16).toString("hex")}`;

    registry.entries.set(reference, {
      target,
      kind: metadata.kind,
      classification,
      ...(context ? { context } : {}),
    });
    if (input.registryScope === "region") registry.regionReferences.add(reference);

    values.push({
      reference,
      kind: metadata.kind,
      classification,
      ...(context ? { context } : {}),
    });
  }

  return {
    values,
    completeness: {
      kind: "bounded",
      observed: input.observed,
      returned: values.length,
      truncated:
        input.observed > examined ||
        examined > values.length ||
        values.length >= input.maximumReferences,
    },
  };
}

async function prepareReadableValueRegistry(page: Page, scope: "document" | "region") {
  const previous = readableValues.get(page);
  if (scope === "document") {
    if (previous)
      await Promise.all([...previous.entries.values()].map(({ target }) => target.dispose()));
    const registry: ReadableValueRegistry = {
      entries: new Map(),
      regionReferences: new Set(),
    };
    readableValues.set(page, registry);
    return registry;
  }

  const registry =
    previous ??
    ({ entries: new Map(), regionReferences: new Set() } satisfies ReadableValueRegistry);
  for (const reference of registry.regionReferences) {
    await registry.entries.get(reference)?.target.dispose();
    registry.entries.delete(reference);
  }
  registry.regionReferences.clear();
  readableValues.set(page, registry);
  return registry;
}

function observationSafeContext(context: string | undefined, exactText: string) {
  if (!context) return undefined;
  const normalizedContext = context.replace(/\s+/g, " ").trim();
  const normalizedText = exactText.replace(/\s+/g, " ").trim();
  if (normalizedText && normalizedContext.includes(normalizedText)) return undefined;
  return context;
}

function readPublicValueCandidateMetadata(element: Element, excludeUnsafeBoundaries: boolean) {
  const html = element as HTMLElement;
  const style = getComputedStyle(html);
  const rect = html.getBoundingClientRect();

  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    element.closest('[aria-hidden="true"],[inert]')
  ) {
    return null;
  }

  const redactedBoundary = Boolean(element.closest('[data-scry-redacted="true"]'));
  const editableBoundary = Boolean(
    element.closest('input,textarea,[contenteditable]:not([contenteditable="false"])'),
  );
  if (excludeUnsafeBoundaries && (redactedBoundary || editableBoundary)) return null;

  const tag = element.tagName.toLowerCase();
  const headingBoundary = element.closest("section,article,main,[role=region],[role=group]");
  const headingCandidate = headingBoundary?.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
  const heading = headingCandidate?.closest(
    '[data-scry-redacted="true"],[aria-hidden="true"],[inert]',
  )
    ? undefined
    : headingCandidate;

  return {
    kind: (tag === "code" || tag === "pre" || tag === "output" ? tag : "annotated") as
      "code" | "pre" | "output" | "annotated",
    text: element.textContent ?? "",
    redactedBoundary,
    editableBoundary,
    contextLabel:
      element.getAttribute("aria-label") ||
      heading?.textContent ||
      headingBoundary?.getAttribute("aria-label") ||
      "",
  };
}

export async function readPraxisPublicValue(
  page: Page,
  input: PraxisPublicValueReadInput,
): Promise<PraxisPublicValueRead> {
  const entry = readableValues.get(page)?.entries.get(input.reference);

  if (!entry) {
    throw new PraxisPublicValueReadError("PUBLIC_VALUE_REFERENCE_UNKNOWN");
  }

  try {
    await entry.target.assertCurrent();
  } catch (error) {
    if (error instanceof PraxisStaleTargetError) {
      throw new PraxisPublicValueReadError("PUBLIC_VALUE_REFERENCE_STALE");
    }
    throw error;
  }

  const metadata = await entry.target.element().evaluate((element) => {
    const tag = element.tagName.toLowerCase();
    const headingBoundary = element.closest("section,article,main,[role=region],[role=group]");
    const heading = headingBoundary?.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");

    return {
      kind: (tag === "code" || tag === "pre" || tag === "output" ? tag : "annotated") as
        "code" | "pre" | "output" | "annotated",
      text: element.textContent ?? "",
      redactedBoundary: Boolean(element.closest('[data-scry-redacted="true"]')),
      editableBoundary: Boolean(
        element.closest('input,textarea,[contenteditable]:not([contenteditable="false"])'),
      ),
      contextLabel:
        element.getAttribute("aria-label") ||
        heading?.textContent ||
        headingBoundary?.getAttribute("aria-label") ||
        "",
    };
  });

  let admission;

  try {
    admission = admitVeilPublicValue(metadata);
  } catch (error) {
    if (error instanceof VeilPublicValueAdmissionError) {
      throw new PraxisPublicValueReadError("PUBLIC_VALUE_CLASSIFICATION_REFUSED");
    }
    throw error;
  }

  const bytes = Buffer.from(metadata.text, "utf8");
  const offset = input.offset ?? 0;

  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new PraxisPublicValueReadError("PUBLIC_VALUE_READ_OFFSET_INVALID");
  }

  const maxBytes = Math.min(
    MAX_PUBLIC_VALUE_READ_BYTES,
    Math.max(1, Math.floor(input.maxBytes ?? DEFAULT_PUBLIC_VALUE_READ_BYTES)),
  );

  const { text, end } = utf8Slice(bytes, offset, maxBytes);

  return {
    reference: input.reference,
    classification: "public",
    provenance: entry.target.toJSON(),
    element: {
      kind: entry.kind,
      ...(admission.safeContext ? { context: admission.safeContext } : {}),
    },
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

function utf8Slice(bytes: Buffer, requestedStart: number, maxBytes: number) {
  let start = requestedStart;

  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }

  let end = Math.min(bytes.length, start + maxBytes);

  while (end < bytes.length && end > start && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  if (end === start && start < bytes.length) {
    end = Math.min(bytes.length, start + 4);

    while (end < bytes.length && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
      end += 1;
    }
  }

  return {
    text: bytes.subarray(start, end).toString("utf8"),
    end,
  };
}
