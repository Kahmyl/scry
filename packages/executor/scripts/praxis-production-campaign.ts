import { createServer } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import type {
  ExpectedEffect,
  InteractionTargetIntent,
  PraxisLifecycleEvent,
  PraxisOperation,
  PraxisResult,
} from "@scry/contracts";
import { executePraxisCampaignConsumer as executePraxisConsumer } from "./praxis-campaign-veil.js";

type ScenarioContext = {
  page: Page;
  origin: string;
  invoke: (input: Invocation) => Promise<{ result: PraxisResult; events: PraxisLifecycleEvent[] }>;
};
type Invocation = {
  intent: InteractionTargetIntent;
  operation: PraxisOperation;
  expectedEffect?: ExpectedEffect;
  timeoutMs?: number;
  allowedOrigins?: string[];
  privacy?: { state: string; allowedChannels: string[]; suppressedChannels: string[] };
  signal?: AbortSignal;
  resolveInput?: (
    reference: string,
    classification: "public" | "known_secret" | "captured_secret" | "captured_public",
  ) => Promise<string>;
};
type Scenario = {
  id: string;
  category: string;
  path: string;
  execute(context: ScenarioContext): Promise<void>;
};
type ScenarioResult = {
  id: string;
  category: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  diagnostics?: unknown;
};

class CampaignExpectationError extends Error {
  constructor(
    message: string,
    readonly diagnostics: unknown,
  ) {
    super(message);
    this.name = "CampaignExpectationError";
  }
}

