import type { OperationOutcome } from "@scry/contracts";
import type { BrowserContext, CDPSession, Page } from "playwright";

import { openPraxisCdpSession } from "./browser-session.js";

const RECENT_REQUEST_LIMIT = 12;
const RECENT_FAILURE_LIMIT = 6;

type SemanticPageContext = NonNullable<OperationOutcome["semanticPageContext"]>;

export type PraxisReadOnlyCdpSensorSnapshot = NonNullable<SemanticPageContext["browserSensor"]>;

type RequestFact = PraxisReadOnlyCdpSensorSnapshot["network"]["recentRequests"][number];

type FailureFact = PraxisReadOnlyCdpSensorSnapshot["network"]["recentFailures"][number];

export type PraxisReadOnlyCdpSensor = {
  snapshot(): Promise<PraxisReadOnlyCdpSensorSnapshot>;
  close(): Promise<void>;
};

const sensorsByContext = new WeakMap<
  BrowserContext,
  Map<Page, Promise<PraxisReadOnlyCdpSensor | undefined>>
>();

function pushBounded<T>(values: T[], value: T, limit: number): void {
  values.push(value);

  if (values.length > limit) {
    values.splice(0, values.length - limit);
  }
}

function safeFailureReason(errorText: string): string {
  const normalized = errorText.trim().toUpperCase();

  return /^NET::[A-Z0-9_]+$/.test(normalized) ? normalized : "NETWORK_FAILURE";
}

export async function createPraxisReadOnlyCdpSensor(
  context: BrowserContext,
  page: Page,
): Promise<PraxisReadOnlyCdpSensor> {
  const cdp = await openPraxisCdpSession(context, page);

  const requests: RequestFact[] = [];
  const failures: FailureFact[] = [];

  let observedRequests = 0;
  let observedFailures = 0;
  let loaderTransitionsObserved = 0;
  let lastLifecycleLoaderId: string | undefined;
  let lastSnapshotLoaderId: string | undefined;
  let closed = false;

  cdp.on("Network.requestWillBeSent", (event) => {
    observedRequests += 1;

    pushBounded(
      requests,
      {
        requestId: event.requestId,
        ...(event.loaderId ? { loaderId: event.loaderId } : {}),
        ...(event.frameId ? { frameId: event.frameId } : {}),
        ...(event.type ? { type: event.type } : {}),
        monotonicTimestamp: event.timestamp,
      },
      RECENT_REQUEST_LIMIT,
    );
  });

  cdp.on("Network.loadingFailed", (event) => {
    observedFailures += 1;

    pushBounded(
      failures,
      {
        requestId: event.requestId,
        ...(event.type ? { type: event.type } : {}),
        monotonicTimestamp: event.timestamp,
        reasonCode: safeFailureReason(event.errorText),
        canceled: event.canceled ?? false,
        ...(event.blockedReason ? { blockedReason: event.blockedReason } : {}),
      },
      RECENT_FAILURE_LIMIT,
    );
  });

  cdp.on("Page.lifecycleEvent", (event) => {
    if (!event.loaderId) return;

    if (lastLifecycleLoaderId !== undefined && lastLifecycleLoaderId !== event.loaderId) {
      loaderTransitionsObserved += 1;
    }

    lastLifecycleLoaderId = event.loaderId;
  });

  try {
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.setLifecycleEventsEnabled", {
      enabled: true,
    });
  } catch (error) {
    await cdp.detach().catch(() => undefined);
    throw error;
  }

  return {
    async snapshot() {
      if (closed) {
        throw new Error("PRAXIS_READ_ONLY_CDP_SENSOR_CLOSED");
      }

      const [frameTree, layout] = await Promise.all([
        cdp.send("Page.getFrameTree"),
        cdp.send("Page.getLayoutMetrics"),
      ]);

      const frame = frameTree.frameTree.frame;
      const viewport = layout.cssLayoutViewport ?? layout.layoutViewport;

      const previousLoaderId = lastSnapshotLoaderId;
      const loaderChanged = previousLoaderId !== undefined && previousLoaderId !== frame.loaderId;

      lastSnapshotLoaderId = frame.loaderId;

      return {
        kind: "chromium_read_only",
        authority: {
          frameId: frame.id,
          loaderId: frame.loaderId,
          ...(previousLoaderId ? { previousLoaderId } : {}),
          loaderChanged,
          loaderTransitionsObserved,
        },
        network: {
          observedRequests,
          recentRequests: requests.map((request) => ({
            ...request,
          })),
          observedFailures,
          recentFailures: failures.map((failure) => ({
            ...failure,
          })),
          truncated: observedRequests > requests.length || observedFailures > failures.length,
        },
        layout: {
          clientWidth: viewport.clientWidth,
          clientHeight: viewport.clientHeight,
        },
      };
    },

    async close() {
      if (closed) return;

      closed = true;
      await cdp.detach().catch(() => undefined);
    },
  };
}

async function sensorFor(
  context: BrowserContext,
  page: Page,
): Promise<PraxisReadOnlyCdpSensor | undefined> {
  let pageSensors = sensorsByContext.get(context);

  if (!pageSensors) {
    pageSensors = new Map();
    sensorsByContext.set(context, pageSensors);
  }

  let sensor = pageSensors.get(page);

  if (!sensor) {
    sensor = createPraxisReadOnlyCdpSensor(context, page).catch(() => undefined);

    pageSensors.set(page, sensor);
  }

  return sensor;
}

export async function enrichPraxisSemanticPageContextWithReadOnlyCdp(
  context: BrowserContext,
  page: Page,
  semanticPageContext: SemanticPageContext,
): Promise<SemanticPageContext> {
  const sensor = await sensorFor(context, page);

  if (!sensor) {
    return semanticPageContext;
  }

  const browserSensor = await sensor.snapshot().catch(() => undefined);

  return browserSensor
    ? {
        ...semanticPageContext,
        browserSensor,
      }
    : semanticPageContext;
}

export async function closePraxisReadOnlyCdpSensors(context: BrowserContext): Promise<void> {
  const pageSensors = sensorsByContext.get(context);

  if (!pageSensors) return;

  sensorsByContext.delete(context);

  await Promise.all(
    [...pageSensors.values()].map(async (pending) => {
      const sensor = await pending;

      if (sensor) {
        await sensor.close().catch(() => undefined);
      }
    }),
  );
}
