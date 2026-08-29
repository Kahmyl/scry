import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Q3EvidenceMode, Q3FixtureMode, Q3OracleResource, Q3OracleTruth } from "./types.js";

export type Q3FixtureConfig = Readonly<{
  seed: number;
  mode: Q3FixtureMode;
  evidenceMode: Q3EvidenceMode;
  username: string;
  password: string;
  duplicateDelivery?: boolean;
  acknowledgementDelayMs?: number;
}>;

export type Q3Fixture = Readonly<{
  origin: string;
  docsUrl: string;
  appUrl: string;
  generation: number;
  readGroundTruth(): Q3OracleTruth;
  controlNegativeProbe(): Promise<{ ordinaryStatus: number; unauthenticatedControlStatus: number }>;
  close(): Promise<void>;
}>;

type MutableTruth = {
  generation: number;
  mutationRequests: Array<{
    idempotencyKey: string;
    operationCorrelation: string | null;
    mode: Q3FixtureMode;
    committed: boolean;
    response: "normal" | "delayed" | "dropped";
    receivedSequence: number;
    acknowledgedSequence: number | null;
  }>;
  resources: Q3OracleResource[];
  retrievalCount: number;
  authenticationSuccessCount: number;
  documentGeneration: number;
  targetReplacementCount: number;
  workerRequestCount: number;
  evidenceMode: Q3EvidenceMode;
  cleanupRequests: number;
  cleanupEffects: number;
  eventSequence: number;
};

export async function startQ3Fixture(config: Q3FixtureConfig): Promise<Q3Fixture> {
  const capability = randomBytes(32).toString("hex");
  const sessions = new Set<string>();
  const truth: MutableTruth = {
    generation: config.seed,
    mutationRequests: [],
    resources: [],
    retrievalCount: 0,
    authenticationSuccessCount: 0,
    documentGeneration: 1,
    targetReplacementCount: 0,
    workerRequestCount: 0,
    evidenceMode: config.evidenceMode,
    cleanupRequests: 0,
    cleanupEffects: 0,
    eventSequence: 0,
  };
  const app = createServer((request, response) => {
    void handleApp(request, response, config, truth, sessions);
  });
  const control = createServer((request, response) => {
    if (request.url !== "/__truth") return response.writeHead(404).end();
    if (request.headers.authorization !== `Bearer ${capability}`)
      return response.writeHead(403).end();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(snapshot(truth)));
  });
  await Promise.all([listen(app), listen(control)]);
  const appOrigin = origin(app);
  const controlOrigin = origin(control);
  return {
    origin: appOrigin,
    docsUrl: `${appOrigin}/docs`,
    appUrl: `${appOrigin}/app`,
    generation: truth.generation,
    readGroundTruth: () => snapshot(truth),
    async controlNegativeProbe() {
      const [ordinary, unauthenticated] = await Promise.all([
        fetch(`${appOrigin}/__truth`),
        fetch(`${controlOrigin}/__truth`),
      ]);
      return {
        ordinaryStatus: ordinary.status,
        unauthenticatedControlStatus: unauthenticated.status,
      };
    },
    async close() {
      await Promise.all([close(app), close(control)]);
    },
  };
}

