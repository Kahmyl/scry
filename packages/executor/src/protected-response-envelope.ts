import type { AcquisitionIntent, ProtectedTransaction } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import type { Page, Request, Response } from "playwright";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SAFE_EVIDENCE_COUNT = 100;
const OBSERVED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const OBSERVED_REQUEST_RESOURCE_TYPES = new Set(["document", "fetch", "xhr"]);

type RequestObservation = {
  request: Request;
  method: string;
  resourceType: string;
  envelopeMatched: boolean;
};

type RequestContract = NonNullable<ProtectedTransaction["mutation"]["request"]>;

type EligibleRequestLifecycle = {
  terminal: boolean;
  phase: "awaiting_response" | "awaiting_redirect_handoff" | "body" | "terminal";
  redirectChild?: Request;
};

type OwnedRequestLineage = {
  root: Request;
  requests: Set<Request>;
  rejected: boolean;
};

export type ProtectedResponseEvidence = {
  responseEventObserved: boolean;
  eligibleResponseSelected: boolean;
  httpStatusCode: number | "unavailable";
  statusClass: "2xx" | "4xx" | "5xx" | "other" | "unavailable";
  contentTypeClass: "json" | "text" | "html" | "binary" | "unknown" | "unavailable";
  bodyAcquisitionStarted: boolean;
  bodyAcquisitionSettled: boolean;
  bodyParseStatus: "not_started" | "success" | "failed" | "unavailable";
  stagingStatus: "not_started" | "started" | "success" | "failed" | "timed_out";
  topLevelShape: "object" | "array" | "scalar" | "unavailable";
  declaredSemanticLeafPresent: boolean | "unavailable";
  declaredSemanticLeafMatchCount: "zero" | "one" | "many" | "unavailable";
  selectedPathClass: "root" | "nested_object" | "array_item" | "unavailable";
  extractionResultClass:
    "not_attempted" | "acquired" | "not_present" | "ambiguous" | "rejected" | "unavailable";
  lateResultDiscarded: boolean;
  capturedRootCount: "zero" | "one" | "many";
  ownedLineageCount: "zero" | "one" | "many";
  redirectHopCount: number;
  ignoredUnownedResponseCount: number;
  ownershipStatus: "not_started" | "no_request" | "unique" | "ambiguous" | "rejected";
};

const envelopes = new WeakMap<
  Page,
  {
    responses: unknown[];
    pending: Set<Promise<void>>;
    observedAllowedResponses: number;
    rejectionCodes: string[];
    requests: RequestObservation[];
    eligibleRequests: Map<Request, EligibleRequestLifecycle>;
    requestLineages: Map<Request, OwnedRequestLineage>;
    rootLineages: OwnedRequestLineage[];
    lifecycleWaiters: Set<() => void>;
    unsupportedTransports: Set<string>;
    captureState: "not_started" | "open" | "sealed";
    finalizationState: "active" | "settling" | "finalized";
    settlementResult: boolean | undefined;
    accepting: boolean;
    deadlineAt: number | undefined;
    evidence: ProtectedResponseEvidence;
  }
>();

function initialResponseEvidence(): ProtectedResponseEvidence {
  return {
    responseEventObserved: false,
    eligibleResponseSelected: false,
    httpStatusCode: "unavailable",
    statusClass: "unavailable",
    contentTypeClass: "unavailable",
    bodyAcquisitionStarted: false,
    bodyAcquisitionSettled: false,
    bodyParseStatus: "not_started",
    stagingStatus: "not_started",
    topLevelShape: "unavailable",
    declaredSemanticLeafPresent: "unavailable",
    declaredSemanticLeafMatchCount: "unavailable",
    selectedPathClass: "unavailable",
    extractionResultClass: "not_attempted",
    lateResultDiscarded: false,
    capturedRootCount: "zero",
    ownedLineageCount: "zero",
    redirectHopCount: 0,
    ignoredUnownedResponseCount: 0,
    ownershipStatus: "not_started",
  };
}

