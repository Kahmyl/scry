import { beforeAll, afterAll, it, expect } from "./node-browser-harness.js";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  PraxisMcpBrowserEngine,
  AdapterWorker,
} from "../../../../../packages/praxis/src/mcp-browser-engine.js";
import { PraxisOwnerLease } from "../../../../../packages/praxis/src/owner-lease.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const require = createRequire(path.join(root, "apps/web/node_modules/vite/package.json"));

const native = createRequire(path.join(root, "packages/praxis/package.json"))(
  "playwright-mcp-runtime",
);
const receipts: any[] = [];
let server: any,
  browserServer: any,
  origin: string,
  bundle: string,
  effects = 0;
let traces: any[] = [];
let changes = 0;
let changedValues: string[] = [];
let killOnEffect: any;
beforeAll(async () => {
  bundle = await readFile(
    new URL(
      "../../../../../artifacts/assurance/native-action-recovery/application.bundle",
      import.meta.url,
    ),
    "utf8",
  );
  server = createServer((req, res) => {
    if (req.url?.startsWith("/change")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        changes++;
        changedValues.push(body);
        res.end("saved");
      });
      return;
    }
    if (req.url?.startsWith("/trace")) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        traces.push(...JSON.parse(b));
        res.end("ok");
      });
      return;
    }
    if (req.url?.startsWith("/effect")) {
      effects++;
      killOnEffect?.kill("SIGKILL");
      res.end("accepted");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end('<html><body><div id="root"></div><script>' + bundle + "</script></body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
  browserServer = await native.chromium.launchServer({
    headless: false,
    channel: "chromium",
    env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99" },
  });
});
afterAll(async () => {
  await browserServer?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await writeFile(
    new URL(
      "../../../../../artifacts/assurance/native-action-recovery/results.json",
      import.meta.url,
    ),
    JSON.stringify(
      process.env.INCIDENT_CASES
        ? [
            ...JSON.parse(
              await readFile(
                new URL(
                  "../../../../../artifacts/assurance/native-action-recovery/results.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            ).filter((r: { mode: string }) => !receipts.some((n) => n.mode === r.mode)),
            ...receipts,
          ]
        : receipts,
      null,
      2,
    ) + "\n",
  );
});

const cases = [
  ["stable", true],
  ["controlled-no-validation", true],
  ["remove-describedby", false],
  ["referenced-error", false],
  ["replace-input", false],
  ["replace-button", false],
  ["rename-button", false],
  ["unseen-control", false],
  ["unrelated-status", true],
  ["nested-dialog", true],
  ["post-click-reply-lost", false],
  ["native-change", true],
  ["repeated-input", true],
  ["controlled-text", true],
  ["controlled-number", true],
  ["type-change-restored", false],
  ["transient-button", false],
  ["submission-change", false],
  ["worker-killed-after-effect", false],
] as const;
const selectedCases = process.env.INCIDENT_CASES;
it.each(selectedCases ? cases.filter((c) => selectedCases.split(",").includes(c[0])) : cases)(
  "real React + actual adapter sequence: %s",
  async (mode, expectedComplete) => {
    const directory = await mkdtemp(path.join(tmpdir(), "scry-incident-browser-"));
    const worker = new AdapterWorker(
      directory,
      new URL("./worker.ts", import.meta.url).href,
      () => {},
      () => {},
      async () => {},
    );
    const actualCall = worker.call.bind(worker);
    const phases: string[] = [];
    worker.child.on("message", (m: any) => {
      if (m.type === "phase" && typeof m.phase === "string") phases.push(m.phase);
    });
    const engine = new PraxisMcpBrowserEngine(
      { protectedValuesForSession: async () => ({}) } as any,
      { assertOwner: async () => {} } as any,
      {} as any,
      {} as any,
      "unused",
    );
    const c = (engine as any).cell("isolated-" + mode);
    c.scope = { baseOrigin: origin, allowedFirstPartyOrigins: [origin] };
    c.opening = Promise.resolve();
    c.lease = new PraxisOwnerLease(
      { sessionId: c.id, generation: 1, leaseToken: "fictional" },
      { assertOwner: async () => {} } as any,
      { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
    );
    c.policyDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    c.custody = { synchronize: async () => {}, terminate: async () => {}, close: async () => {} };
    c.worker = worker;
    const saved: any[] = [];
    const before = effects,
      previousChanges = changes;
    traces = [];
    killOnEffect = mode === "worker-killed-after-effect" ? worker.child : undefined;
    try {
      await actualCall({
        type: "init",
        endpoint: browserServer.wsEndpoint(),
        display: process.env.DISPLAY ?? ":99",
        secrets: {},
        output: directory,
      });
      await actualCall({
        type: "call",
        tool: "browser_navigate",
        args: { url: origin + "/?mode=" + mode },
      });
      const snapshot: any = await actualCall({ type: "call", tool: "browser_snapshot", args: {} });
      const text = snapshot.content
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join("\n");
      const price = /(?:textbox|spinbutton) "Canada price"[^\n]*\[ref=([^\]]+)\]/.exec(text)?.[1];
      const button = /button "Select products"[^\n]*\[ref=([^\]]+)\]/.exec(text)?.[1];
      expect(price).toBeTruthy();
      expect(button).toBeTruthy();
      expect(snapshot.observationId).toBeTruthy();
      if (mode === "post-click-reply-lost")
        worker.call = async (message: any, ...rest: any[]) => {
          const r = await (actualCall as any)(message, ...rest);
          if (message.type === "plan_step" && message.index === 1)
            throw Error("SCRY_BROWSER_ADAPTER_TIMEOUT");
          return r;
        };
      const input = {
        kind: "browser_tool" as const,
        tool: "browser_sequence",
        args: {
          planId: "isolated-" + mode,
          observationId: snapshot.observationId,
          steps: [
            {
              tool: "browser_type",
              actionId: "correct-price",
              args: { target: price, text: "365.00" },
            },
            ...(mode === "repeated-input"
              ? [
                  {
                    tool: "browser_type",
                    actionId: "second-price",
                    args: { target: price, text: "366.00" },
                  },
                ]
              : []),
            { tool: "browser_click", actionId: "stage-products", args: { target: button } },
          ],
        },
      };
      let result: any, error: string | undefined;
      try {
        result = await engine.execute(c.id, input as any, {
          remainingMs: 15000,
          persistAction: async (r: any) => {
            saved.push(structuredClone(r));
          },
        });
      } catch (e: any) {
        error = e.message;
      }
      await new Promise((r) => setTimeout(r, 30));
      const actualEffects = effects - before;
      const record = {
        phases,
        mutations: traces,
        changes: changes - previousChanges,
        changedValue: changedValues.at(-1),
        snapshotRecoveryAvailable: undefined as true | undefined,
        mode,
        complete: result?.complete === true,
        error: error ?? null,
        execution: (result ?? saved.at(-1))?.execution,
        steps: (result ?? saved.at(-1))?.receipts?.map((r: any) => r.execution),
        effects: actualEffects,
        upstreamClicks: phases.filter((p) => p === "upstream:browser_click").length,
        lastReason: saved.at(-1)?.reason ?? null,
      };
      record["phases"] = phases;
      record["mutations"] = traces;
      record["changes"] = changes - previousChanges;
      record["changedValue"] = changedValues.at(-1);
      receipts.push(record);
      if (["native-change", "repeated-input"].includes(mode)) {
        expect(changes - previousChanges).toBe(1);
        expect(changedValues.at(-1)).toBe(mode === "repeated-input" ? "366.00" : "365.00");
      }
      expect(record.complete).toBe(expectedComplete);
      expect(record.steps?.[0]).toBe("completed");
      if (expectedComplete) {
        expect(actualEffects).toBe(1);
        expect(record.steps?.at(-1)).toBe("completed");
      } else if (["post-click-reply-lost", "worker-killed-after-effect"].includes(mode)) {
        expect(error).toBe(
          mode === "worker-killed-after-effect"
            ? "SCRY_BROWSER_ADAPTER_LOST"
            : "SCRY_BROWSER_ADAPTER_TIMEOUT",
        );
        expect(record.steps?.[1]).toBe("unknown");
        expect(actualEffects).toBe(1);
      } else {
        expect(error).toBe(undefined);
        expect(record.execution).toBe("partial");
        expect(record.steps?.[1]).toBe("not_dispatched");
        expect(actualEffects).toBe(0);
      }
      if (mode === "remove-describedby") {
        const recovered: any = await actualCall({
          type: "call",
          tool: "browser_snapshot",
          args: {},
        });
        expect(recovered.observationAvailable).not.toBe(false);
        record["snapshotRecoveryAvailable"] = true;
      }
    } finally {
      c.lease.revoke();
      await worker.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
