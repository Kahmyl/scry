import { createHash } from "node:crypto";
import type { CandidateEvidence, EvidenceFamily } from "@scry/contracts";
import type { Frame, Locator, Page } from "playwright";

export const PRAXIS_OBSERVATION_RUNTIME_VERSION = "1";
export const PRAXIS_GROUNDING_POLICY_VERSION = 1;

export type PraxisProviderCost = "constant" | "low" | "medium" | "high";
export type PraxisProviderPrivacy = "public_dom" | "accessibility" | "visual" | "ocr" | "protected";
export type PraxisProviderOutcome = "succeeded" | "degraded" | "forbidden" | "timed_out" | "failed";
export type PraxisProviderTiming = {
  provider: string;
  durationMs: number;
  outcome: PraxisProviderOutcome;
};

export interface PraxisEvidenceProvider<TContext = unknown> {
  readonly id: string;
  readonly version: number;
  readonly families: readonly EvidenceFamily[];
  readonly cost: PraxisProviderCost;
  readonly privacy: PraxisProviderPrivacy;
  readonly concurrent: boolean;
  readonly maximumWork: number;
  observe(context: TContext, signal: AbortSignal): Promise<readonly CandidateEvidence[]>;
  sanitize(evidence: readonly CandidateEvidence[]): readonly CandidateEvidence[];
}

export const PRAXIS_PROVIDER_CATALOG = Object.freeze([
  {
    id: "native-control",
    version: 1,
    families: ["native_control"],
    cost: "constant",
    privacy: "public_dom",
    concurrent: true,
    maximumWork: 5_000,
  },
  {
    id: "computed-accessibility",
    version: 1,
    families: ["accessibility"],
    cost: "low",
    privacy: "accessibility",
    concurrent: true,
    maximumWork: 5_000,
  },
  {
    id: "textual-identity",
    version: 1,
    families: ["textual"],
    cost: "low",
    privacy: "public_dom",
    concurrent: true,
    maximumWork: 5_000,
  },
  {
    id: "structural-relationship",
    version: 1,
    families: ["structural"],
    cost: "low",
    privacy: "public_dom",
    concurrent: true,
    maximumWork: 5_000,
  },
  {
    id: "geometry-hit-test",
    version: 1,
    families: ["structural"],
    cost: "low",
    privacy: "public_dom",
    concurrent: true,
    maximumWork: 5_000,
  },
  {
    id: "visual-icon-ocr-canvas",
    version: 1,
    families: ["visual"],
    cost: "high",
    privacy: "visual",
    concurrent: false,
    maximumWork: 100,
  },
  {
    id: "runtime-behavior",
    version: 1,
    families: ["runtime"],
    cost: "medium",
    privacy: "public_dom",
    concurrent: false,
    maximumWork: 500,
  },
  {
    id: "historical-fingerprint",
    version: 1,
    families: ["historical"],
    cost: "constant",
    privacy: "public_dom",
    concurrent: true,
    maximumWork: 1,
  },
  {
    id: "expected-effect-compatibility",
    version: 1,
    families: ["runtime"],
    cost: "constant",
    privacy: "public_dom",
    concurrent: true,
    maximumWork: 1,
  },
  {
    id: "application-adapter",
    version: 1,
    families: ["runtime"],
    cost: "medium",
    privacy: "protected",
    concurrent: false,
    maximumWork: 10,
  },
] as const);

export type PraxisObservedControl = {
  runtimeId: string;
  fingerprint: string;
  capabilitiesDigest: string;
  evidence: readonly CandidateEvidence[];
};

export type PraxisObservationSnapshot = {
  schemaVersion: 1;
  runtimeVersion: typeof PRAXIS_OBSERVATION_RUNTIME_VERSION;
  pageId: string;
  frameId: string;
  documentEpoch: number;
  scopeDigest: string;
  privacyState: string;
  controls: readonly PraxisObservedControl[];
  providerTimings: readonly PraxisProviderTiming[];
};

type EpochState = { epoch: number };
const epochStates = new WeakMap<Frame, EpochState>();
const initializedPages = new WeakSet<Page>();
const pageIds = new WeakMap<Page, string>();
const frameIds = new WeakMap<Frame, string>();
let pageSequence = 0;
let frameSequence = 0;

function pageId(page: Page) {
  let value = pageIds.get(page);
  if (!value) {
    value = `page-${++pageSequence}`;
    pageIds.set(page, value);
  }
  return value;
}
function frameId(frame: Frame) {
  let value = frameIds.get(frame);
  if (!value) {
    value = `frame-${++frameSequence}`;
    frameIds.set(frame, value);
  }
  return value;
}