export function beginProtectedResponseEnvelope(
  page: Page,
  allowedOrigins: string[],
  redactor: SecretRedactor,
  options?: {
    outputs?: ProtectedTransaction["extraction"]["outputs"];
    stage?: (
      outputs: Array<{
        reference: string;
        classification: "public" | "protected";
        name: string;
        value: string;
        scope: "run" | "project";
      }>,
    ) => Promise<void>;
    request?: RequestContract;
  },
) {
  const allowed = new Set(allowedOrigins);
  const networkAcquisitionDeclared =
    !options?.outputs ||
    options.outputs.some((output) =>
      output.acquisition.permittedMethods.includes("protected_network_value"),
    );
  const envelope = {
    responses: [] as unknown[],
    pending: new Set<Promise<void>>(),
    observedAllowedResponses: 0,
    rejectionCodes: [] as string[],
    requests: [] as RequestObservation[],
    eligibleRequests: new Map<Request, EligibleRequestLifecycle>(),
    requestLineages: new Map<Request, OwnedRequestLineage>(),
    rootLineages: [] as OwnedRequestLineage[],
    lifecycleWaiters: new Set<() => void>(),
    unsupportedTransports: new Set<string>(),
    captureState: "not_started" as "not_started" | "open" | "sealed",
    finalizationState: "active" as "active" | "settling" | "finalized",
    settlementResult: undefined as boolean | undefined,
    accepting: true,
    deadlineAt: undefined as number | undefined,
    evidence: initialResponseEvidence(),
  };

  envelopes.set(page, envelope);

  let stagingAttempted = false;

  const lifecycleChanged = () => {
    for (const notify of envelope.lifecycleWaiters) notify();
    envelope.lifecycleWaiters.clear();
  };

  const finalize = (result: boolean) => {
    if (envelope.finalizationState === "finalized") return;
    envelope.finalizationState = "finalized";
    envelope.settlementResult = result;
    envelope.accepting = false;
    lifecycleChanged();
  };

  const finishRequest = (request: Request) => {
    if (!envelope.accepting) return;
    const lifecycle = envelope.eligibleRequests.get(request);
    if (!lifecycle) return;
    lifecycle.phase = "terminal";
    lifecycle.terminal = true;
    lifecycleChanged();
  };

  const requestListener = (request: Request) => {
    if (!envelope.accepting) return;
    const method = request.method().toUpperCase();
    if (!OBSERVED_METHODS.has(method)) return;

    const resourceType = request.resourceType();
    const redirectedFrom = request.redirectedFrom?.() ?? null;

    if (!redirectedFrom && envelope.captureState !== "open") return;

    if (!OBSERVED_REQUEST_RESOURCE_TYPES.has(resourceType)) {
      if (resourceType === "eventsource") {
        envelope.unsupportedTransports.add("eventsource");
      }
      return;
    }

    let envelopeMatched = false;
    try {
      const url = new URL(request.url());
      envelopeMatched =
        allowed.has(url.origin) &&
        (!options?.request ||
          requestMatchesContract(method, resourceType, url.pathname, options.request));
    } catch {
      return;
    }

    envelope.requests.push({
      request,
      method,
      resourceType,
      envelopeMatched,
    });
    if (redirectedFrom) {
      const lineage = envelope.requestLineages.get(redirectedFrom);
      if (!lineage) return;
      lineage.requests.add(request);
      envelope.requestLineages.set(request, lineage);
      envelope.eligibleRequests.set(request, { terminal: false, phase: "awaiting_response" });
      const parentLifecycle = envelope.eligibleRequests.get(redirectedFrom);
      if (parentLifecycle) {
        parentLifecycle.redirectChild = request;
        if (parentLifecycle.phase === "awaiting_redirect_handoff") {
          finishRequest(redirectedFrom);
        }
      }
      envelope.evidence.redirectHopCount = boundedIncrement(envelope.evidence.redirectHopCount);
      if (!envelopeMatched) {
        lineage.rejected = true;
        envelope.evidence.ownershipStatus = "rejected";
        envelope.evidence.extractionResultClass = "rejected";
        envelope.rejectionCodes.push("PROTECTED_REQUEST_LINEAGE_REJECTED");
      }
      lifecycleChanged();
      return;
    }

    if (envelope.captureState !== "open" || !envelopeMatched) return;
    const lineage: OwnedRequestLineage = {
      root: request,
      requests: new Set([request]),
      rejected: false,
    };
    envelope.rootLineages.push(lineage);
    envelope.requestLineages.set(request, lineage);
    envelope.eligibleRequests.set(request, { terminal: false, phase: "awaiting_response" });
    updateOwnershipEvidence(envelope);
    if (envelope.rootLineages.length > 1) {
      envelope.responses.length = 0;
      envelope.rejectionCodes.push("PROTECTED_REQUEST_LINEAGE_AMBIGUOUS");
    }
    lifecycleChanged();
  };

  const websocketListener = () => {
    if (!envelope.accepting) return;
    envelope.unsupportedTransports.add("websocket");
  };

  const requestFailedListener = (request: Request) => {
    if (!envelope.accepting) return;
    finishRequest(request);
  };

  const responseListener = (response: Response) => {
    if (!envelope.accepting) return;
    const request = response.request();
    const method = request.method();
    if (!OBSERVED_METHODS.has(method)) return;
    const lineage = envelope.requestLineages.get(request);
    if (!lineage) {
      envelope.evidence.ignoredUnownedResponseCount = boundedIncrement(
        envelope.evidence.ignoredUnownedResponseCount,
      );
      return;
    }
    if (envelope.rootLineages.length > 1) {
      envelope.evidence.ownershipStatus = "ambiguous";
      envelope.evidence.extractionResultClass = "rejected";
      finishRequest(request);
      return;
    }
    envelope.evidence.responseEventObserved = true;
    envelope.evidence.httpStatusCode = response.status();
    envelope.evidence.statusClass = statusClass(response.status());
    envelope.evidence.contentTypeClass = contentTypeClass(response.headers()["content-type"]);
    if (lineage.rejected || !allowed.has(new URL(response.url()).origin)) {
      lineage.rejected = true;
      envelope.evidence.ownershipStatus = "rejected";
      envelope.evidence.extractionResultClass = "rejected";
      envelope.rejectionCodes.push("PROTECTED_REQUEST_LINEAGE_REJECTED");
      finishRequest(request);
      return;
    }

    envelope.observedAllowedResponses += 1;
    envelope.evidence.eligibleResponseSelected = true;

    // Redirect responses are transport evidence for the same lineage, never
    // independent semantic candidates. The descendant Request owns the final
    // response and is admitted separately by exact redirect identity.
    if (response.status() >= 300 && response.status() < 400) {
      const lifecycle = envelope.eligibleRequests.get(request);
      if (lifecycle?.redirectChild) finishRequest(request);
      else if (lifecycle) {
        lifecycle.phase = "awaiting_redirect_handoff";
        lifecycleChanged();
      }
      return;
    }

    // DOM/copy-only transactions do not own response bodies. Reading an
    // irrelevant response can hang independently of the declared acquisition
    // path and must not consume that path's lifecycle budget.
    if (!networkAcquisitionDeclared) {
      finishRequest(request);
      return;
    }

    if (response.status() < 200 || response.status() >= 400) {
      envelope.rejectionCodes.push("PROTECTED_RESPONSE_HTTP_REJECTED");
      envelope.evidence.extractionResultClass = "rejected";
      finishRequest(request);
      return;
    }

    const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
    if (!contentType.includes("json")) {
      envelope.rejectionCodes.push("PROTECTED_RESPONSE_NON_JSON");
      envelope.evidence.extractionResultClass = "rejected";
      finishRequest(request);
      return;
    }

    const declared = Number(response.headers()["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      envelope.rejectionCodes.push("PROTECTED_RESPONSE_OVERSIZED");
      envelope.evidence.extractionResultClass = "rejected";
      finishRequest(request);
      return;
    }

    envelope.evidence.bodyAcquisitionStarted = true;
    const lifecycle = envelope.eligibleRequests.get(request);
    if (lifecycle) lifecycle.phase = "body";
    let work: Promise<void>;
    work = (async () => {
      let body: Buffer;
      try {
        body = await response.body();
        if (!envelope.accepting) return;
        envelope.evidence.bodyAcquisitionSettled = true;
      } catch {
        if (!envelope.accepting) return;
        envelope.evidence.bodyAcquisitionSettled = true;
        envelope.evidence.bodyParseStatus = "unavailable";
        envelope.evidence.extractionResultClass = "unavailable";
        envelope.rejectionCodes.push("PROTECTED_RESPONSE_BODY_UNAVAILABLE");
        return;
      }

      if (!envelope.accepting) return;
      if (
        envelope.rootLineages.length !== 1 ||
        envelope.rootLineages[0] !== lineage ||
        lineage.rejected
      ) {
        envelope.evidence.lateResultDiscarded = true;
        return;
      }
      if (body.byteLength > MAX_RESPONSE_BYTES) {
        envelope.rejectionCodes.push("PROTECTED_RESPONSE_OVERSIZED");
        envelope.evidence.extractionResultClass = "rejected";
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        envelope.evidence.bodyParseStatus = "failed";
        envelope.evidence.extractionResultClass = "unavailable";
        envelope.rejectionCodes.push("PROTECTED_RESPONSE_PARSE_FAILED");
        return;
      }
      envelope.evidence.bodyParseStatus = "success";
      envelope.evidence.topLevelShape = topLevelShape(parsed);

      for (const value of stringLeaves(parsed)) redactor.add(value);

      envelope.responses.push(parsed);
    })().finally(() => {
      envelope.pending.delete(work);
      if (envelope.accepting) {
        finishRequest(request);
        lifecycleChanged();
      }
    });

    envelope.pending.add(work);
    lifecycleChanged();
  };

  page.on("request", requestListener);
  page.on("requestfailed", requestFailedListener);
  page.on("websocket", websocketListener);
  page.on("response", responseListener);

  return {
    beginActionCapture() {
      if (envelope.captureState !== "not_started") {
        throw new Error("PROTECTED_RESPONSE_ACTION_CAPTURE_ALREADY_STARTED");
      }
      envelope.captureState = "open";
      envelope.evidence.ownershipStatus = "no_request";
    },
    endActionCapture() {
      if (envelope.captureState === "sealed") return;
      if (envelope.captureState !== "open") {
        throw new Error("PROTECTED_RESPONSE_ACTION_CAPTURE_NOT_STARTED");
      }
      envelope.captureState = "sealed";
      updateOwnershipEvidence(envelope);
      lifecycleChanged();
    },
    evidence() {
      return { ...envelope.evidence };
    },
    async waitForRequestInitiation(timeoutMs: number) {
      const deadline = Date.now() + Math.max(0, timeoutMs);

      while (Date.now() < deadline) {
        const initiated = uniqueOwnedRootObservation(envelope);
        if (envelope.rootLineages.length > 1) return { status: "lineage_ambiguous" as const };
        if (initiated) {
          return {
            status: "initiated" as const,
            method: initiated.method,
            resourceType: initiated.resourceType,
            envelopeMatched: true as const,
          };
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))),
        );
      }

      const initiated = uniqueOwnedRootObservation(envelope);

      if (envelope.rootLineages.length > 1) return { status: "lineage_ambiguous" as const };

      if (initiated) {
        return {
          status: "initiated" as const,
          method: initiated.method,
          resourceType: initiated.resourceType,
          envelopeMatched: true as const,
        };
      }

      const outsideEnvelope = envelope.requests.find((request) => !request.envelopeMatched);

      if (outsideEnvelope) {
        return {
          status: "outside_envelope" as const,
          method: outsideEnvelope.method,
          resourceType: outsideEnvelope.resourceType,
          envelopeMatched: false as const,
        };
      }

      const unsupportedTransport = envelope.unsupportedTransports.values().next().value;

      if (unsupportedTransport) {
        return {
          status: "unsupported_transport" as const,
          transport: unsupportedTransport,
        };
      }

      return {
        status: "not_observed" as const,
      };
    },

    async settle(timeoutMs = 10_000) {
      if (envelope.finalizationState === "finalized") {
        return envelope.settlementResult ?? false;
      }
      envelope.finalizationState = "settling";
      if (envelope.captureState === "open") {
        envelope.captureState = "sealed";
        updateOwnershipEvidence(envelope);
      }
      envelope.deadlineAt = Date.now() + Math.max(0, timeoutMs);
      if (envelope.rootLineages.length !== 1 || envelope.rootLineages[0]!.rejected) {
        if (envelope.rootLineages.length > 1) {
          envelope.rejectionCodes.push("PROTECTED_REQUEST_LINEAGE_AMBIGUOUS");
        } else if (envelope.rootLineages[0]?.rejected) {
          envelope.rejectionCodes.push("PROTECTED_REQUEST_LINEAGE_REJECTED");
        }
        finalize(true);
        return true;
      }
      const settled = await settleResponseLifecycle(envelope, timeoutMs);
      if (!settled) {
        if (
          [...envelope.eligibleRequests.values()].some(
            (request) => request.phase === "awaiting_redirect_handoff",
          )
        ) {
          envelope.rejectionCodes.push("PROTECTED_REQUEST_REDIRECT_HANDOFF_TIMEOUT");
        } else {
          envelope.rejectionCodes.push("PROTECTED_RESPONSE_SETTLEMENT_TIMEOUT");
        }
        if (envelope.pending.size > 0) envelope.evidence.lateResultDiscarded = true;
        finalize(false);
        return false;
      }
      // Lifecycle quiescence freezes the aggregate before semantic analysis
      // and staging. Only settlement bookkeeping may proceed past this point.
      envelope.accepting = false;
      if (!options?.outputs || !options.stage || stagingAttempted) {
        finalize(true);
        return true;
      }
      stagingAttempted = true;
      const analyses = options.outputs.map((output) =>
        rankedResponseAnalysis(envelope.responses, output.acquisition),
      );
      applySemanticEvidence(envelope.evidence, analyses);
      const outputs = responseOutputs(envelope.responses, options.outputs);
      if (!outputs) {
        finalize(true);
        return true;
      }
      envelope.evidence.stagingStatus = "started";
      const remaining = Math.max(0, envelope.deadlineAt - Date.now());
      let stageFailure: unknown;
      let stageWork: Promise<void>;
      stageWork = options
        .stage(outputs)
        .then(
          () => undefined,
          (error) => {
            stageFailure = error;
          },
        )
        .finally(() => envelope.pending.delete(stageWork));
      envelope.pending.add(stageWork);
      if (!(await settlePending(envelope.pending, remaining))) {
        envelope.evidence.stagingStatus = "timed_out";
        envelope.evidence.extractionResultClass = "unavailable";
        envelope.evidence.lateResultDiscarded = true;
        envelope.rejectionCodes.push("PROTECTED_RESPONSE_STAGING_TIMEOUT");
        finalize(false);
        return false;
      }
      await stageWork;
      if (stageFailure !== undefined) {
        envelope.evidence.stagingStatus = "failed";
        envelope.evidence.extractionResultClass = "unavailable";
        envelope.rejectionCodes.push("PROTECTED_RESPONSE_STAGING_FAILED");
        finalize(true);
        return true;
      }
      if (Date.now() > envelope.deadlineAt) {
        envelope.evidence.lateResultDiscarded = true;
        finalize(false);
        return false;
      }
      envelope.evidence.stagingStatus = "success";
      envelope.evidence.extractionResultClass = "acquired";
      finalize(true);
      return true;
    },

    async close() {
      finalize(envelope.settlementResult ?? false);
      page.off("request", requestListener);
      page.off("requestfailed", requestFailedListener);
      page.off("websocket", websocketListener);
      page.off("response", responseListener);

      await settlePending(envelope.pending, 250);

      envelope.responses.length = 0;
      envelope.requests.length = 0;
      envelope.eligibleRequests.clear();
      envelope.requestLineages.clear();
      envelope.rootLineages.length = 0;
      lifecycleChanged();
      envelope.unsupportedTransports.clear();

      envelopes.delete(page);
    },
  };
}

