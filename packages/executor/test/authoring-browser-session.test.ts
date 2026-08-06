import { createServer, type Server } from "node:http";

import { executionPolicySchema } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthoringBrowserSession } from "../src/authoring-browser-session.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`
      <main>
        <h1>${request.url === "/second" ? "Second page" : "First page"}</h1>
        <a href="/second">Continue</a>
      </main>
    `);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("authoring fixture unavailable");
  }

  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("persistent authoring browser session", () => {
  it("keeps one Veil-authorized page alive across multiple authoring observations", async () => {
    const session = await createAuthoringBrowserSession({
      sessionId: "11111111-1111-4111-8111-111111111111",
      environmentId: "authoring-test-environment",
      veilAdmissionKey: "authoring-test-only-veil-admission-key-32-bytes",
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      policy: executionPolicySchema.parse({
        allowedOrigins: [origin],
        allowPrivateNetwork: true,
      }),
    });

    try {
      expect(session.state()).toBe("active");
      expect(session.documentEpoch()).toBe(0);

      await session.page.goto(origin, { waitUntil: "domcontentloaded" });
      await session.observeDocument();

      expect(session.documentEpoch()).toBe(1);
      expect(await session.page.getByRole("heading").textContent()).toBe("First page");

      await session.observeDocument();
      expect(session.documentEpoch()).toBe(1);

      await session.page.getByRole("link", { name: "Continue" }).click();
      await session.page.waitForLoadState("domcontentloaded");
      await session.observeDocument();

      expect(session.documentEpoch()).toBe(2);
      expect(await session.page.getByRole("heading").textContent()).toBe("Second page");
      expect(session.page.url()).toBe(`${origin}/second`);
    } finally {
      await session.close();
    }

    expect(session.state()).toBe("released");
  }, 20_000);
});
