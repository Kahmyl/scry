import { chromium, type Page } from "playwright";
import type {
  ExpectedEffect,
  InteractionTargetIntent,
  PraxisOperation,
  PraxisResult,
} from "@scry/contracts";
import { executePraxisCampaignConsumer as executePraxisConsumer } from "./praxis-campaign-veil.js";

type AppCategory =
  "content" | "framework" | "runtime" | "tooling" | "infrastructure" | "standards" | "commercial";
type InspectJourney = { kind: "inspect"; heading: string };
type ScrollJourney = { kind: "scroll"; heading: string };
type NavigateJourney = { kind: "navigate"; link: string; urlContains: string };
type Journey = InspectJourney | ScrollJourney | NavigateJourney;
type PublicApplication = {
  id: string;
  name: string;
  category: AppCategory;
  url: string;
  journey: Journey;
};
type Result = {
  id: string;
  name: string;
  category: AppCategory;
  url: string;
  finalUrl: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  diagnostics?: unknown;
};
class CheckError extends Error {
  constructor(
    message: string,
    readonly evidence: unknown = {},
  ) {
    super(message);
    this.name = "CheckError";
  }
}

const applications: readonly PublicApplication[] = [
  {
    id: "wikipedia",
    name: "Wikipedia",
    category: "content",
    url: "https://www.wikipedia.org/",
    journey: { kind: "inspect", heading: "Wikipedia The Free Encyclopedia" },
  },
  {
    id: "mdn",
    name: "MDN Web Docs",
    category: "content",
    url: "https://developer.mozilla.org/en-US/",
    journey: { kind: "inspect", heading: "Resources for Developers, by Developers" },
  },
  {
    id: "react",
    name: "React",
    category: "framework",
    url: "https://react.dev/",
    journey: { kind: "navigate", link: "Learn React", urlContains: "/learn" },
  },
  {
    id: "vue",
    name: "Vue",
    category: "framework",
    url: "https://vuejs.org/",
    journey: { kind: "navigate", link: "Get Started", urlContains: "/guide/" },
  },
  {
    id: "angular",
    name: "Angular",
    category: "framework",
    url: "https://angular.dev/",
    journey: { kind: "inspect", heading: "Angular v22 is here!" },
  },
  {
    id: "svelte",
    name: "Svelte",
    category: "framework",
    url: "https://svelte.dev/",
    journey: { kind: "navigate", link: "Tutorial", urlContains: "/tutorial/" },
  },
  {
    id: "node",
    name: "Node.js",
    category: "runtime",
    url: "https://nodejs.org/en",
    journey: { kind: "inspect", heading: "Run JavaScript Everywhere" },
  },
  {
    id: "typescript",
    name: "TypeScript",
    category: "tooling",
    url: "https://www.typescriptlang.org/",
    journey: { kind: "navigate", link: "Handbook", urlContains: "/docs/handbook/" },
  },
  {
    id: "playwright",
    name: "Playwright",
    category: "tooling",
    url: "https://playwright.dev/",
    journey: { kind: "navigate", link: "MCP", urlContains: "/mcp/introduction" },
  },
  {
    id: "vitest",
    name: "Vitest",
    category: "tooling",
    url: "https://vitest.dev/",
    journey: { kind: "navigate", link: "Get Started", urlContains: "/guide/" },
  },
  {
    id: "pnpm",
    name: "pnpm",
    category: "tooling",
    url: "https://pnpm.io/",
    journey: {
      kind: "scroll",
      heading: "pnpm: Save time. Save disk space. Supercharge your monorepos.",
    },
  },
  {
    id: "python",
    name: "Python",
    category: "runtime",
    url: "https://www.python.org/",
    journey: { kind: "inspect", heading: "Intuitive Interpretation" },
  },
  {
    id: "rust",
    name: "Rust",
    category: "runtime",
    url: "https://www.rust-lang.org/",
    journey: { kind: "inspect", heading: "Rust" },
  },
  {
    id: "go",
    name: "Go",
    category: "runtime",
    url: "https://go.dev/",
    journey: { kind: "scroll", heading: "Build simple, secure, scalable systems with Go" },
  },
  {
    id: "postgresql",
    name: "PostgreSQL",
    category: "infrastructure",
    url: "https://www.postgresql.org/",
    journey: {
      kind: "inspect",
      heading: "PostgreSQL: The World's Most Advanced Open Source Relational Database",
    },
  },
  {
    id: "redis",
    name: "Redis",
    category: "infrastructure",
    url: "https://redis.io/",
    journey: { kind: "inspect", heading: "INQUIRING AGENTS WANT TO KNOW:" },
  },
  {
    id: "kubernetes",
    name: "Kubernetes",
    category: "infrastructure",
    url: "https://kubernetes.io/",
    journey: {
      kind: "navigate",
      link: "Learn Kubernetes Basics",
      urlContains: "/docs/tutorials/kubernetes-basics/",
    },
  },
  {
    id: "docker",
    name: "Docker",
    category: "commercial",
    url: "https://www.docker.com/",
    journey: { kind: "inspect", heading: "Accelerate agent adoption, safely." },
  },
  {
    id: "w3c",
    name: "W3C",
    category: "standards",
    url: "https://www.w3.org/",
    journey: { kind: "scroll", heading: "Making the web work" },
  },
  {
    id: "webdev",
    name: "web.dev",
    category: "content",
    url: "https://web.dev/",
    journey: { kind: "navigate", link: "Baseline", urlContains: "/baseline" },
  },
  {
    id: "github_docs",
    name: "GitHub Docs",
    category: "content",
    url: "https://docs.github.com/en",
    journey: { kind: "navigate", link: "Get started", urlContains: "/get-started" },
  },
  {
    id: "npm_docs",
    name: "npm Docs",
    category: "content",
    url: "https://docs.npmjs.com/",
    journey: { kind: "inspect", heading: "npm Docs" },
  },
  {
    id: "nextjs",
    name: "Next.js",
    category: "framework",
    url: "https://nextjs.org/",
    journey: { kind: "inspect", heading: "The React Framework for the Web" },
  },
  {
    id: "nuxt",
    name: "Nuxt",
    category: "framework",
    url: "https://nuxt.com/",
    journey: { kind: "inspect", heading: "The Full-StackVue Framework" },
  },
  {
    id: "tailwind",
    name: "Tailwind CSS",
    category: "tooling",
    url: "https://tailwindcss.com/",
    journey: {
      kind: "scroll",
      heading: "Rapidly build modern websites without ever leaving your HTML.",
    },
  },
] as const;