function requestMatchesContract(
  method: string,
  resourceType: string,
  pathname: string,
  contract: RequestContract,
) {
  if (method !== contract.method || !contract.transports.some((type) => type === resourceType))
    return false;
  const expected = contract.pathTemplate.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) =>
    /^\{[a-zA-Z][a-zA-Z0-9_-]*\}$/.test(segment)
      ? Boolean(actual[index])
      : segment === actual[index],
  );
}

function updateOwnershipEvidence(envelope: {
  rootLineages: OwnedRequestLineage[];
  evidence: ProtectedResponseEvidence;
}) {
  const count = envelope.rootLineages.length;
  const category = count === 0 ? "zero" : count === 1 ? "one" : "many";
  envelope.evidence.capturedRootCount = category;
  envelope.evidence.ownedLineageCount = category;
  envelope.evidence.ownershipStatus =
    count === 0
      ? "no_request"
      : count > 1
        ? "ambiguous"
        : envelope.rootLineages[0]!.rejected
          ? "rejected"
          : "unique";
}

function boundedIncrement(value: number) {
  return Math.min(MAX_SAFE_EVIDENCE_COUNT, value + 1);
}

function uniqueOwnedRootObservation(envelope: {
  rootLineages: OwnedRequestLineage[];
  requests: RequestObservation[];
}) {
  if (envelope.rootLineages.length !== 1) return undefined;
  const root = envelope.rootLineages[0]!.root;
  return envelope.requests.find((observation) => observation.request === root);
}