const pages = new Map<string, string>([
  [
    "/native-commit",
    app(
      "Native transaction",
      `<button id="commit">Commit invoice</button><output id="receipt" data-scry-readable>Pending</output>`,
      `document.querySelector('#commit').addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#receipt').textContent='Invoice committed';});`,
    ),
  ],
  [
    "/custom-command",
    app(
      "Custom command",
      `<div id="command" role="button" tabindex="0" aria-label="Queue deployment">Queue deployment</div><p id="deployment" data-scry-readable>Idle</p>`,
      `const command=document.querySelector('#command');const run=()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#deployment').textContent='Deployment queued';};command.addEventListener('click',run);command.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')run();});`,
    ),
  ],
  [
    "/wrapped-reference",
    app(
      "Wrapped reference",
      `<label for="reference"><span>Dispatch reference</span></label><div class="shell"><input id="reference" placeholder="Reference assigned by operations"></div><output id="preview" data-scry-readable></output>`,
      `document.querySelector('#reference').addEventListener('input',event=>{document.querySelector('#preview').textContent='Reference: '+event.target.value;});`,
    ),
  ],
  [
    "/custom-editor",
    app(
      "Custom editor",
      `<span id="editor-label">Release note</span><div id="editor" role="textbox" aria-labelledby="editor-label" contenteditable="true">Old note</div><output id="mirror" data-scry-readable></output>`,
      `document.querySelector('#editor').addEventListener('input',event=>{document.querySelector('#mirror').textContent=event.target.textContent;});`,
    ),
  ],
  [
    "/shipping-tier",
    app(
      "Shipping tier",
      `<label for="tier">Shipping tier</label><select id="tier"><option value="economy">Economy</option><option value="priority">Priority</option></select><output id="tier-state" data-scry-readable>economy</output>`,
      `document.querySelector('#tier').addEventListener('change',event=>{document.querySelector('#tier-state').textContent=event.target.value;});`,
    ),
  ],
  [
    "/risk-toggle",
    app(
      "Risk toggle",
      `<label><input id="risk" type="checkbox"> Include risk appendix</label><output id="risk-state" data-scry-readable>excluded</output>`,
      `document.querySelector('#risk').addEventListener('change',event=>{document.querySelector('#risk-state').textContent=event.target.checked?'included':'excluded';});`,
    ),
  ],
  [
    "/scoped-duplicates",
    app(
      "Scoped duplicates",
      `<section aria-label="Draft purchase"><h2>Draft purchase</h2><button id="draft-approve">Approve purchase</button></section><section aria-label="Live purchase"><h2>Live purchase</h2><button id="live-approve">Approve purchase</button><output id="approval" data-scry-readable>Waiting</output></section>`,
      `document.querySelector('#draft-approve').addEventListener('click',()=>window.wrongTarget=(window.wrongTarget||0)+1);document.querySelector('#live-approve').addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#approval').textContent='Live purchase approved';});`,
    ),
  ],
  [
    "/ambiguous-review",
    app(
      "Ambiguous review",
      `<button class="review">Review exception</button><button class="review">Review exception</button><output id="review-state" data-scry-readable>Untouched</output>`,
      `document.querySelectorAll('.review').forEach(button=>button.addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#review-state').textContent='Changed';}));`,
    ),
  ],
  [
    "/delayed-panel",
    app(
      "Delayed panel",
      `<main id="mount"><p>Preparing controls</p></main>`,
      `setTimeout(()=>{document.querySelector('#mount').innerHTML='<button id="finalize">Finalize delayed batch</button><output id="delayed-state" data-scry-readable>Ready</output>';document.querySelector('#finalize').addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#delayed-state').textContent='Finalized';});},250);`,
    ),
  ],
  [
    "/replacement-race",
    app(
      "Replacement race",
      `<button id="rotating" aria-label="Confirm rotating token">Confirm rotating token</button><output id="rotation" data-scry-readable>Original</output>`,
      `const original=document.querySelector('#rotating');original.addEventListener('pointerover',()=>{const replacement=original.cloneNode(true);replacement.dataset.replacement='true';replacement.addEventListener('click',()=>{window.replacementClicks=(window.replacementClicks||0)+1;document.querySelector('#rotation').textContent='Replacement clicked';});original.replaceWith(replacement);},{once:true});original.addEventListener('click',()=>{window.originalClicks=(window.originalClicks||0)+1;document.querySelector('#rotation').textContent='Original clicked';});`,
    ),
  ],
  [
    "/disabled-export",
    app(
      "Disabled export",
      `<button id="export" disabled>Export signed archive</button><output data-scry-readable>Archive unavailable</output>`,
      `document.querySelector('#export').addEventListener('click',()=>window.actionCount=(window.actionCount||0)+1);`,
    ),
  ],
  [
    "/incorrect-effect",
    app(
      "Incorrect effect",
      `<button id="publish">Publish bulletin</button><output id="published" data-scry-readable>Draft</output><output id="unrelated" data-scry-readable>Quiet</output>`,
      `document.querySelector('#publish').addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#unrelated').textContent='Unrelated changed';});`,
    ),
  ],
  [
    "/navigate-control",
    app(
      "Navigation",
      `<button id="continue">Continue to receipt</button>`,
      `document.querySelector('#continue').addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;location.href='/receipt?source=praxis';});`,
    ),
  ],
  [
    "/receipt",
    app(
      "Receipt",
      `<h1>Receipt accepted</h1><output id="receipt-status" data-scry-readable>accepted</output>`,
      ``,
    ),
  ],
  [
    "/origin-boundary",
    app(
      "Origin boundary",
      `<button id="transfer">Transfer custody</button><output id="custody" data-scry-readable>Held</output>`,
      `document.querySelector('#transfer').addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#custody').textContent='Transferred';});`,
    ),
  ],
  [
    "/secret-entry",
    app(
      "Secret entry",
      `<label for="token">Private recovery token</label><input id="token" type="password"><output id="token-state" data-scry-readable>Empty</output>`,
      `document.querySelector('#token').addEventListener('input',event=>{document.querySelector('#token-state').textContent=event.target.value.length?'Token accepted':'Empty';});`,
    ),
  ],
  [
    "/visual-privacy",
    app(
      "Visual privacy",
      `<button id="vault">Authorize vault release</button><output id="vault-state" data-scry-readable>Locked</output>`,
      `document.querySelector('#vault').addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#vault-state').textContent='Released';});`,
    ),
  ],
  [
    "/closed-shadow",
    app(
      "Closed shadow",
      `<div id="host"></div><output id="shadow-state" data-scry-readable>Untouched</output>`,
      `const root=document.querySelector('#host').attachShadow({mode:'closed'});const button=document.createElement('button');button.textContent='Approve sealed component';button.addEventListener('click',()=>{window.actionCount=(window.actionCount||0)+1;document.querySelector('#shadow-state').textContent='Changed';});root.append(button);`,
    ),
  ],
  [
    "/read-output",
    app(
      "Read output",
      `<dl><dt>Settlement code</dt><dd id="settlement" data-scry-readable>SET-9482-Z</dd></dl>`,
      ``,
    ),
  ],
]);

