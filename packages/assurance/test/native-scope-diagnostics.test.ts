import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { PraxisMcpBrowserEngine } from "@scry/praxis";
import { VeilBrowserProtection } from "@scry/veil";
import type { PraxisCommandsPort, PraxisEffectsPort, ChronicleEvidencePort } from "@scry/contracts";

it.each([
  ["MÜnchen-472819", "MÜnchen-472819"],
  ["München", "München"],
  ["MÜnchen-472819", encodeURIComponent("MÜnchen-472819")],
  ["Ｓｅｃｒｅｔ", "Ｓｅｃｒｅｔ"],
  ["Mu\u0308nchen-472819", "Mu\u0308nchen-472819"],
  ["OpaqueΣ", "OpaqueΣ"],
  ["\u0308Opaque472819", "\u0308Opaque472819", "prefixu"],
  ["\u0301AbCd472819", encodeURIComponent("\u0301AbCd472819"), "prefixe"],
  ["\u0300Opaque472819", "\u0300Opaque472819", "prefixu\u0315"],
  ["Opaque472819u\u0315", "Opaque472819u\u0315", "prefix-", "\u0300-suffix"],
  ["\u1161Opaque472819", "\u1161Opaque472819", "prefix\u1100"],
  ["\u0300\u0315", "\u0300\u0315", "prefixu\u031a"],
])(
  "keeps embedded canonical IDNA secret %s out of real collector and durable native receipts",
  async (secret, source, prefix = "prefix-", suffix = "-suffix") => {
    const values = { credential: secret };
    const hostname = new URL(`https://${prefix}${source}${suffix}.example`).hostname;
    const commands = {
      protectedValuesForSession: vi.fn(async () => values),
    } as unknown as PraxisCommandsPort;
    const engine = new PraxisMcpBrowserEngine(
      commands,
      {} as PraxisEffectsPort,
      {} as ChronicleEvidencePort,
      new VeilBrowserProtection(),
      "unused",
    );
    const c = (engine as unknown as { cell(id: string): any }).cell("idna-composition");
    c.scope = { baseOrigin: "https://fixture.example" };
    c.opening = Promise.resolve();
    c.lease = { assertActive() {}, checkpoint: async () => {} };
    c.policyDigest = createHash("sha256").update(JSON.stringify(values)).digest("hex");
    c.custody = { synchronize: async () => {} };
    c.worker = {
      call: vi.fn(async (message: any) => {
        if (message.tool !== "browser_snapshot") {
          c.denials.record({ origin: `https://${hostname}`, reason: "origin_not_allowed" });
          c.denials.record({ origin: `tunnel://${hostname}:443`, reason: "origin_not_allowed" });
        }
        return { isError: false, diagnosticDetailAllowed: true, content: [] };
      }),
    };
    const durable: Array<Record<string, any>> = [];
    const result = await engine.execute(
      c.id,
      { kind: "browser_tool", tool: "browser_click", args: { target: "#save" } },
      {
        remainingMs: 5000,
        persistAction: async (receipt) => {
          durable.push(JSON.parse(JSON.stringify(receipt)));
        },
      },
    );
    expect(result).toMatchObject({
      execution: "completed",
      businessOutcome: "unverified",
      scopeDiagnostics: {
        current: {
          denialCount: 2,
          detailUnavailableCount: 2,
          unavailableReasons: ["display_redacted"],
          endpoints: [],
        },
      },
    });
    expect(result).toEqual(durable.at(-1));
    expect(c.denials.snapshot().endpoints).toEqual([]);
    const json = JSON.stringify(durable);
    for (const unsafe of [hostname, secret, secret.toLowerCase(), source])
      expect(json).not.toContain(unsafe);
    c.denials.record({ origin: "https://public.example", reason: "origin_not_allowed" });
    c.denials.record({ origin: "tunnel://public.example:443", reason: "origin_not_allowed" });
    expect(c.denials.snapshot().endpoints).toEqual([
      { transport: "http_origin", endpoint: "https://public.example", count: 1 },
      { transport: "connect_endpoint", endpoint: "public.example:443", count: 1 },
    ]);
    c.denials.dispose();
  },
);