async function settlePending(pending: Set<Promise<void>>, timeoutMs: number) {
  if (pending.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.allSettled([...pending]).then(() => true as const),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleResponseLifecycle(
  envelope: {
    pending: Set<Promise<void>>;
    eligibleRequests: Map<Request, EligibleRequestLifecycle>;
    lifecycleWaiters: Set<() => void>;
  },
  timeoutMs: number,
) {
  const deadlineAt = Date.now() + Math.max(0, timeoutMs);
  while (
    envelope.pending.size > 0 ||
    [...envelope.eligibleRequests.values()].some((request) => !request.terminal)
  ) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      const changed = () => {
        if (timer) clearTimeout(timer);
        envelope.lifecycleWaiters.delete(changed);
        resolve();
      };
      envelope.lifecycleWaiters.add(changed);
      timer = setTimeout(changed, remainingMs);
      timer.unref?.();
      // Close the check/subscription gap if listener work completed synchronously.
      if (
        envelope.pending.size === 0 &&
        [...envelope.eligibleRequests.values()].every((request) => request.terminal)
      )
        changed();
    });
  }
  return true;
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
    if (!output.acquisition.permittedMethods.includes("protected_network_value")) {
      return undefined;
    }

    const values = rankedResponseValues(response, output.acquisition);
    if (values.length !== 1) return undefined;

    acquired.push({
      reference: output.reference,
      classification: output.classification,
      name:
        output.classification === "protected" ? output.storage.credentialName : output.storage.name,
      value: values[0]!,
      scope: output.storage.scope,
    });
  }

  return acquired;
}