const scenarios: Scenario[] = [
  successAction(
    "native-semantic-activation",
    "valid",
    "/native-commit",
    buttonIntent("commit invoice"),
    { type: "activate" },
    textEffect("Invoice committed"),
    async (page) => {
      equal(
        await page.locator("#receipt").textContent(),
        "Invoice committed",
        "native action effect",
      );
      equal(await count(page, "actionCount"), 1, "native dispatch count");
    },
  ),
  successAction(
    "custom-role-activation",
    "poor_implementation",
    "/custom-command",
    buttonIntent("queue deployment"),
    { type: "activate" },
    textEffect("Deployment queued"),
    async (page) => {
      equal(
        await page.locator("#deployment").textContent(),
        "Deployment queued",
        "custom control effect",
      );
      equal(await count(page, "actionCount"), 1, "custom dispatch count");
    },
  ),
  successAction(
    "wrapped-labelled-text-entry",
    "poor_implementation",
    "/wrapped-reference",
    textIntent("dispatch reference"),
    inputOperation("reference", "public"),
    textEffect("Reference: REF-77B"),
    async (page) => {
      equal(await page.locator("#reference").inputValue(), "REF-77B", "input value");
      equal(await page.locator("#preview").textContent(), "Reference: REF-77B", "input effect");
    },
    async () => "REF-77B",
  ),
  successAction(
    "contenteditable-entry",
    "custom_control",
    "/custom-editor",
    textIntent("release note"),
    inputOperation("note", "public"),
    textEffect("Ready for phased release"),
    async (page) => {
      equal(
        await page.locator("#editor").textContent(),
        "Ready for phased release",
        "editor value",
      );
      equal(
        await page.locator("#mirror").textContent(),
        "Ready for phased release",
        "editor effect",
      );
    },
    async () => "Ready for phased release",
  ),
  successAction(
    "native-option-selection",
    "valid",
    "/shipping-tier",
    selectIntent("shipping tier"),
    { type: "select_option", input: { reference: "tier", classification: "public" } },
    textEffect("priority"),
    async (page) => {
      equal(await page.locator("#tier").inputValue(), "priority", "selected option");
      equal(await page.locator("#tier-state").textContent(), "priority", "selection effect");
    },
    async () => "priority",
  ),
  successAction(
    "native-toggle-state",
    "valid",
    "/risk-toggle",
    toggleIntent("include risk appendix"),
    { type: "set_checked", checked: true },
    textEffect("included"),
    async (page) => {
      truth(await page.locator("#risk").isChecked(), "toggle must be checked");
      equal(await page.locator("#risk-state").textContent(), "included", "toggle effect");
    },
  ),
  successAction(
    "named-scope-disambiguation",
    "scoping",
    "/scoped-duplicates",
    buttonIntent("approve purchase", { kind: "region", name: "Live purchase" }),
    { type: "activate" },
    textEffect("Live purchase approved"),
    async (page) => {
      equal(await count(page, "wrongTarget"), 0, "wrong scoped target count");
      equal(await count(page, "actionCount"), 1, "right scoped target count");
    },
  ),
  {
    id: "duplicate-identity-refusal",
    category: "ambiguity",
    path: "/ambiguous-review",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("review exception"),
        operation: { type: "activate" },
      });
      failure(result, "PRAXIS_TARGET_AMBIGUOUS", "intent", "not_started");
      equal(await count(context.page, "actionCount"), 0, "ambiguous dispatch count");
      equal(
        await context.page.locator("#review-state").textContent(),
        "Untouched",
        "ambiguous state",
      );
    },
  },
  {
    id: "delayed-render-within-budget",
    category: "delayed_rendering",
    path: "/delayed-panel",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("finalize delayed batch"),
        operation: { type: "activate" },
        expectedEffect: textEffect("Finalized"),
        timeoutMs: 1_500,
      });
      succeeded(result);
      equal(
        await context.page.locator("#delayed-state").textContent(),
        "Finalized",
        "delayed render effect",
      );
      equal(await count(context.page, "actionCount"), 1, "delayed dispatch count");
    },
  },
  {
    id: "safe-recovery-after-render",
    category: "recovery",
    path: "/delayed-panel",
    async execute(context) {
      const first = await context.invoke({
        intent: buttonIntent("finalize delayed batch"),
        operation: { type: "activate" },
        timeoutMs: 150,
      });
      failure(first.result, "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL", "praxis", "not_started");
      await context.page.locator("#finalize").waitFor({ state: "visible", timeout: 1_000 });
      const second = await context.invoke({
        intent: buttonIntent("finalize delayed batch"),
        operation: { type: "activate" },
        expectedEffect: textEffect("Finalized"),
      });
      succeeded(second.result);
      equal(await count(context.page, "actionCount"), 1, "recovery dispatch count");
    },
  },
  {
    id: "replacement-between-revalidation-and-click",
    category: "dynamic_replacement",
    path: "/replacement-race",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("confirm rotating token"),
        operation: { type: "activate" },
      });
      failure(result, "PRAXIS_DISPATCH_FAILED", "application", "unknown", "inconclusive", "unsafe");
      equal(await count(context.page, "replacementClicks"), 0, "replacement dispatch count");
      equal(await count(context.page, "originalClicks"), 0, "original dispatch count");
    },
  },
  {
    id: "disabled-control-refusal",
    category: "unsupported",
    path: "/disabled-export",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("export signed archive"),
        operation: { type: "activate" },
      });
      failure(result, "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL", "praxis", "not_started");
      equal(await count(context.page, "actionCount"), 0, "disabled dispatch count");
    },
  },
  {
    id: "incorrect-effect-is-inconclusive",
    category: "incorrect_output",
    path: "/incorrect-effect",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("publish bulletin"),
        operation: { type: "activate" },
        expectedEffect: textEffect("Published"),
        timeoutMs: 500,
      });
      failure(
        result,
        "PRAXIS_EXPECTED_EFFECT_NOT_OBSERVED",
        "application",
        "unknown",
        "inconclusive",
        "unsafe",
      );
      equal(await count(context.page, "actionCount"), 1, "failed effect dispatch count");
      equal(
        await context.page.locator("#published").textContent(),
        "Draft",
        "authored effect state",
      );
    },
  },
  {
    id: "same-origin-navigation-effect",
    category: "navigation",
    path: "/navigate-control",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("continue to receipt"),
        operation: { type: "activate" },
        expectedEffect: { type: "navigation", url: "/receipt?source=praxis", match: "path" },
      });
      succeeded(result);
      equal(new URL(context.page.url()).pathname, "/receipt", "navigation path");
      equal(
        await context.page.locator("#receipt-status").textContent(),
        "accepted",
        "navigation page state",
      );
    },
  },
  {
    id: "disallowed-origin-refusal",
    category: "security_boundary",
    path: "/origin-boundary",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("transfer custody"),
        operation: { type: "activate" },
        allowedOrigins: ["https://outside-policy.invalid"],
      });
      failure(result, "PRAXIS_ORIGIN_NOT_ALLOWED", "policy", "not_started");
      equal(await count(context.page, "actionCount"), 0, "origin policy dispatch count");
      equal(await context.page.locator("#custody").textContent(), "Held", "origin policy state");
    },
  },
  {
    id: "secret-input-redaction",
    category: "privacy",
    path: "/secret-entry",
    async execute(context) {
      const secret = "vault-secret-9f3a2d";
      const { result, events } = await context.invoke({
        intent: { ...textIntent("private recovery token"), risk: "credential" },
        operation: inputOperation("recovery-token", "known_secret"),
        expectedEffect: textEffect("Token accepted"),
        privacy: {
          state: "protected",
          allowedChannels: ["public_dom", "accessibility"],
          suppressedChannels: ["visual", "ocr", "clipboard"],
        },
        resolveInput: async () => secret,
      });
      succeeded(result);
      equal(await context.page.locator("#token").inputValue(), secret, "secret input value");
      const serialized = JSON.stringify({ result, events });
      truth(!serialized.includes(secret), "secret leaked into Praxis result or lifecycle events", {
        serialized,
      });
      truth(
        !/selector|locator|clipboard|screenshot/i.test(serialized),
        "low-level or protected channel leaked",
        { serialized },
      );
    },
  },
  {
    id: "required-visual-channel-forbidden",
    category: "privacy_failure",
    path: "/visual-privacy",
    async execute(context) {
      const intent: InteractionTargetIntent = {
        ...buttonIntent("authorize vault release"),
        preferredEvidence: {
          roles: ["button"],
          names: [],
          labels: [],
          descriptions: [],
          placeholders: [],
          inputTypes: [],
          visual: {
            sources: ["ocr"],
            expectedText: "Authorize vault release",
            protectedUse: false,
          },
        },
        confidence: { requiredFamilies: ["visual"], minimumFamilyCount: 1 },
      };
      const { result } = await context.invoke({
        intent,
        operation: { type: "activate" },
        privacy: {
          state: "protected",
          allowedChannels: ["public_dom", "accessibility"],
          suppressedChannels: ["visual", "ocr"],
        },
      });
      failure(result, "PRAXIS_REQUIRED_CHANNEL_FORBIDDEN", "privacy", "not_started");
      equal(await count(context.page, "actionCount"), 0, "privacy denial dispatch count");
    },
  },
  {
    id: "closed-shadow-typed-refusal",
    category: "unsupported",
    path: "/closed-shadow",
    async execute(context) {
      const { result } = await context.invoke({
        intent: buttonIntent("approve sealed component"),
        operation: { type: "activate" },
      });
      failure(result, "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL", "praxis", "not_started");
      equal(await count(context.page, "actionCount"), 0, "closed shadow dispatch count");
      equal(
        await context.page.locator("#shadow-state").textContent(),
        "Untouched",
        "closed shadow state",
      );
    },
  },
  {
    id: "public-read-returns-exact-output",
    category: "read_output",
    path: "/read-output",
    async execute(context) {
      const { result } = await context.invoke({
        intent: readIntent("settlement code"),
        operation: { type: "read_value", classification: "public", permittedMethods: ["dom_text"] },
      });
      succeeded(result);
      const output = (result as unknown as { output?: { value?: string } }).output?.value;
      equal(output, "SET-9482-Z", "Praxis read output");
      equal(
        await context.page.locator("#settlement").textContent(),
        "SET-9482-Z",
        "browser read source",
      );
    },
  },
  {
    id: "cancelled-before-observation",
    category: "cancellation",
    path: "/native-commit",
    async execute(context) {
      const controller = new AbortController();
      controller.abort("campaign cancellation");
      const { result } = await context.invoke({
        intent: buttonIntent("commit invoice"),
        operation: { type: "activate" },
        signal: controller.signal,
      });
      failure(result, "PRAXIS_CANCELLED", "cancelled", "not_started", "cancelled", "safe");
      equal(await count(context.page, "actionCount"), 0, "cancelled dispatch count");
    },
  },
];

