import { once } from "node:events";
import { createServer, type Server } from "node:http";

export type AdaptiveFixture = {
  origin: string;
  close(): Promise<void>;
};

export async function startAdaptiveFixture(port = 0): Promise<AdaptiveFixture> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (url.pathname === "/details") {
      response.end(detailsPage());
      return;
    }
    response.end(fixturePage());
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CAMPAIGN_FIXTURE_BIND_FAILED");
  return {
    origin: `http://127.0.0.1:${address.port}`,
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
    login.addEventListener('click', () => document.body.dataset.authenticated = 'true');
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