export async function acquireProtectedResponseValue(page: Page, acquisition: AcquisitionIntent) {
  const envelope = envelopes.get(page);

  if (!envelope) {
    throw new Error("PROTECTED_RESPONSE_ENVELOPE_UNAVAILABLE");
  }

  if (envelope.rootLineages.length > 1) {
    throw new Error("PROTECTED_REQUEST_LINEAGE_AMBIGUOUS");
  }
  if (envelope.rootLineages.length === 0) {
    throw new Error("PROTECTED_REQUEST_NOT_INITIATED");
  }
  if (envelope.rootLineages[0]!.rejected) {
    throw new Error("PROTECTED_REQUEST_LINEAGE_REJECTED");
  }
  if (envelope.finalizationState !== "finalized" || envelope.settlementResult !== true) {
    throw new Error(envelope.rejectionCodes.at(-1) ?? "PROTECTED_RESPONSE_SETTLEMENT_INCOMPLETE");
  }

  const analysis = rankedResponseAnalysis(envelope.responses, acquisition);
  // Absence of an admitted, parsed response is not evidence that the declared
  // semantic leaf was absent. Preserve "unavailable" for HTTP rejection,
  // body failure, parse failure, and no-response paths.
  if (envelope.responses.length > 0) {
    applySemanticEvidence(envelope.evidence, [analysis]);
  }
  const unique = analysis.values;

  if (unique.length !== 1) {
    if (unique.length) {
      throw new Error("PROTECTED_RESPONSE_VALUE_AMBIGUOUS");
    }

    if (!envelope.responses.length) {
      throw new Error(
        envelope.rejectionCodes.at(-1) ??
          (envelope.observedAllowedResponses
            ? "PROTECTED_RESPONSE_NOT_ACCEPTED"
            : "PROTECTED_RESPONSE_NOT_OBSERVED"),
      );
    }

    throw new Error("PROTECTED_RESPONSE_VALUE_UNAVAILABLE");
  }

  return unique[0]!;
}