async function main() {
  check(
    applications.length >= 20 && applications.length <= 30,
    "public application count outside 20-30",
  );
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
  const results: Result[] = [];
  let ordinal = 0;
  try {
    for (const application of applications) {
      const started = performance.now();
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      let praxisResult: PraxisResult | undefined;
      try {
        const response = await page.goto(application.url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        check(Boolean(response), "navigation produced no HTTP response");
        check(
          response!.status() >= 200 && response!.status() < 400,
          `HTTP status ${response!.status()}`,
        );
        await page.waitForTimeout(750);
        const origin = new URL(page.url()).origin;
        const invocation = invocationFor(application.journey, page.url());
        praxisResult = await executePraxisConsumer({
          page,
          intent: invocation.intent,
          operation: invocation.operation,
          expectedEffect: invocation.effect,
          signal: new AbortController().signal,
          context: {
            channel: "probe",
            ordinal: ++ordinal,
            allowedOrigins: [origin],
            timeoutMs: 15_000,
          },
        });
        assertSuccess(praxisResult);
        equal(
          praxisResult.resolution.target.concept,
          invocation.intent.concept,
          "resolved concept",
        );
        check(
          /^[a-f0-9]{64}$/.test(praxisResult.resolution.target.fingerprint),
          "invalid target fingerprint",
          praxisResult.resolution.target,
        );
        await assertObservable(page, application.journey);
        results.push({
          id: application.id,
          name: application.name,
          category: application.category,
          url: application.url,
          finalUrl: page.url(),
          status: "passed",
          durationMs: performance.now() - started,
        });
      } catch (error) {
        results.push({
          id: application.id,
          name: application.name,
          category: application.category,
          url: application.url,
          finalUrl: page.url(),
          status: "failed",
          durationMs: performance.now() - started,
          diagnostics: {
            error: diagnostic(error),
            praxis: summarizePraxis(praxisResult),
            state: await state(page).catch(() => null),
          },
        });
      } finally {
        await context.close();
      }
    }
    const report = {
      schemaVersion: 1,
      campaign: "praxis-public-application-qualification",
      executedAt: new Date().toISOString(),
      environment: {
        browser: "real_chromium",
        browserVersion: browser.version(),
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
        transport: "public_https",
        persistence: false,
        missionFlowInfrastructure: false,
        externalMutation: "none",
      },
      counts: {
        total: results.length,
        passed: results.filter((item) => item.status === "passed").length,
        failed: results.filter((item) => item.status === "failed").length,
        skipped: results.filter((item) => item.status === "skipped").length,
      },
      categories: Object.fromEntries(
        [...new Set(results.map((item) => item.category))].map((category) => [
          category,
          summary(results, category),
        ]),
      ),
      results,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.counts.failed ? 1 : 0);
  } finally {
    await browser.close();
  }
}

function invocationFor(
  journey: Journey,
  _beforeUrl: string,
): { intent: InteractionTargetIntent; operation: PraxisOperation; effect?: ExpectedEffect } {
  if (journey.kind === "navigate")
    return {
      intent: link(journey.link),
      operation: { type: "activate" },
      effect: { type: "navigation", url: journey.urlContains, match: "contains" },
    };
  const intent = heading(journey.heading);
  return {
    intent,
    operation:
      journey.kind === "scroll" ? { type: "scroll", direction: "into_view" } : { type: "inspect" },
  };
}
async function assertObservable(page: Page, journey: Journey) {
  if (journey.kind === "navigate") {
    check(page.url().includes(journey.urlContains), `navigation effect missing: ${page.url()}`);
    return;
  }
  const expected = normalized(journey.heading);
  const candidates = page.locator("h1,h2,h3,h4,h5,h6,[role=heading]");
  const exact: number[] = [];
  for (let index = 0, count = await candidates.count(); index < count; index += 1)
    if (normalized((await candidates.nth(index).textContent()) ?? "") === expected)
      exact.push(index);
  equal(exact.length, 1, "exact heading count");
  const target = candidates.nth(exact[0]!);
  check(await target.isVisible(), "exact heading not visible");
  if (journey.kind === "scroll")
    check(
      await target.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom >= 0 && bounds.top <= innerHeight;
      }),
      "scroll target outside viewport",
    );
}
function normalized(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function base(
  concept: string,
  capabilities: InteractionTargetIntent["requiredCapabilities"],
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: capabilities,
    preferredEvidence: {
      roles: [],
      names: [concept],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "read_only",
    confidence: { requiredFamilies: [] },
  };
}
function heading(name: string): InteractionTargetIntent {
  return {
    ...base(name, ["readable_value"]),
    preferredEvidence: {
      roles: ["heading"],
      names: [name],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
      expectedText: name,
    },
  };
}
function link(name: string): InteractionTargetIntent {
  return {
    ...base(name, ["pointer_activatable"]),
    preferredEvidence: {
      roles: ["link"],
      names: [name],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
  };
}
function assertSuccess(
  result: PraxisResult,
): asserts result is Extract<PraxisResult, { status: "succeeded" }> {
  check(result.status === "succeeded", "Praxis did not succeed", result);
}
function check(value: unknown, message: string, evidence: unknown = {}) {
  if (!value) throw new CheckError(message, evidence);
}
function equal(actual: unknown, expected: unknown, message: string) {
  if (!Object.is(actual, expected))
    throw new CheckError(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}
function diagnostic(error: unknown) {
  return error instanceof CheckError
    ? { name: error.name, message: error.message, evidence: summarizeEvidence(error.evidence) }
    : error instanceof Error
      ? { name: error.name, message: error.message }
      : String(error);
}
async function state(page: Page) {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    heading: Array.from(document.querySelectorAll("h1"))
      .map((item) => item.textContent?.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3),
  }));
}
function summary(results: Result[], category: AppCategory) {
  const selected = results.filter((item) => item.category === category);
  return {
    total: selected.length,
    passed: selected.filter((item) => item.status === "passed").length,
    failed: selected.filter((item) => item.status === "failed").length,
    skipped: selected.filter((item) => item.status === "skipped").length,
  };
}
function summarizeEvidence(evidence: unknown) {
  return evidence && typeof evidence === "object" && "status" in evidence
    ? summarizePraxis(evidence as PraxisResult)
    : evidence;
}
function summarizePraxis(result: PraxisResult | undefined) {
  if (!result) return null;
  if (result.status === "succeeded")
    return {
      status: result.status,
      phase: result.phase,
      mutationOutcome: result.mutationOutcome,
      confidence: result.resolution.confidence,
      margin: result.resolution.runnerUpMargin,
      strategy: result.resolution.strategy,
      target: result.resolution.target,
      timing: result.timing,
      qualityFindings: result.qualityFindings.map((item) => item.code),
    };
  return {
    status: result.status,
    phase: result.phase,
    code: result.code,
    provenance: result.provenance,
    mutationOutcome: result.mutationOutcome,
    retry: result.retry,
    safeActions: result.safeActions,
    diagnostics: result.diagnostics,
    timing: result.timing,
  };
}

(
  process.stdout as typeof process.stdout & { _handle?: { setBlocking?(value: boolean): void } }
)._handle?.setBlocking?.(true);
await main();
