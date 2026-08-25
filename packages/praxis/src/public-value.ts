import { randomBytes } from "node:crypto";

import {
  VeilPublicValueAdmissionError,
  admitVeilPublicValue,
  classifyVeilPublicValue,
  type VeilPublicValueClassification,
  type VeilPublicValueKind,
} from "@scry/veil";
import type { Page } from "playwright";

import { PraxisStaleTargetError } from "./observation.js";
import {
  observeTargetReference,
  type PraxisTargetReference,
} from "./references/target-reference.js";

const PUBLIC_VALUE_SELECTOR = "code,pre,output,[data-scry-public-value]";
const MAX_PUBLIC_VALUE_CANDIDATES = 100;
const MAX_PUBLIC_VALUE_REFERENCES = 24;
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

const readableValues = new WeakMap<Page, Map<string, ReadableValueEntry>>();

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
  const previous = readableValues.get(page);

  if (previous) {
    await Promise.all([...previous.values()].map(({ target }) => target.dispose()));
  }

  const registry = new Map<string, ReadableValueEntry>();
  readableValues.set(page, registry);

  const candidates = page.locator(PUBLIC_VALUE_SELECTOR);
  const observed = await candidates.count();
  const examined = Math.min(observed, MAX_PUBLIC_VALUE_CANDIDATES);
  const values: PraxisReadableValue[] = [];

  for (let index = 0; index < examined; index += 1) {
    if (values.length >= MAX_PUBLIC_VALUE_REFERENCES) break;

    const locator = candidates.nth(index);

    const metadata = await locator
      .evaluate((element) => {
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
      })
      .catch(() => null);

    if (!metadata) continue;

    let target: PraxisTargetReference;

    try {
      target = await observeTargetReference(page, locator, {
        timeoutMs: 1_000,
      });
    } catch {
      continue;
    }

    const classification = classifyVeilPublicValue(metadata);
    let context: string | undefined;

    if (classification === "public") {
      try {
        context = admitVeilPublicValue(metadata).safeContext;
      } catch {
        context = undefined;
      }
    }

    const reference = `context-value-${randomBytes(16).toString("hex")}`;

    registry.set(reference, {
      target,
      kind: metadata.kind,
      classification,
      ...(context ? { context } : {}),
    });

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
      observed,
      returned: values.length,
      truncated:
        observed > examined ||
        examined > values.length ||
        values.length >= MAX_PUBLIC_VALUE_REFERENCES,
    },
  };
}

export async function readPraxisPublicValue(
  page: Page,
  input: PraxisPublicValueReadInput,
): Promise<PraxisPublicValueRead> {
  const entry = readableValues.get(page)?.get(input.reference);

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