async function handleApp(
  request: IncomingMessage,
  response: ServerResponse,
  config: Q3FixtureConfig,
  truth: MutableTruth,
  sessions: Set<string>,
) {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (request.method === "GET" && url.pathname === "/")
    return html(
      response,
      `<main><h1>Local qualification application</h1><a href="/docs">Open application documentation</a></main>`,
    );
  if (request.method === "GET" && url.pathname === "/docs")
    return html(
      response,
      `<main><h1>Local resource service</h1><p>Authenticate before reading or creating resources.</p><p>Create requires label, quantity, mode, and an Idempotency-Key. Retrieve with GET /api/resources/:id or /api/resources/by-idempotency/:key. The returned resource id is canonical. Evidence may be required or optional.</p><a href="/app">Open local resource application</a></main>`,
    );
  if (request.method === "GET" && url.pathname === "/worker.js") {
    response.setHeader("content-type", "application/javascript");
    return response.end(`fetch('/worker-data').then(r=>r.text()).then(()=>postMessage('ready'))`);
  }
  if (request.method === "GET" && url.pathname === "/worker-data") {
    truth.workerRequestCount += 1;
    return response.end("worker-ready");
  }
  if (request.method === "GET" && url.pathname === "/app") {
    truth.documentGeneration += 1;
    response.setHeader("content-type", "text/html; charset=utf-8");
    return response.end(appDocument(authenticated(request, sessions), config));
  }
  if (request.method === "POST" && url.pathname === "/auth") {
    const body = new URLSearchParams((await readBody(request)).toString("utf8"));
    if (body.get("username") !== config.username || body.get("password") !== config.password)
      return response.writeHead(401).end("Authentication failed");
    const session = randomBytes(18).toString("hex");
    sessions.add(session);
    truth.authenticationSuccessCount += 1;
    response.setHeader("set-cookie", `q3_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
    response.writeHead(303, { location: "/app" });
    return response.end();
  }
  if (!authenticated(request, sessions) && url.pathname.startsWith("/api/"))
    return response.writeHead(401).end();
  if (request.method === "GET" && url.pathname === "/api/resources") {
    truth.retrievalCount += 1;
    return json(response, { resources: truth.resources });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/resources/by-idempotency/")) {
    truth.retrievalCount += 1;
    if (config.mode === "STILL_AMBIGUOUS") return response.writeHead(503).end();
    const key = decodeURIComponent(url.pathname.slice("/api/resources/by-idempotency/".length));
    const resource = truth.resources.find((candidate) => candidate.idempotencyKey === key);
    return resource ? json(response, resource) : response.writeHead(404).end();
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/resources/")) {
    truth.retrievalCount += 1;
    const id = decodeURIComponent(url.pathname.slice("/api/resources/".length));
    const resource = truth.resources.find((candidate) => candidate.id === id);
    return resource ? json(response, resource) : response.writeHead(404).end();
  }
  if (request.method === "POST" && url.pathname === "/api/resources") {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key)
      return response.writeHead(400).end("Idempotency-Key required");
    const payload = JSON.parse((await readBody(request)).toString("utf8")) as {
      label: string;
      quantity: number;
    };
    const existing = truth.resources.find((resource) => resource.idempotencyKey === key);
    const committed = config.mode !== "NO_COMMIT_DROP" && config.mode !== "STILL_AMBIGUOUS";
    const responseKind: "normal" | "delayed" | "dropped" = [
      "DROP_ACK_AFTER_COMMIT",
      "NO_COMMIT_DROP",
      "STILL_AMBIGUOUS",
    ].includes(config.mode)
      ? "dropped"
      : config.mode === "DELAYED_ACK"
        ? "delayed"
        : "normal";
    const mutationRequest: MutableTruth["mutationRequests"][number] = {
      idempotencyKey: key,
      operationCorrelation:
        typeof request.headers["x-operation-correlation"] === "string"
          ? request.headers["x-operation-correlation"]
          : null,
      mode: config.mode,
      committed,
      response: responseKind,
      receivedSequence: ++truth.eventSequence,
      acknowledgedSequence: null,
    };
    truth.mutationRequests.push(mutationRequest);
    let resource = existing;
    if (committed && !resource) {
      resource = {
        id: `resource-${config.seed}-${truth.resources.length + 1}`,
        label: payload.label,
        quantity: payload.quantity,
        state: "active",
        idempotencyKey: key,
      };
      truth.resources.push(resource);
    }
    if (responseKind === "dropped") {
      response.writeHead(existing ? 200 : 201, {
        "content-type": "application/json",
        "content-length": "128",
      });
      response.flushHeaders();
      return response.socket?.destroy();
    }
    if (responseKind === "delayed")
      return setTimeout(() => {
        mutationRequest.acknowledgedSequence = ++truth.eventSequence;
        json(response, resource, existing ? 200 : 201);
      }, config.acknowledgementDelayMs ?? 30);
    mutationRequest.acknowledgedSequence = ++truth.eventSequence;
    return json(response, resource, existing ? 200 : 201);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/resources/")) {
    truth.cleanupRequests += 1;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return response.writeHead(400).end();
    const id = decodeURIComponent(url.pathname.slice("/api/resources/".length));
    const index = truth.resources.findIndex((resource) => resource.id === id);
    if (index < 0) return response.writeHead(404).end();
    if (truth.resources[index]!.state !== "revoked") {
      truth.resources[index] = { ...truth.resources[index]!, state: "revoked" };
      truth.cleanupEffects += 1;
    }
    return json(response, truth.resources[index]);
  }
  if (request.method === "POST" && url.pathname === "/fixture/replace-target") {
    truth.targetReplacementCount += 1;
    return response.writeHead(204).end();
  }
  response.writeHead(404).end();
}

function appDocument(isAuthenticated: boolean, config: Q3FixtureConfig): string {
  if (!isAuthenticated)
    return `<!doctype html><html><body><main><h1>Local resource login</h1><form method="post" action="/auth"><label>Username <input aria-label="Username" name="username" autocomplete="username"></label><label>Password <input aria-label="Password" name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form></main></body></html>`;
  return `<!doctype html><html><body><main><h1>Resources</h1><p id="loading">Loading</p><section id="app" hidden><label>Label <input aria-label="Label" value="fixture resource"></label><label>Quantity <input aria-label="Quantity" type="number" value="1"></label><button id="create">Create resource</button><button id="replace">Replace target</button><button id="cleanup" hidden>Cleanup resource</button><output id="result"></output><output id="cleanup-result"></output><ul id="resources"></ul><article id="detail"></article></section></main><script>
  const mode=${JSON.stringify(config.mode)}; const key='q3-key-${config.seed}';
  new Worker('/worker.js');
  const hydrate=async()=>{const data=await fetch('/api/resources').then(r=>r.json()); document.querySelector('#resources').textContent=JSON.stringify(data.resources); document.querySelector('#loading').remove(); document.querySelector('#app').hidden=false;};
  const createRequest=()=>fetch('/api/resources',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key,'x-operation-correlation':'q3-${config.seed}'},body:JSON.stringify({label:document.querySelector('[aria-label=Label]').value,quantity:Number(document.querySelector('[aria-label=Quantity]').value)})});
  document.querySelector('#create').addEventListener('click',async()=>{try{const responses=await Promise.all([createRequest()${config.duplicateDelivery ? ",createRequest()" : ""}]); const v=await responses[0].json(); document.querySelector('#result').textContent=v.id; document.querySelector('#cleanup').hidden=false; const project=()=>document.querySelector('#detail').textContent=JSON.stringify(v); if(mode==='RESPONSE_BEFORE_UI_PROJECTION') setTimeout(project,30); else project();}catch{document.querySelector('#result').textContent='UNKNOWN';}});
  document.querySelector('#cleanup').addEventListener('click',async()=>{const id=document.querySelector('#result').textContent; const r=await fetch('/api/resources/'+encodeURIComponent(id),{method:'DELETE',headers:{'idempotency-key':'q3-cleanup-${config.seed}'}}); const v=await r.json(); document.querySelector('#cleanup-result').textContent=v.state;});
  document.querySelector('#replace').addEventListener('pointerover',async(e)=>{const old=e.currentTarget; const replacement=old.cloneNode(true); replacement.id='replacement'; old.replaceWith(replacement); await fetch('/fixture/replace-target',{method:'POST'});});
  if(mode==='DELAYED_ACK') setTimeout(hydrate,30); else queueMicrotask(hydrate);
  </script></body></html>`;
}

function authenticated(request: IncomingMessage, sessions: Set<string>) {
  const cookie = request.headers.cookie ?? "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("q3_session="))
    ?.slice("q3_session=".length);
  return Boolean(token && sessions.has(token));
}

function snapshot(truth: MutableTruth): Q3OracleTruth {
  return Object.freeze({
    source: "independent_fixture_oracle" as const,
    generation: truth.generation,
    mutationRequests: truth.mutationRequests.map((request) => Object.freeze({ ...request })),
    resources: truth.resources.map((resource) => Object.freeze({ ...resource })),
    retrievalCount: truth.retrievalCount,
    authenticationSuccessCount: truth.authenticationSuccessCount,
    documentGeneration: truth.documentGeneration,
    targetReplacementCount: truth.targetReplacementCount,
    workerRequestCount: truth.workerRequestCount,
    evidenceMode: truth.evidenceMode,
    cleanupRequests: truth.cleanupRequests,
    cleanupEffects: truth.cleanupEffects,
  });
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, value: string) {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${value}</body></html>`,
  );
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

function origin(server: Server) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
}