export class PraxisDocumentEpoch {
  static async current(page: Page, frame: Frame = page.mainFrame()): Promise<number> {
    let state = epochStates.get(frame);
    if (!state) {
      state = { epoch: 0 };
      epochStates.set(frame, state);
    }
    if (!initializedPages.has(page)) {
      initializedPages.add(page);
      page.on("framenavigated", (changedFrame) => {
        PraxisDocumentEpoch.bump(page, changedFrame);
      });
      page.on("close", () => observationCaches.delete(page));
      await page.addInitScript(epochRuntime).catch(() => undefined);
    }
    if (!page.isClosed() && !frame.isDetached())
      await frame.evaluate(epochRuntime).catch(() => undefined);
    const browserEpoch = await frame
      .evaluate(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        return (
          (globalThis as typeof globalThis & { __scryPraxisEpoch?: number }).__scryPraxisEpoch ?? 0
        );
      })
      .catch(() => state!.epoch);
    state.epoch = Math.max(state.epoch, browserEpoch);
    return state.epoch;
  }

  static bump(page: Page, frame: Frame = page.mainFrame()) {
    const state = epochStates.get(frame) ?? { epoch: 0 };
    state.epoch += 1;
    epochStates.set(frame, state);
    observationCaches.delete(page);
    return state.epoch;
  }

  static async stable(
    page: Page,
    frame: Frame,
    signal: AbortSignal,
    quietMs = 32,
    maximumMs = 180,
  ): Promise<number> {
    const deadline = performance.now() + maximumMs;
    let epoch = await this.current(page, frame);
    while (performance.now() < deadline) {
      await abortableDelay(Math.min(quietMs, deadline - performance.now()), signal);
      const next = await this.current(page, frame);
      if (next === epoch) return next;
      epoch = next;
    }
    return epoch;
  }
}

function epochRuntime() {
  const state = globalThis as typeof globalThis & {
    __scryPraxisEpoch?: number;
    __scryPraxisObserver?: MutationObserver;
  };
  state.__scryPraxisEpoch ??= 0;
  if (state.__scryPraxisObserver || !globalThis.document?.documentElement) return;
  let scheduled = false;
  state.__scryPraxisObserver = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      state.__scryPraxisEpoch = (state.__scryPraxisEpoch ?? 0) + 1;
      scheduled = false;
    });
  });
  state.__scryPraxisObserver.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
}

export class PraxisTargetHandle {
  readonly pageId: string;
  readonly frameId: string;
  readonly documentEpoch: number;
  readonly runtimeVersion = PRAXIS_OBSERVATION_RUNTIME_VERSION;
  #page: Page;
  #frame: Frame;
  #locator: Locator;

  constructor(page: Page, frame: Frame, locator: Locator, documentEpoch: number) {
    this.#page = page;
    this.#frame = frame;
    this.#locator = locator;
    this.pageId = pageId(page);
    this.frameId = frameId(frame);
    this.documentEpoch = documentEpoch;
  }