type RankedResponseAnalysis = {
  values: string[];
  matchCount: "zero" | "one" | "many";
  pathClass: "root" | "nested_object" | "array_item" | "unavailable";
};

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

    if (normalized.endsWith("value")) {
      identities.add(normalized.slice(0, -"value".length));
    }
  }

  return identities;
}

function rankedResponseValues(response: unknown, acquisition: AcquisitionIntent) {
  return rankedResponseAnalysis(response, acquisition).values;
}

function rankedResponseAnalysis(
  response: unknown,
  acquisition: AcquisitionIntent,
): RankedResponseAnalysis {
  const identities = semanticIdentities(acquisition);
  const context = semanticContext(acquisition);

  const candidates = keyedStringLeaves(response)
    .filter((leaf) => identities.has(normalize(leaf.key)) && leaf.value)
    .map((leaf) => ({
      ...leaf,
      overlap: leaf.path.reduce(
        (score, segment) => score + (context.has(normalize(segment)) ? 1 : 0),
        0,
      ),
    }));

  if (!candidates.length) return { values: [], matchCount: "zero", pathClass: "unavailable" };

  const bestOverlap = Math.max(...candidates.map((candidate) => candidate.overlap));

  const contextual = candidates.filter((candidate) => candidate.overlap === bestOverlap);

  const shallowest = Math.min(...contextual.map((candidate) => candidate.path.length));

  const selected = contextual.filter((candidate) => candidate.path.length === shallowest);
  const values = [...new Set(selected.map((candidate) => candidate.value))];
  return {
    values,
    matchCount: values.length === 0 ? "zero" : values.length === 1 ? "one" : "many",
    pathClass: values.length === 1 ? classifyPath(selected[0]!.path) : "unavailable",
  };
}

