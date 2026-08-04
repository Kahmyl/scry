import { createServer } from "node:http";
import { chromium, type Page } from "playwright";
import {
  VEIL_CONTRACT_VERSION,
  type VeilCollectorPhase,
  type VeilEvidenceChannel,
  type VeilLeaseRequest,
} from "@scry/contracts";
import { compileVeilPolicy } from "@scry/veil";
import { VeilAuthority } from "@scry/veil";
import { VeilRuntimeSession, type VeilRuntimeCollector } from "@scry/veil";
import { visualRedactionInitScript } from "@scry/praxis";
import { VeilVisualCaptureAuthority } from "@scry/veil";

type Result = {
  id: string;
  proof: string;
  status: "passed" | "failed";
  durationMs: number;
  diagnostics?: unknown;
};
class Collector implements VeilRuntimeCollector {
  phase: VeilCollectorPhase | "idle" = "idle";
  constructor(readonly id: string) {}
  async transition(
    phase: VeilCollectorPhase,
    context: { operationId?: string; stateVersion: number },
  ) {
    this.phase = phase;
    return {
      schemaVersion: VEIL_CONTRACT_VERSION,
      collectorId: this.id,
      phase,
      ...(context.operationId ? { operationId: context.operationId } : {}),
      stateVersion: context.stateVersion,
      acknowledgedAt: new Date().toISOString(),
    };
  }
}