async function main() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = pages.get(pathname);
    if (!body) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self' 'unsafe-inline'",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Campaign HTTP server did not expose a TCP address.");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Browser | undefined;
  const results: ScenarioResult[] = [];
  try {
    const channel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
    browser = await chromium.launch({ headless: true, channel });
    let ordinal = 0;
    for (const scenario of scenarios) {
      const started = performance.now();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`${origin}${scenario.path}`, { waitUntil: "load" });
        const invoke = async (input: Invocation) => {
          const events: PraxisLifecycleEvent[] = [];
          ordinal += 1;
          const result = await executePraxisConsumer({
            page,
            intent: input.intent,
            operation: input.operation,
            expectedEffect: input.expectedEffect,
            signal: input.signal ?? new AbortController().signal,
            resolveInput: input.resolveInput,
            context: {
              channel: "action",
              ordinal,
              allowedOrigins: input.allowedOrigins ?? [origin],
              timeoutMs: input.timeoutMs ?? 2_500,
              privacy: input.privacy,
              emit: (event) => {
                events.push(event);
              },
            },
          });
          return { result, events };
        };
        await scenario.execute({ page, origin, invoke });
        results.push({
          id: scenario.id,
          category: scenario.category,
          status: "passed",
          durationMs: performance.now() - started,
        });
      } catch (error) {
        const browserState = await sanitizedBrowserState(page).catch((stateError) => ({
          captureError: stateError instanceof Error ? stateError.message : String(stateError),
        }));
        results.push({
          id: scenario.id,
          category: scenario.category,
          status: "failed",
          durationMs: performance.now() - started,
          diagnostics: { expectation: diagnostic(error), browserState },
        });
      } finally {
        await context.close();
      }
    }
    const report = {
      schemaVersion: 1,
      campaign: "praxis-core-production-shaped",
      executedAt: new Date().toISOString(),
      environment: {
        transport: "real_http",
        browser: "real_chromium",
        browserVersion: browser.version(),
        channel,
        origin,
        persistence: false,
        missionFlowInfrastructure: false,
      },
      counts: summarize(results),
      scenarios: results,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.counts.failed > 0) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function app(title: string, body: string, script: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:32px}button,input,select,[role=button],[contenteditable]{font:inherit;padding:10px;margin:8px;min-width:160px}section{border:1px solid #999;padding:16px;margin:12px}output{display:block;margin:12px}</style></head><body>${body}<script>window.actionCount=0;window.wrongTarget=0;window.originalClicks=0;window.replacementClicks=0;${script}</script></body></html>`;
}
function baseIntent(
  concept: string,
  capabilities: InteractionTargetIntent["requiredCapabilities"],
  scope: InteractionTargetIntent["scope"] = { kind: "page" },
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: capabilities,
    preferredEvidence: {
      roles: [],
      names: [concept],
      labels: [concept],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope,
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "ordinary",
    confidence: { requiredFamilies: [] },
  };
}
function buttonIntent(concept: string, scope?: InteractionTargetIntent["scope"]) {
  return {
    ...baseIntent(concept, ["pointer_activatable"], scope),
    preferredEvidence: {
      roles: ["button" as const],
      names: [concept],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
  };
}
function textIntent(concept: string) {
  return {
    ...baseIntent(concept, ["focusable", "accepts_text", "editable"]),
    preferredEvidence: {
      roles: ["textbox" as const],
      names: [concept],
      labels: [concept],
      descriptions: [],
      placeholders: [concept],
      inputTypes: ["text"],
    },
  };
}
function selectIntent(concept: string) {
  return {
    ...baseIntent(concept, ["focusable", "selects_option"]),
    preferredEvidence: {
      roles: ["combobox" as const],
      names: [concept],
      labels: [concept],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
  };
}
function toggleIntent(concept: string) {
  return {
    ...baseIntent(concept, ["focusable", "toggleable"]),
    preferredEvidence: {
      roles: ["checkbox" as const],
      names: [concept],
      labels: [concept],
      descriptions: [],
      placeholders: [],
      inputTypes: ["checkbox"],
    },
  };
}
function readIntent(concept: string) {
  return {
    ...baseIntent(concept, ["readable_value"]),
    risk: "read_only" as const,
    preferredEvidence: {
      roles: ["value" as const],
      names: [],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
      expectedText: concept,
    },
  };
}
function inputOperation(
  reference: string,
  classification: "public" | "known_secret",
): PraxisOperation {
  return { type: "enter_text", input: { reference, classification } };
}
function textEffect(expected: string): ExpectedEffect {
  return {
    type: "value_change",
    target: {
      ...readIntent(expected),
      preferredEvidence: {
        roles: ["value"],
        names: [],
        labels: [],
        descriptions: [],
        placeholders: [],
        inputTypes: [],
        expectedText: expected,
      },
    },
    expected,
  };
}
function successAction(
  id: string,
  category: string,
  path: string,
  intent: InteractionTargetIntent,
  operation: PraxisOperation,
  expectedEffect: ExpectedEffect,
  verify: (page: Page) => Promise<void>,
  resolveInput?: Invocation["resolveInput"],
): Scenario {
  return {
    id,
    category,
    path,
    async execute(context) {
      const { result } = await context.invoke({ intent, operation, expectedEffect, resolveInput });
      succeeded(result);
      truth(
        result.resolution.target.concept === intent.concept,
        "selected target concept mismatch",
        { resolution: result.resolution },
      );
      await verify(context.page);
    },
  };
}
function succeeded(
  result: PraxisResult,
): asserts result is Extract<PraxisResult, { status: "succeeded" }> {
  truth(result.status === "succeeded", "expected Praxis success", { result });
}
function failure(
  result: PraxisResult,
  code: string,
  provenance: string,
  mutationOutcome: string,
  status: string = "failed",
  retry?: string,
) {
  truth(result.status !== "succeeded", `expected Praxis failure ${code}`, { result });
  equal(result.status, status, "failure status", { result });
  equal(result.code, code, "failure code", { result });
  equal(result.provenance, provenance, "failure provenance", { result });
  equal(result.mutationOutcome, mutationOutcome, "mutation outcome", { result });
  if (retry) equal(result.retry, retry, "retry disposition", { result });
}
function truth(value: unknown, message: string, diagnostics: unknown = {}) {
  if (!value) throw new CampaignExpectationError(message, diagnostics);
}
function equal(actual: unknown, expected: unknown, label: string, diagnostics: unknown = {}) {
  if (!Object.is(actual, expected))
    throw new CampaignExpectationError(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      diagnostics,
    );
}
async function count(page: Page, name: string) {
  return page.evaluate(
    (key) => Number((window as unknown as Record<string, unknown>)[key] ?? 0),
    name,
  );
}
function summarize(results: ScenarioResult[]) {
  return {
    total: results.length,
    passed: results.filter((item) => item.status === "passed").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
  };
}
function diagnostic(error: unknown) {
  if (error instanceof CampaignExpectationError)
    return { kind: error.name, message: error.message, runtime: error.diagnostics };
  if (error instanceof Error)
    return {
      kind: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 8),
    };
  return { kind: "Unknown", value: String(error) };
}
async function sanitizedBrowserState(page: Page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1_000),
    actionCount: Number((window as unknown as Record<string, unknown>).actionCount ?? 0),
    wrongTarget: Number((window as unknown as Record<string, unknown>).wrongTarget ?? 0),
    originalClicks: Number((window as unknown as Record<string, unknown>).originalClicks ?? 0),
    replacementClicks: Number(
      (window as unknown as Record<string, unknown>).replacementClicks ?? 0,
    ),
    checkedCount: document.querySelectorAll("input:checked").length,
    selectedPublicValues: Array.from(document.querySelectorAll("select"))
      .map((item) => (item as HTMLSelectElement).value)
      .slice(0, 20),
  }));
}

await main();
process.exit(process.exitCode ?? 0);
