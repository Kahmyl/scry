import { describe, expect, it } from "vitest";

import { classifyPassivePreparationRequest } from "../src/protected-preparation-effects.js";

describe("protected preparation passive effect policy", () => {
  const classify = (url: string, method = "POST") => classifyPassivePreparationRequest({
    method,
    url: new URL(url),
    allowedOrigins: ["https://app.example.test"],
  });

  it("classifies only bounded Cloudflare, Sentry, and Stripe passive endpoints", () => {
    expect(classify("https://app.example.test/cdn-cgi/rum")).toBe("telemetry");
    expect(classify("https://o123.ingest.us.sentry.io/api/456/envelope/")).toBe("telemetry");
    expect(classify("https://m.stripe.com/6")).toBe("platform");
    expect(classify("https://r.stripe.com/b")).toBe("platform");
  });

  it("keeps business mutations and lookalike endpoints blocked", () => {
    expect(classify("https://app.example.test/api/orders")).toBeUndefined();
    expect(classify("https://attacker.test/cdn-cgi/rum")).toBeUndefined();
    expect(classify("https://m.stripe.com/v1/payment_intents")).toBeUndefined();
    expect(classify("https://o123.ingest.us.sentry.io/api/456/envelope/", "PUT")).toBeUndefined();
  });
});
