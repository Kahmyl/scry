import { once } from "node:events";
import { createServer, type Server } from "node:http";

export type AdaptiveFixture = {
  origin: string;
  snapshot(): AdaptiveFixtureSnapshot;
  close(): Promise<void>;
};

export type AdaptiveFixtureSnapshot = {
  protectedDispatches: {
    readonlyInput: number;
    textOutput: number;
    interruptedAcquisition: number;
  };
};

export type AdaptiveFixtureOptions = {
  protectedValue?: string;
  interruptedRevealDelayMs?: number;
};

export async function startAdaptiveFixture(
  port = 0,
  advertisedHost = "127.0.0.1",
  options: AdaptiveFixtureOptions = {},
): Promise<AdaptiveFixture> {
  const protectedValue = options.protectedValue ?? "fixture-protected-value";
  const interruptedRevealDelayMs = options.interruptedRevealDelayMs ?? 5_000;
  const protectedDispatches = {
    readonlyInput: 0,
    textOutput: 0,
    interruptedAcquisition: 0,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (url.pathname === "/details") {
      response.end(detailsPage());
      return;
    }
    if (url.pathname === "/protected/readonly-input") {
      response.end(protectedReadonlyInputPage(protectedValue));
      return;
    }
    if (url.pathname === "/protected/text-output") {
      response.end(protectedTextOutputPage(protectedValue));
      return;
    }
    if (url.pathname === "/protected/interrupted-acquisition") {
      response.end(protectedInterruptedAcquisitionPage(protectedValue, interruptedRevealDelayMs));
      return;
    }
    if (url.pathname === "/protected/dispatch" && request.method === "POST") {
      const campaign = url.searchParams.get("campaign");
      if (campaign === "readonly-input") protectedDispatches.readonlyInput += 1;
      else if (campaign === "text-output") protectedDispatches.textOutput += 1;
      else if (campaign === "interrupted-acquisition")
        protectedDispatches.interruptedAcquisition += 1;
      else {
        response.statusCode = 400;
        response.end("invalid campaign");
        return;
      }
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    response.end(fixturePage());
  });
  server.listen(port, advertisedHost === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CAMPAIGN_FIXTURE_BIND_FAILED");
  return {
    origin: `http://${advertisedHost}:${address.port}`,
    snapshot: () => ({ protectedDispatches: { ...protectedDispatches } }),
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  server.close();
  return once(server, "close").then(() => undefined);
}

function fixturePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Adaptive fixture</title></head>
<body>
  <main>
    <h1>Adaptive execution fixture</h1>
    <label>Email <input name="email" type="email" autocomplete="username"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password"></label>
    <button id="login" type="button">Sign in</button>
    <div id="malformed" role="button" tabindex="0">Open controls</div>
    <div id="dropdown" role="combobox" tabindex="0" aria-expanded="false">Choose environment</div>
    <div id="options" role="listbox" hidden><div role="option" data-value="test">Test Mode</div></div>
    <button id="continue" type="button" disabled>Continue</button>
    <output id="result" aria-live="polite"></output>
  </main>
  <script>
    const login = document.querySelector('#login');
    const malformed = document.querySelector('#malformed');
    const dropdown = document.querySelector('#dropdown');
    const options = document.querySelector('#options');
    const proceed = document.querySelector('#continue');
    login.addEventListener('click', () => {
      document.body.dataset.authenticated = 'true';
      document.querySelector('main').insertAdjacentHTML('beforeend', '<h2>Partner Portal</h2>');
    });
    malformed.addEventListener('click', () => document.body.dataset.controls = 'open');
    dropdown.addEventListener('click', () => { options.hidden = false; dropdown.setAttribute('aria-expanded', 'true'); });
    options.addEventListener('click', () => {
      options.hidden = true;
      dropdown.textContent = 'Test Mode';
      dropdown.setAttribute('aria-expanded', 'false');
      setTimeout(() => { proceed.disabled = false; }, 120);
    });
    proceed.addEventListener('click', () => { location.href = '/details'; });
  </script>
</body></html>`;
}

function detailsPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture details</title></head><body><main><h1>Execution complete</h1><p data-testid="deterministic-result">fixture-success</p></main></body></html>`;
}

function protectedReadonlyInputPage(protectedValue: string): string {
  return protectedFixturePage({
    title: "Readonly input acquisition",
    campaign: "readonly-input",
    reveal: `
      document.querySelector('#client-id').value = 'controlled-client-readonly';
      document.querySelector('#client-secret').value = ${jsonScriptValue(protectedValue)};
      document.querySelector('#outputs').hidden = false;`,
    outputs: `
      <section id="outputs" aria-label="Generated credential" hidden>
        <label>Client ID <input id="client-id" type="text" readonly></label>
        <label>Client secret <input id="client-secret" type="text" readonly></label>
      </section>`,
  });
}

function protectedTextOutputPage(protectedValue: string): string {
  return protectedFixturePage({
    title: "Text output acquisition",
    campaign: "text-output",
    reveal: `
      document.querySelector('#client-id').textContent = 'controlled-client-text';
      document.querySelector('#client-secret').textContent = ${jsonScriptValue(protectedValue)};
      document.querySelector('#outputs').hidden = false;`,
    outputs: `
      <section id="outputs" aria-label="Generated credential" hidden>
        <div role="text" aria-label="Client ID" id="client-id"></div>
        <div role="text" aria-label="Client secret" id="client-secret"></div>
        <button type="button" aria-label="Copy client secret">Copy</button>
      </section>`,
  });
}

function protectedInterruptedAcquisitionPage(
  protectedValue: string,
  revealDelayMs: number,
): string {
  return protectedFixturePage({
    title: "Interrupted acquisition",
    campaign: "interrupted-acquisition",
    reveal: `setTimeout(() => {
      document.querySelector('#client-id').value = 'controlled-client-interrupted';
      document.querySelector('#client-secret').value = ${jsonScriptValue(protectedValue)};
      document.querySelector('#outputs').hidden = false;
    }, ${Math.max(0, Math.trunc(revealDelayMs))});`,
    outputs: `
      <section id="outputs" aria-label="Generated credential" hidden>
        <label>Client ID <input id="client-id" type="text" readonly></label>
        <label>Client secret <input id="client-secret" type="text" readonly></label>
      </section>`,
  });
}

function protectedFixturePage(input: {
  title: string;
  campaign: "readonly-input" | "text-output" | "interrupted-acquisition";
  reveal: string;
  outputs: string;
}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${input.title}</title></head>
<body><main>
  <h1>${input.title}</h1>
  <label>Credential name <input id="credential-name" type="text"></label>
  <label>Environment <select id="environment"><option value="test">Test</option><option value="live">Live</option></select></label>
  <button id="generate" type="button">Generate credential</button>
  ${input.outputs}
  <table aria-label="Post-acquisition status"><tbody>
    <tr role="link" tabindex="0"><td>Post-acquisition continuity</td><td>Ready</td></tr>
  </tbody></table>
</main><script>
  document.querySelector('#generate').addEventListener('click', async () => {
    await fetch('/protected/dispatch?campaign=${input.campaign}', { method: 'POST' });
    ${input.reveal}
  }, { once: true });
</script></body></html>`;
}

function jsonScriptValue(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
