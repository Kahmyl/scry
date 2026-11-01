import { HttpException } from "@nestjs/common";
import type { Database } from "../infrastructure/database.js";
import { AsyncLocalStorage } from "node:async_hooks";

const budgets = new AsyncLocalStorage<number>();
export const withProviderBudget = <T>(work: () => Promise<T>, milliseconds = 45000) =>
  budgets.run(Date.now() + milliseconds, work);
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
    const deadline = budgets.getStore() ?? Date.now() + 15000;
    for (;;) {
      // One shared database-backed schedule for every API replica and customer.
      // Admit at dispatch time, never reserve future slots. Every sleeper must
      // recheck the shared cooldown, including one installed by another replica.
      // An abandoned request cannot inflate the queue. 5/sec leaves headroom.
      const slot = await this.database.transaction(async (c) => {
        await c.query(
          "INSERT INTO test_provider_limits(provider) VALUES($1) ON CONFLICT DO NOTHING",
          [this.provider],
        );
        await c.query("SELECT provider FROM test_provider_limits WHERE provider=$1 FOR UPDATE", [
          this.provider,
        ]);
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
      });
      if (!slot.reserved) {
        if (Date.now() + Math.max(200, slot.delay) + 1000 >= deadline)
          throw new ProviderDeferred(Math.max(1, Math.ceil(slot.delay / 1000)));
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, Math.max(10, slot.delay))),
        );
        continue;
      }
      try {
        const response = await this.fetcher(this.base + path, {
          ...options,
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - Date.now()))),
            ...(options.signal ? [options.signal] : []),
          ]),
          headers: {
            accept: this.provider === "mail_tm" ? "application/ld+json" : "application/json",
            "content-type": "application/json",
            ...options.headers,
          },
        });
        if (response.status === 429) {
          const raw = response.headers.get("retry-after") ?? "";
          const seconds = /^\d+$/.test(raw)
            ? Number(raw)
            : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
          await this.database.query(
            `UPDATE test_provider_limits SET blocked_until=greatest(blocked_until,now()+($2::int*interval '1 second')) WHERE provider=$1`,
            [
              this.provider,
              Math.max(1, Number.isSafeInteger(seconds) && seconds <= 2147483647 ? seconds : 30),
            ],
          );
          await response.body?.cancel();
          // Re-enter the SAME shared queue, with no automatic app-action replay.
          // If the callback budget expires, the caller receives normal waiting.
          continue;
        }
        if (!response.ok && !acceptable.includes(response.status)) {
          await response.body?.cancel();
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
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.length;
              if (bytes > 512 * 1024) resourceError("TEST_MESSAGE_TOO_LARGE", 413);
              chunks.push(part.value);
            }
          } finally {
            await reader.cancel();
          }
        const text = Buffer.concat(chunks).toString("utf8");
        return { status: response.status, data: text ? JSON.parse(text) : {} };
      } catch (error) {
        if (error instanceof HttpException || error instanceof ProviderDeferred) throw error;
        // Provider errors may contain passwords, tokens or message contents.
        throw new ProviderDeferred(30, "unavailable");
      }
    }
  }
}
