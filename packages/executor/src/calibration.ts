import { createHash, createHmac } from "node:crypto";
import type { ProtectedTransaction, InteractionTargetIntent } from "@scry/contracts";
import type { Page } from "playwright";
import { resolveTarget } from "@scry/praxis";

export type CalibrationStructure = {
  origin: string;
  pathTemplate: string;
  frames: string[];
  containers: string[];
  roles: string[];
  accessibleNames: string[];
  testIds: string[];
  approvedAttributes: Record<string, string>;
  anchors: Array<{
    intentDigest: string;
    semanticFingerprint?: string;
    matchCount: "zero" | "one" | "many";
    visible: boolean;
    tag: string;
    role: string;
    ancestors: string[];
  }>;
};

export function structureFingerprint(structure: CalibrationStructure) {
  const normalized = {
    origin: new URL(structure.origin).origin,
    pathTemplate: structure.pathTemplate,
    frames: stable(structure.frames),
    containers: stable(structure.containers),
    roles: stable(structure.roles),
    accessibleNames: stable(structure.accessibleNames),
    testIds: stable(structure.testIds),
    approvedAttributes: Object.fromEntries(
      Object.entries(structure.approvedAttributes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    anchors: [...structure.anchors].sort((left, right) =>
      left.intentDigest.localeCompare(right.intentDigest),
    ),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Stable identity for the compiled transaction program. Concrete inputs and display names are excluded. */
export function protectedTransactionDigest(
  operation: ProtectedTransaction,
  allowedOrigins: string[],
) {
  const { calibrationAttestationId: _binding, inputs, ...execution } = operation;
  const subject = {
    ...execution,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [
        name,
        { classification: input.classification },
      ]),
    ),
    extraction: {
      ...execution.extraction,
      outputs: execution.extraction.outputs.map((output) => ({
        ...output,
        storage:
          output.classification === "protected"
            ? { scope: output.storage.scope }
            : { scope: output.storage.scope },
      })),
    },
    allowedOrigins: [...new Set(allowedOrigins.map((value) => new URL(value).origin))].sort(),
  };
  return createHash("sha256").update(stableJson(subject)).digest("hex");
}

export function transactionInputSchemaDigest(operation: ProtectedTransaction) {
  const schema = Object.fromEntries(
    Object.entries(operation.inputs).map(([name, input]) => [
      name,
      { classification: input.classification },
    ]),
  );
  return createHash("sha256").update(stableJson(schema)).digest("hex");
}

export function transactionInputDigest(
  operation: ProtectedTransaction,
  key = process.env.SCRY_TRANSACTION_DIGEST_KEY ?? "development-transaction-digest-key",
) {
  return createHmac("sha256", key).update(stableJson(operation.inputs)).digest("hex");
}

export class CalibrationRequiredError extends Error {
  readonly code = "CALIBRATION_REQUIRED";
  constructor() {
    super("CALIBRATION_REQUIRED");
  }
}

export async function capturePageStructure(
  page: Page,
  operation?: ProtectedTransaction,
): Promise<CalibrationStructure> {
  const anchors = operation
    ? await Promise.all(
        relevantIntents(operation).map(async (target) => {
          const intentDigest = createHash("sha256").update(stableJson(target)).digest("hex");
          try {
            const resolved = await resolveTarget(page, target);
            const observation = await resolved.locator.evaluate((element) => ({
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role") ?? "",
              ancestors: [
                ...(function* () {
                  let current = element.parentElement;
                  let depth = 0;
                  while (current && depth < 6) {
                    yield current.tagName.toLowerCase();
                    current = current.parentElement;
                    depth += 1;
                  }
                })(),
              ],
            }));
            const semanticFingerprint = resolved.diagnostic.selectedFingerprint?.digest;
            return {
              intentDigest,
              ...(semanticFingerprint ? { semanticFingerprint } : {}),
              matchCount: "one" as const,
              visible: await resolved.locator.isVisible(),
              ...observation,
            };
          } catch {
            return {
              intentDigest,
              matchCount: "zero" as const,
              visible: false,
              tag: "",
              role: "",
              ancestors: [],
            };
          }
        }),
      )
    : [];
  const url = new URL(page.url());
  return {
    origin: url.origin,
    pathTemplate: pathTemplate(url.pathname),
    frames: page.frames().map((frame) => {
      try {
        const frameUrl = new URL(frame.url());
        return `${frameUrl.origin}${pathTemplate(frameUrl.pathname)}`;
      } catch {
        return "opaque";
      }
    }),
    containers: [],
    roles: [],
    accessibleNames: [],
    testIds: [],
    approvedAttributes: {},
    anchors,
  };
}

function relevantIntents(operation: ProtectedTransaction): InteractionTargetIntent[] {
  const values: InteractionTargetIntent[] = [
    ...(operation.mutation.action.target ? [operation.mutation.action.target] : []),
    ...operation.preparation.actions.flatMap((action) =>
      "target" in action
        ? [action.target]
        : "assertion" in action && "target" in action.assertion
          ? [action.assertion.target]
          : [],
    ),
    ...operation.entry.assertions.flatMap((assertion) =>
      "target" in assertion ? [assertion.target] : [],
    ),
    ...operation.preparation.assertions.flatMap((assertion) =>
      "target" in assertion ? [assertion.target] : [],
    ),
    ...operation.extraction.outputs.map((output) => output.acquisition.target),
    operation.acquisitionReadiness.ceremonyIntent,
    operation.acquisitionReadiness.valueIntent,
  ];
  const unique = new Map(values.map((value) => [stableJson(value), value]));
  return [...unique.values()];
}

function pathTemplate(pathname: string) {
  return pathname
    .split("/")
    .map((part) =>
      /^\d+$/.test(part) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part) || part.length > 48
        ? ":id"
        : part,
    )
    .join("/");
}

function stable(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