  async use<T>(work: (locator: Locator) => Promise<T>): Promise<T> {
    await this.assertCurrent();
    return work(this.#locator);
  }

  async reconcile<T>(work: (locator: Locator) => Promise<T>): Promise<T> {
    if (this.#page.isClosed() || this.#frame.isDetached()) throw new PraxisStaleTargetError();
    return work(this.#locator);
  }

  async assertCurrent() {
    if (
      this.#page.isClosed() ||
      this.#frame.isDetached() ||
      (await PraxisDocumentEpoch.current(this.#page, this.#frame)) !== this.documentEpoch
    )
      throw new PraxisStaleTargetError();
  }

  async readAfterDispatch<T>(work: (locator: Locator) => Promise<T>): Promise<T> {
    if (this.#page.isClosed()) throw new PraxisStaleTargetError();
    return work(this.#locator);
  }

  page(): Page {
    return this.#page;
  }
  toJSON() {
    return {
      pageId: this.pageId,
      frameId: this.frameId,
      documentEpoch: this.documentEpoch,
      runtimeVersion: this.runtimeVersion,
    };
  }
}

export class PraxisStaleTargetError extends Error {
  constructor() {
    super("PRAXIS_TARGET_CHANGED_BEFORE_ACTION");
    this.name = "PraxisStaleTargetError";
  }
}

type CacheEntry = { key: string; snapshot: PraxisObservationSnapshot };
const observationCaches = new WeakMap<Page, Map<string, CacheEntry>>();
const MAX_CACHE_ENTRIES = 32;

export class PraxisObservationCache {
  static get(page: Page, key: string, epoch: number) {
    const entry = observationCaches.get(page)?.get(key);
    return entry?.snapshot.documentEpoch === epoch ? entry.snapshot : undefined;
  }
  static set(page: Page, key: string, snapshot: PraxisObservationSnapshot) {
    let cache = observationCaches.get(page);
    if (!cache) {
      cache = new Map();
      observationCaches.set(page, cache);
    }
    cache.set(key, { key, snapshot });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  static key(input: {
    scope: unknown;
    privacyState: string;
    providers: readonly string[];
    epoch: number;
    scoringPolicyVersion?: number;
    adapterVersion?: string;
    viewport?: { width: number; height: number } | null;
  }) {
    return createHash("sha256").update(stable(input)).digest("hex");
  }
}

export type PraxisGroundingScore = {
  families: Partial<Record<EvidenceFamily, number>>;
  familyCount: number;
  total: number;
};
export const PraxisGroundingPolicyV1 = Object.freeze({
  version: PRAXIS_GROUNDING_POLICY_VERSION,
  candidateLimit: 5_000,
  strongFamilyThreshold: 0.55,
  highRiskMinimum: 0.76,
  ordinaryMinimum: 0.58,
  highRiskMargin: 0.14,
  ordinaryMargin: 0.08,
  highRiskFamilyCount: 3,
  ordinaryFamilyCount: 2,
  readOnlyFamilyCount: 1,
  score(evidence: readonly CandidateEvidence[]): PraxisGroundingScore {
    const groups = new Map<string, CandidateEvidence>();
    for (const item of evidence) {
      const current = groups.get(item.correlationGroup);
      if (!current || item.score > current.score) groups.set(item.correlationGroup, item);
    }
    const families: Partial<Record<EvidenceFamily, number>> = {};
    for (const item of [...groups.values()].sort((a, b) =>
      a.correlationGroup.localeCompare(b.correlationGroup),
    ))
      families[item.family] = Math.max(families[item.family] ?? 0, item.score);
    const scores = Object.values(families);
    const familyCount = scores.filter((value) => value >= 0.55).length;
    const total = scores.length
      ? Math.min(
          1,
          scores.reduce((sum, value) => sum + value, 0) / Math.max(2, scores.length) +
            Math.min(0.12, familyCount * 0.03),
        )
      : 0;
    return { families, familyCount, total };
  },
});

export async function runEvidenceProviders<T>(
  providers: readonly PraxisEvidenceProvider<T>[],
  context: T,
  allowedChannels: readonly string[],
  signal: AbortSignal,
) {
  const execute = async (provider: PraxisEvidenceProvider<T>) => {
    if (!allowedChannels.includes(provider.privacy))
      return {
        provider,
        evidence: [] as readonly CandidateEvidence[],
        timing: { provider: provider.id, durationMs: 0, outcome: "forbidden" as const },
      };
    const started = performance.now();
    try {
      const evidence = provider.sanitize(await provider.observe(context, signal));
      return {
        provider,
        evidence,
        timing: {
          provider: provider.id,
          durationMs: performance.now() - started,
          outcome: "succeeded" as const,
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        provider,
        evidence: [] as readonly CandidateEvidence[],
        timing: {
          provider: provider.id,
          durationMs: performance.now() - started,
          outcome: "failed" as const,
        },
      };
    }
  };
  const concurrent = providers.filter((provider) => provider.concurrent);
  const serial = providers.filter((provider) => !provider.concurrent);
  const results = await Promise.all(concurrent.map(execute));
  for (const provider of serial) results.push(await execute(provider));
  return results;
}

export function observationIdentity(
  page: Page,
  scope: unknown,
  privacyState: string,
  epoch: number,
  frame: Frame = page.mainFrame(),
): Omit<PraxisObservationSnapshot, "controls" | "providerTimings"> {
  return {
    schemaVersion: 1,
    runtimeVersion: PRAXIS_OBSERVATION_RUNTIME_VERSION,
    pageId: pageId(page),
    frameId: frameId(frame),
    documentEpoch: epoch,
    scopeDigest: createHash("sha256").update(stable(scope)).digest("hex"),
    privacyState,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
