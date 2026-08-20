import { createHash } from "node:crypto";

import type { ExecutionPolicy } from "@scry/contracts";
import {
  capturePraxisSessionStorage,
  capturePraxisStorageState,
  observeSemanticPageContext,
} from "@scry/praxis";
import type { BrowserContext, Page } from "playwright";

import type { ExecuteOptions } from "./types.js";

export type SuccessorCheckpointPayload = Parameters<
  NonNullable<ExecuteOptions["captureSuccessorCheckpoint"]>
>[0];

export async function captureSuccessorCheckpointPayload(
  context: BrowserContext,
  page: Page,
  policy: ExecutionPolicy,
): Promise<SuccessorCheckpointPayload> {
  const [storageState, sessionEntries, semantic] = await Promise.all([
    capturePraxisStorageState(context, { indexedDB: true }),
    capturePraxisSessionStorage(page),
    observeSemanticPageContext(page),
  ]);

  const restorationUrl = page.url();
  const restorationOrigin = new URL(restorationUrl).origin;

  if (!policy.allowedOrigins.includes(restorationOrigin)) {
    throw new Error("SUCCESSOR_CHECKPOINT_ORIGIN_NOT_ALLOWED");
  }

  const admittedOrigins = new Set(policy.allowedOrigins);
  const admittedHosts = new Set(policy.allowedOrigins.map((origin) => new URL(origin).hostname));

  storageState.origins = storageState.origins.filter((entry) => admittedOrigins.has(entry.origin));

  storageState.cookies = storageState.cookies.filter((cookie) => {
    const cookieDomain = cookie.domain.replace(/^\./, "");

    return [...admittedHosts].some(
      (host) => host === cookieDomain || host.endsWith(`.${cookieDomain}`),
    );
  });

  const sessionBytes = sessionEntries.reduce(
    (total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value),
    0,
  );

  if (sessionEntries.length > 512 || sessionBytes > 512 * 1024) {
    throw new Error("SUCCESSOR_CHECKPOINT_SESSION_STORAGE_TOO_LARGE");
  }

  if (Buffer.byteLength(JSON.stringify(storageState)) > 2 * 1024 * 1024) {
    throw new Error("SUCCESSOR_CHECKPOINT_STORAGE_STATE_TOO_LARGE");
  }

  return {
    schemaVersion: 1,
    policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    storageState,
    sessionStorage: {
      origin: restorationOrigin,
      entries: sessionEntries,
    },
    restorationUrl,
    safeSemanticContext: {
      title: semantic.authority.title,
      controls: semantic.controls.slice(0, 24).map(({ role, name }) => ({ role, name })),
    },
  };
}