function applySemanticEvidence(
  evidence: ProtectedResponseEvidence,
  analyses: RankedResponseAnalysis[],
) {
  if (!analyses.length) return;
  const counts = analyses.map((analysis) => analysis.matchCount);
  evidence.declaredSemanticLeafPresent = counts.every((count) => count === "zero") ? false : true;
  evidence.declaredSemanticLeafMatchCount = counts.some((count) => count === "many")
    ? "many"
    : counts.every((count) => count === "one")
      ? "one"
      : "zero";
  evidence.selectedPathClass =
    evidence.declaredSemanticLeafMatchCount === "one" ? analyses[0]!.pathClass : "unavailable";
  evidence.extractionResultClass =
    evidence.declaredSemanticLeafMatchCount === "one"
      ? "acquired"
      : evidence.declaredSemanticLeafMatchCount === "many"
        ? "ambiguous"
        : "not_present";
}

function classifyPath(path: string[]): "root" | "nested_object" | "array_item" {
  if (path.length <= 1) return "root";
  return path.slice(0, -1).some((segment) => /^\d+$/.test(segment))
    ? "array_item"
    : "nested_object";
}

function statusClass(status: number): ProtectedResponseEvidence["statusClass"] {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function contentTypeClass(
  value: string | undefined,
): ProtectedResponseEvidence["contentTypeClass"] {
  const normalized = value?.toLowerCase() ?? "";
  if (!normalized) return "unknown";
  if (normalized.includes("json")) return "json";
  if (normalized.includes("html")) return "html";
  if (normalized.startsWith("text/")) return "text";
  return "binary";
}

function topLevelShape(value: unknown): ProtectedResponseEvidence["topLevelShape"] {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "scalar";
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
      .flatMap((value) =>
        value
          .normalize("NFKC")
          .toLocaleLowerCase()
          .split(/[^a-z0-9]+/),
      )
      .map(normalize)
      .filter(
        (value) =>
          value && !keyIdentities.has(value) && !["retrieved", "response", "value"].includes(value),
      ),
  );
}

function keyedStringLeaves(
  value: unknown,
  path: string[] = [],
): Array<{ key: string; path: string[]; value: string }> {
  if (typeof value === "string") {
    return [{ key: path.at(-1) ?? "", path, value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => keyedStringLeaves(item, [...path, String(index)]));
  }

  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([childKey, child]) =>
    keyedStringLeaves(child, [...path, childKey]),
  );
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];

  if (Array.isArray(value)) {
    return value.flatMap(stringLeaves);
  }

  if (!value || typeof value !== "object") return [];

  return Object.values(value).flatMap(stringLeaves);
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
