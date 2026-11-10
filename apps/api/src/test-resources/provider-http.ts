import { HttpException } from "@nestjs/common";
import type { Database } from "../infrastructure/database.js";
import { AsyncLocalStorage } from "node:async_hooks";

type Budget = {
  deadline: number;
  requests: number;
  scheduleWaitMs: number;
  pollingWaitMs: number;
  throttled: boolean;
  partialRefresh: boolean;
};
const budgets = new AsyncLocalStorage<Budget>();
export const withProviderBudget = <T>(work: () => Promise<T>, milliseconds = 45000) => {
  const parent = budgets.getStore();
  return budgets.run(
    {
      deadline: Math.min(parent?.deadline ?? Infinity, Date.now() + milliseconds),
      requests: 0,
      scheduleWaitMs: 0,
      pollingWaitMs: 0,
      throttled: false,
      partialRefresh: false,
    },
    work,
  );
};
export const providerTiming = () => {
  const state = budgets.getStore();
  return {
    providerRequests: state?.requests ?? 0,
    scheduleWaitMs: state?.scheduleWaitMs ?? 0,
    pollingWaitMs: state?.pollingWaitMs ?? 0,
    throttled: state?.throttled ?? false,
    partialRefresh: state?.partialRefresh ?? false,
  };
};
export const notePartialRefresh = () => {
  const state = budgets.getStore();
  if (state) state.partialRefresh = true;
};
export const providerDatabaseBudget = () =>
  Math.max(1, Math.min(2000, (budgets.getStore()?.deadline ?? Date.now() + 2000) - Date.now()));
export async function providerPause(milliseconds: number, kind: "schedule" | "polling") {
  const budget = budgets.getStore();
  const duration = Math.max(0, Math.min(milliseconds, (budget?.deadline ?? Infinity) - Date.now()));
  const start = Date.now();
  if (duration) await new Promise((resolve) => setTimeout(resolve, duration));
  if (budget)
    budget[kind === "schedule" ? "scheduleWaitMs" : "pollingWaitMs"] += Date.now() - start;
}
export class ProviderDeferred extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly reason: "rate_limit" | "unavailable" = "rate_limit",
  ) {
    super("Provider work is waiting");
  }
}

export function resourceError(code: string, status = 503): never {
  throw new HttpException({ code, status, message: code }, status);
}
export class ProviderHttp {
  constructor(
    private readonly database: Database,
    private readonly provider: "mail_tm" | "hookdeck",
    private readonly base: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request(path: string, options: RequestInit = {}, acceptable: number[] = []) {
    // Fixed provider origins only. Never follow a provider response URL with an
    // Authorization header, including redirects to a different origin.
    if (!path.startsWith("/") || path.startsWith("//"))
      resourceError("TEST_PROVIDER_PATH_INVALID", 400);
    const budget = budgets.getStore();
    const deadline = (budget?.deadline ?? Date.now() + 15000) - 500;
    for (;;) {
      // One shared database-backed schedule for every API replica and customer.
      // Admit at dispatch time, never reserve future slots. Every sleeper must
      // recheck the shared cooldown, including one installed by another replica.
      // An abandoned request cannot inflate the queue. 5/sec leaves headroom.
      if (deadline - Date.now() < 100) throw new ProviderDeferred(1, "unavailable");
      const slot = await this.database
        .boundedTransaction(
          async (c) => {
            await c.query(
              "INSERT INTO test_provider_limits(provider) VALUES($1) ON CONFLICT DO NOTHING",
              [this.provider],
            );
            await c.query(
              "SELECT provider FROM test_provider_limits WHERE provider=$1 FOR UPDATE",
              [this.provider],
            );
            const row = await c.query<{ delay: number }>(
              `SELECT greatest(0,extract(epoch FROM (greatest(next_request_at,blocked_until)-clock_timestamp()))*1000) AS delay FROM test_provider_limits WHERE provider=$1`,
              [this.provider],
            );
            const delay = Number(row.rows[0]!.delay);
            const reserved = delay <= 0 && deadline - Date.now() > 1000;
            if (reserved)
              await c.query(
                "UPDATE test_provider_limits SET next_request_at=clock_timestamp()+interval '200 milliseconds' WHERE provider=$1",
                [this.provider],
              );
            return { delay, reserved };
          },
          Math.max(1, Math.min(2000, deadline - Date.now())),
        )
        .catch(() => {
          throw new ProviderDeferred(2, "unavailable");
        });
      if (!slot.reserved) {
        if (Date.now() + Math.max(200, slot.delay) + 1000 >= deadline)
          throw new ProviderDeferred(Math.max(1, Math.ceil(slot.delay / 1000)));
        await providerPause(Math.min(1000, Math.max(10, slot.delay)), "schedule");
        continue;
      }
      // Own the wall-clock wait as well as the transport signal. A delayed or
      // non-cooperative fetch/body must not strand this read after its budget.
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, Math.min(8000, deadline - Date.now())),
      );
      let onAbort!: () => void;
      const expired = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ProviderDeferred(2, "unavailable"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const within = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, expired]);
      try {
        if (signal.aborted) throw new ProviderDeferred(2, "unavailable");
        if (budget) budget.requests++;
        const pending = this.fetcher(this.base + path, {
          ...options,
          redirect: "error",
          signal,
          headers: {
            accept: this.provider === "mail_tm" ? "application/ld+json" : "application/json",
            "content-type": "application/json",
            ...options.headers,
          },
        });
        void pending
          .then((response) => {
            if (signal.aborted) void response.body?.cancel().catch(() => {});
          })
          .catch(() => {});
        const response = await within(pending);
        if (response.status === 429) {
          if (budget) budget.throttled = true;
          const raw = response.headers.get("retry-after") ?? "";
          const seconds = /^\d+$/.test(raw)
            ? Number(raw)
            : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
          await this.database.boundedTransaction(
            (c) =>
              c.query(
                `UPDATE test_provider_limits SET blocked_until=greatest(blocked_until,now()+($2::int*interval '1 second')) WHERE provider=$1`,
                [
                  this.provider,
                  Math.max(1, Number.isSafeInteger(seconds) ? Math.min(86400, seconds) : 30),
                ],
              ),
            Math.max(1, Math.min(2000, deadline - Date.now())),
          );
          if (response.body) await within(response.body.cancel());
          // Re-enter the SAME shared queue, with no automatic app-action replay.
          // If the callback budget expires, the caller receives normal waiting.
          continue;
        }
        if (!response.ok && !acceptable.includes(response.status)) {
          if (response.body) await within(response.body.cancel());
          if (response.status === 402) resourceError("TEST_PROVIDER_QUOTA_UNAVAILABLE");
          if (response.status === 401 || response.status === 403)
            resourceError("TEST_PROVIDER_AUTH_REQUIRED");
          throw new ProviderDeferred(30, "unavailable");
        }
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        const reader = response.body?.getReader();
        if (reader)
          try {
            while (true) {
              const part = await within(reader.read());
              if (part.done) break;
              bytes += part.value.length;
              if (bytes > 512 * 1024) resourceError("TEST_MESSAGE_TOO_LARGE", 413);
              chunks.push(part.value);
            }
          } finally {
            await within(reader.cancel()).catch(() => {});
          }
        const text = Buffer.concat(chunks).toString("utf8");
        return { status: response.status, data: text ? JSON.parse(text) : {} };
      } catch (error) {
        if (error instanceof HttpException || error instanceof ProviderDeferred) throw error;
        // Provider errors may contain passwords, tokens or message contents.
        throw new ProviderDeferred(30, "unavailable");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}