async function main() {
  const cross = await serve((path) =>
    path === "/frame"
      ? `<body style="background:#fff"><input value="CROSS_ORIGIN_CANARY"></body>`
      : undefined,
  );
  const primary = await serve(
    (path) =>
      path === "/fixture"
        ? fixture(cross.origin)
        : path === "/fixture.pdf"
          ? "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF"
          : undefined,
    (path) => (path.endsWith(".pdf") ? "application/pdf" : "text/html"),
  );
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  const results: Result[] = [];
  try {
    const tests: [
      string,
      string,
      (
        page: Page,
        authority: VeilAuthority,
        request: (
          channel: VeilEvidenceChannel,
          classification: "public" | "secret" | "unknown",
        ) => VeilLeaseRequest,
      ) => Promise<void>,
    ][] = [
      [
        "cross-origin-frame",
        "real cross-origin iframe is covered by an opaque full-frame fallback",
        async (page) => {
          await page.goto(`${primary.origin}/fixture`);
          await assertMasked(page, "#cross");
        },
      ],
      [
        "closed-shadow",
        "closed-shadow host is covered as a full opaque region",
        async (page) => {
          await page.goto(`${primary.origin}/fixture`);
          await assertMasked(page, "#closed-host");
        },
      ],
      [
        "canvas-2d",
        "decoded protected canvas pixels are opaque",
        async (page) => {
          await page.goto(`${primary.origin}/fixture`);
          await assertMasked(page, "#canvas2d");
        },
      ],
      [
        "webgl",
        "decoded protected WebGL region is opaque",
        async (page) => {
          await page.goto(`${primary.origin}/fixture`);
          await assertMasked(page, "#webgl");
        },
      ],
      [
        "video-gap",
        "unknown video region forces quarantine and the visible region is omitted",
        async (page, authority, request) => {
          await page.goto(`${primary.origin}/fixture`);
          check(
            authority.decide(request("video", "unknown")).disposition === "quarantine",
            "unknown video was not quarantined",
          );
          await assertMasked(page, "#video-region");
        },
      ],
      [
        "pdf-refusal",
        "browser PDF capture receives no secret capability",
        async (page, authority, request) => {
          await page.goto(`${primary.origin}/fixture.pdf`, { waitUntil: "commit" });
          check(
            authority.decide(request("screenshot", "secret")).disposition === "suppress",
            "PDF screenshot was not suppressed",
          );
          await rejects(() => authority.issueLease(request("screenshot", "secret")));
        },
      ],
      [
        "clipboard-download",
        "clipboard and download capabilities are refused for secrets",
        async (_page, authority, request) => {
          for (const channel of ["clipboard", "download"] as const) {
            check(
              authority.decide(request(channel, "secret")).disposition === "suppress",
              `${channel} was not suppressed`,
            );
            await rejects(() => authority.issueLease(request(channel, "secret")));
          }
        },
      ],
      [
        "trace-archive",
        "trace canary is removed before sanitized admission",
        async (_page, authority, request) => {
          const canary = "TRACE_ARCHIVE_CANARY";
          const raw = Buffer.from(`event:${canary}:end`);
          check(raw.includes(Buffer.from(canary)), "trace fixture lacks canary");
          await rejects(() => authority.issueLease(request("trace", "secret")));
          const sanitized = Buffer.from(raw.toString().replaceAll(canary, "[REDACTED]"));
          check(!sanitized.includes(Buffer.from(canary)), "sanitized trace retained canary");
        },
      ],
      [
        "context-loss",
        "browser context loss seals all collectors before reuse",
        async (page) => {
          const collector = new Collector("loss-proof");
          const runtime = new VeilRuntimeSession([collector], "a".repeat(64), "loss-context");
          await runtime.prepare("loss-operation");
          await runtime.beginProtected();
          await page.context().close();
          await runtime.seal({
            schemaVersion: VEIL_CONTRACT_VERSION,
            code: "VEIL_BROWSER_CONTEXT_LOST",
            provenance: "runtime",
            retry: "requires_new_context",
          });
          check(runtime.state() === "sealed", "context loss did not seal runtime");
          check(collector.phase === "seal", "collector did not acknowledge context-loss seal");
        },
      ],
      [
        "browser-loss",
        "browser process loss seals the runtime before reuse",
        async () => {
          const isolated = await chromium.launch({
            headless: true,
            channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
          });
          const lostPage = await isolated.newPage();
          await lostPage.goto(`${primary.origin}/fixture`);
          const collector = new Collector("browser-loss-proof");
          const runtime = new VeilRuntimeSession([collector], "b".repeat(64), "browser-loss");
          await runtime.prepare("browser-loss-operation");
          await runtime.beginProtected();
          await isolated.close();
          await runtime.seal({
            schemaVersion: VEIL_CONTRACT_VERSION,
            code: "VEIL_BROWSER_LOST",
            provenance: "runtime",
            retry: "requires_new_context",
          });
          check(runtime.state() === "sealed", "browser loss did not seal runtime");
          check(collector.phase === "seal", "collector did not acknowledge browser-loss seal");
        },
      ],
      [
        "masking-runtime-loss",
        "removing the real mask runtime either refuses or re-establishes masks before capture",
        async (page) => {
          await page.goto(`${primary.origin}/fixture`);
          const visual = new VeilVisualCaptureAuthority("c".repeat(64));
          const binding = {
            browserContextId: "mask-context",
            pageId: "mask-page",
            frameId: "main",
            documentEpoch: 1,
          };
          const { permit } = await visual.issue(page, binding);
          await page.evaluate(() => {
            document.getElementById("scry-veil-capture-mask-style")?.remove();
            document
              .querySelectorAll("[data-scry-veil-capture-mask]")
              .forEach((element) => element.removeAttribute("data-scry-veil-capture-mask"));
          });
          try {
            await visual.validate(page, permit, binding);
            await assertMasked(page, "#canvas2d");
          } catch (error) {
            check(error instanceof Error, "mask loss produced an untyped outcome");
          }
        },
      ],
    ];
    for (const [id, proof, run] of tests) {
      const started = performance.now();
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await context.addInitScript({ content: visualRedactionInitScript });
      const page = await context.newPage();
      const policy = compileVeilPolicy({
        profile: "balanced",
        allowedOrigins: [primary.origin, cross.origin],
      });
      const authority = new VeilAuthority(policy);
      const request = (
        channel: VeilEvidenceChannel,
        classification: "public" | "secret" | "unknown",
      ): VeilLeaseRequest => ({
        context: {
          userId: "adversarial-user",
          environmentId: "local",
          transactionId: `tx-${id}`,
          origin: primary.origin,
          browserContextId: `ctx-${id}`,
          pageId: `page-${id}`,
          frameId: "main",
          documentEpoch: 1,
        },
        operation: "capture",
        channel,
        classification,
        scope: "channel",
      });
      try {
        await run(page, authority, request);
        results.push({ id, proof, status: "passed", durationMs: performance.now() - started });
      } catch (error) {
        results.push({
          id,
          proof,
          status: "failed",
          durationMs: performance.now() - started,
          diagnostics:
            error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
      } finally {
        if (!context.pages().length) continue;
        await context.close();
      }
    }
    const failed = results.filter((x) => x.status === "failed").length;
    const report = {
      schemaVersion: 1,
      campaign: "veil-adversarial",
      executedAt: new Date().toISOString(),
      environment: {
        realHttp: true,
        realChromium: true,
        browserVersion: browser.version(),
        origins: 2,
      },
      counts: { total: results.length, passed: results.length - failed, failed, skipped: 0 },
      coverage: {
        realBrowser: [
          "cross-origin-frame",
          "closed-shadow",
          "canvas-2d",
          "webgl",
          "video-region",
          "browser-pdf",
          "context-loss",
          "browser-process-loss",
        ],
        authorityRefusal: ["pdf-screenshot", "clipboard", "download", "secret-trace"],
        contentScan: ["decoded-png-rgba", "trace-buffer"],
      },
      qualification: failed === 0 ? "ADVERSARIAL_COMPONENT_PASS" : "ADVERSARIAL_COMPONENT_FAIL",
      readiness: "NOT_READY_WITHOUT_FULL_GATE",
      results,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await browser.close();
    await primary.close();
    await cross.close();
  }
}

async function assertMasked(page: Page, selector: string) {
  const target = page.locator(selector);
  await target.waitFor();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const profile = await pixels(page, await target.screenshot());
  check(
    profile.nonBlack === 0,
    `${selector} leaked ${profile.nonBlack} decoded pixels through the production mask runtime`,
  );
}
async function pixels(page: Page, bytes: Buffer) {
  return page.evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      let nonBlack = 0;
      for (let offset = 0; offset < data.length; offset += 4)
        if (data[offset] || data[offset + 1] || data[offset + 2] || data[offset + 3] !== 255)
          nonBlack++;
      return { nonBlack, total: image.width * image.height };
    },
    `data:image/png;base64,${bytes.toString("base64")}`,
  );
}
function fixture(crossOrigin: string) {
  return `<!doctype html><body><iframe id=cross src="${crossOrigin}/frame" style="width:300px;height:80px"></iframe><div id=closed-host style="width:300px;height:80px;background:white"></div><canvas id=canvas2d width=300 height=80></canvas><canvas id=webgl width=300 height=80></canvas><video id=video-region width=300 height=80 controls style="background:white"></video><script>const host=document.querySelector('#closed-host');host.attachShadow({mode:'closed'}).innerHTML='<input value=CLOSED_SHADOW_CANARY>';const c=document.querySelector('#canvas2d').getContext('2d');c.fillStyle='white';c.fillRect(0,0,300,80);c.fillStyle='red';c.fillText('CANVAS_CANARY',5,20);const gl=document.querySelector('#webgl').getContext('webgl');gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT)</script></body>`;
}
async function serve(
  render: (path: string) => string | undefined,
  contentType: (path: string) => string = () => "text/html",
) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://local").pathname;
    const body = render(path);
    if (body === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": contentType(path), "cache-control": "no-store" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
async function rejects(operation: () => unknown | Promise<unknown>) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  check(rejected, "expected refusal");
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
(
  process.stdout as typeof process.stdout & { _handle?: { setBlocking?(value: boolean): void } }
)._handle?.setBlocking?.(true);
await main();
