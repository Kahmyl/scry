import { crossShapePage } from "./thin-cross-shape-pages.js";
/** Qualification-only external network boundary. No Scry component or result is replaced. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

export function configureShadowBrowserNetwork(proxyUrl: string) {
  const url = new URL(proxyUrl);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
    throw new Error("SHADOW_PROXY_MUST_BE_LOOPBACK");
  // Only Chromium's external network configuration changes. Browser allocation,
  // Page lifecycle, selectors, policy, supervisor and kernel stay production.
  const launchServer = chromium.launchServer.bind(chromium);
  chromium.launchServer = (options = {}) =>
    launchServer({
      ...options,
      proxy: { server: proxyUrl },
      args: [
        ...(options.args ?? []),
        "--ignore-certificate-errors",
        "--disable-background-networking",
      ],
    });
  const launch = chromium.launch.bind(chromium);
  chromium.launch = (options = {}) =>
    launch({
      ...options,
      proxy: { server: proxyUrl },
      args: [
        ...(options.args ?? []),
        "--ignore-certificate-errors",
        "--disable-background-networking",
      ],
    });
}

export async function startShadowVitractNetwork(options: { liveReadOnly?: boolean } = {}) {
  const certificateDirectory = await mkdtemp(path.join(tmpdir(), "scry-shadow-certificate-"));
  const key = path.join(certificateDirectory, "key.pem"),
    cert = path.join(certificateDirectory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=shadow-vitract.invalid",
    ],
    { stdio: "ignore" },
  );
  const credentials = new Map<string, { id: string; clientId: string; clientSecret: string }>();
  const orders = new Map<string, { id: string; payload: unknown }>();
  const idempotency = new Set<string>();
  const protectedCanaries = new Set<string>();
  let applicationScope = "unconfigured";
  let loginValues: { email: string; password: string } | undefined;
  const liveReads: Array<{ url: string; status: number; sha256: string }> = [];
  const authenticatedSessions = new Set<string>();
  const counters = {
    issuance: 0,
    create: 0,
    retrieve: 0,
    authenticatedRequests: 0,
    deniedEgress: 0,
    clientErrors: 0,
    createClicks: 0,
    retrieveClicks: 0,
  };
  const allowed = new Set(["preview.vitract.com", "preview-api.vitract.com"]);
  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `https://${request.headers.host}`);
    if (!allowed.has(url.hostname)) {
      counters.deniedEgress++;
      return json(response, 403, { code: "SHADOW_EGRESS_DENIED" });
    }
    const laboratory =
      /^\/laboratory\/(public|protected)\/(create|retrieve|items)(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
    if (laboratory) {
      const [, shape, stage, itemId] = laboratory;
      if (request.method === "GET" && (stage === "create" || stage === "retrieve"))
        return html(response, crossShapePage(shape as "public" | "protected", stage));
      if (shape === "protected" && request.headers["x-access-secret"] !== loginValues?.password)
        return json(response, 401, { code: "EXACT_PROTECTED_ACCESS_REQUIRED" });
      if (stage === "items" && request.method === "POST" && !itemId) {
        counters.create++;
        if (counters.create !== 1) return json(response, 409, { code: "DUPLICATE_CREATE" });
        const payload = await body(request),
          id = randomUUID();
        orders.set(id, { id, payload });
        return json(response, 201, { data: { id } });
      }
      if (stage === "items" && request.method === "GET" && itemId) {
        counters.retrieve++;
        const item = orders.get(itemId);
        return json(
          response,
          item ? 200 : 404,
          item ? { data: { id: item.id } } : { code: "NOT_FOUND" },
        );
      }
      return json(response, 405, { code: "METHOD_NOT_ALLOWED" });
    }
    // Only allowlisted public GET documents/assets go live, with NO incoming
    // cookies, credentials, auth headers or query strings. Never forward a mutation.
    const livePath =
      url.hostname === "preview-api.vitract.com"
        ? url.pathname.startsWith("/api/docs/")
        : url.pathname === "/login" ||
          url.pathname.startsWith("/assets/") ||
          url.pathname === "/favicon.ico";
    if (options.liveReadOnly && request.method === "GET" && livePath) {
      const target = `https://${url.hostname}${url.pathname}`;
      const upstream = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const { createHash } = await import("node:crypto");
      liveReads.push({
        url: target,
        status: upstream.status,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(bytes);
      return;
    }
    if (options.liveReadOnly && request.method === "GET" && url.pathname === "/experiment")
      return html(
        response,
        '<main><h1>Isolated effect workspace</h1><p>Public application and documentation are live read-only. Login here uses only shadow credentials and a shadow session.</p><a href="/login">Observe live Vitract login</a><a href="/experiment/login">Authenticate to shadow workspace</a><a href="https://preview-api.vitract.com/api/docs/partner-api">Live Partner API documentation</a></main>',
      );
    if (options.liveReadOnly && request.method === "GET" && url.pathname === "/experiment/login")
      return html(response, login(true));
    if (
      options.liveReadOnly &&
      request.method === "POST" &&
      url.pathname === "/experiment/authenticate"
    ) {
      const input = (await body(request)) as { email?: string; password?: string };
      if (
        !loginValues ||
        input.email !== loginValues.email ||
        input.password !== loginValues.password
      )
        return json(response, 401, { code: "SHADOW_LOGIN_REQUIRED" });
      const session = randomUUID();
      authenticatedSessions.add(session);
      response.setHeader(
        "set-cookie",
        `shadow-session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      );
      return json(response, 200, { authenticated: true });
    }
    if (request.method === "GET" && url.pathname === "/shadow-fixture-signal") {
      const event = url.searchParams.get("event");
      if (event === "client-error") counters.clientErrors++;
      if (event === "create") counters.createClicks++;
      if (event === "retrieve") counters.retrieveClicks++;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/")
      return html(
        response,
        '<main><h1>Partner workspace</h1><a href="https://preview-api.vitract.com/api/docs/partner-api">Partner API documentation</a><a href="https://preview.vitract.com/login">Login</a></main>',
      );
    if (request.method === "GET" && url.pathname === "/login") return html(response, login());
    if (request.method === "GET" && url.pathname === "/partner")
      return html(
        response,
        `<main><h1>Partner applications</h1><p>Shadow authenticated effect workspace</p><a href="/partner/developer/applications/${applicationScope}/credentials">Application credentials</a><a href="https://preview-api.vitract.com/api/docs/partner-api">Live Partner API documentation</a></main>`,
      );
    const credentialPage = /^\/partner\/developer\/applications\/([^/]+)\/credentials$/.exec(
      url.pathname,
    );
    if (request.method === "GET" && credentialPage)
      return html(response, issuancePage(credentialPage[1]!));
    if (
      request.method === "POST" &&
      /^\/api\/v1\/partners\/applications\/[^/]+\/credentials$/.test(url.pathname)
    ) {
      if (
        options.liveReadOnly &&
        ![...authenticatedSessions].some((id) =>
          request.headers.cookie?.includes(`shadow-session=${id}`),
        )
      )
        return json(response, 401, { code: "SHADOW_AUTHENTICATED_SESSION_REQUIRED" });
      counters.issuance++;
      if (counters.issuance !== 1)
        return json(response, 409, { code: "SHADOW_DUPLICATE_ISSUANCE" });
      await body(request);
      const credential = {
        id: randomUUID(),
        clientId: `shadow-client-${randomUUID()}`,
        clientSecret: `shadow-secret-${randomUUID()}`,
      };
      protectedCanaries.add(credential.clientSecret);
      credentials.set(credential.id, credential);
      return json(response, 201, credential);
    }
    if (request.method === "GET" && url.pathname === "/api/docs/partner-api")
      return html(response, docs());
    if (url.pathname.startsWith("/api/v1/partner-api/orders")) {
      const valid = [...credentials.values()].some(
        (credential) =>
          request.headers[options.liveReadOnly ? "x-vitract-client-id" : "x-client-id"] ===
            credential.clientId &&
          request.headers[options.liveReadOnly ? "x-vitract-client-secret" : "x-client-secret"] ===
            credential.clientSecret,
      );
      if (!valid) return json(response, 401, { code: "SHADOW_EXACT_GENERATED_PAIR_REQUIRED" });
      counters.authenticatedRequests++;
      if (request.method === "POST" && url.pathname === "/api/v1/partner-api/orders") {
        counters.create++;
        const token = String(request.headers["idempotency-key"] ?? "");
        if (!token || idempotency.has(token) || counters.create !== 1)
          return json(response, 409, { code: "SHADOW_CREATE_IDEMPOTENCY_REQUIRED" });
        protectedCanaries.add(token);
        idempotency.add(token);
        const payload = await body(request),
          id = randomUUID();
        protectedCanaries.add(JSON.stringify(payload));
        orders.set(id, { id, payload });
        return json(response, 201, { data: { id, status: "created" } });
      }
      const retrieve = /^\/api\/v1\/partner-api\/orders\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && retrieve) {
        counters.retrieve++;
        const order = orders.get(decodeURIComponent(retrieve[1]!));
        return json(
          response,
          order ? 200 : 404,
          order ? { data: { id: order.id, status: "created" } } : { code: "ORDER_NOT_FOUND" },
        );
      }
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    return json(response, 404, { code: "SHADOW_ROUTE_NOT_FOUND" });
  };
  const httpsServer = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      void route(request, response).catch(() =>
        json(response, 500, { code: "SHADOW_BOUNDARY_ERROR" }),
      );
    },
  );
  const proxy = createServer((request, response) => void route(request, response));
  const sockets = new Set<import("node:net").Socket>();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    // CONNECT hands the socket out of the HTTP parser. A peer resetting a
    // refused tunnel must end that connection, not terminate the effect oracle.
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, socket, head) => {
    if (!["preview.vitract.com:443", "preview-api.vitract.com:443"].includes(request.url ?? "")) {
      counters.deniedEgress++;
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    httpsServer.emit("connection", socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("SHADOW_PROXY_ADDRESS_MISSING");
  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    configureLogin: (input: { email: string; password: string; applicationScope: string }) => {
      loginValues = input;
      applicationScope = input.applicationScope;
      protectedCanaries.add(input.email);
      protectedCanaries.add(input.password);
    },
    liveReadEvidence: () => [...liveReads],
    counts: () => ({ ...counters }),
    // External fixture knows its own generated canaries; only counts leave here.
    countProtectedLeaks: (surfaces: string[]) => ({
      canaries: protectedCanaries.size,
      leaks: surfaces.reduce(
        (n, text) => n + [...protectedCanaries].filter((value) => text.includes(value)).length,
        0,
      ),
    }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

function login(authenticate = false) {
  if (authenticate)
    return `<main><h1>Shadow workspace login</h1><p>Protected shadow references only. This does not authenticate to real Vitract.</p><label>Enter your email<input id="email" aria-label="Enter your email" placeholder="Enter your email"></label><label>Password<input id="password" type="password" placeholder="Enter your password"></label><button id="login">Login</button><output id="status"></output></main><script>login.onclick=async()=>{const r=await fetch('/experiment/authenticate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value,password:password.value})});if(r.ok)location.href='/partner';else document.getElementById('status').textContent='Login refused'}</script>`;
  return `<main><h1>Vitract Preview</h1><label>Enter your email<input aria-label="Enter your email" placeholder="Enter your email"></label><label>Password<input type="password" placeholder="Enter your password"></label><button id="login">Login</button></main><script>login.onclick=()=>location.href='/partner'</script>`;
}
function issuancePage(application: string) {
  return `<main><h1>Application credentials</h1><section id="launcher"><button id="open">Add credential</button></section><dialog id="credential-dialog"><form method="dialog"><h2>Add credential</h2><label>Name<input name="name" aria-label="Name"></label><button id="issue" type="button">Add credential</button><output aria-label="Credential status"></output></form></dialog></main><script>document.getElementById('open').onclick=()=>{document.getElementById('launcher').hidden=true;document.getElementById('credential-dialog').showModal()};document.getElementById('issue').onclick=async()=>{const response=await fetch('/api/v1/partners/applications/'+${JSON.stringify(application)}+'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.querySelector('[name=name]').value})});const result=await response.json();document.querySelector('output').textContent=response.status+' '+result.id}</script>`;
}
function docs() {
  return `<main><h1>Partner API</h1><section aria-label="Create Order"><h2>Create Order</h2><label>Client ID<input id="create-client-id" aria-label="Client ID"></label><label>Client secret<input id="create-client-secret" type="password" aria-label="Client secret"></label><label>Idempotency-Key<input id="idempotency" aria-label="Idempotency-Key"></label><label>JSON body<textarea id="payload" aria-label="JSON body"></textarea></label><button id="create">Run POST</button><output id="created"></output></section><section aria-label="Retrieve Order examples"><h2>Retrieve Order examples</h2><label>Client ID<input id="retrieve-client-id" aria-label="Client ID"></label><label>Client secret<input id="retrieve-client-secret" type="password" aria-label="Client secret"></label><label>orderId<input id="identity" aria-label="orderId"></label><button id="retrieve">Run</button><output id="retrieved"></output></section></main><script>const field=(id)=>document.getElementById(id).value;document.getElementById('create').onclick=async()=>{const r=await fetch('/api/v1/partner-api/orders',{method:'POST',headers:{'content-type':'application/json','x-client-id':field('create-client-id'),'x-client-secret':field('create-client-secret'),'idempotency-key':field('idempotency')},body:field('payload')});const v=await r.json();document.getElementById('created').textContent=r.status+' '+(v.data?.id??'')};document.getElementById('retrieve').onclick=async()=>{const r=await fetch('/api/v1/partner-api/orders/'+encodeURIComponent(field('identity')),{headers:{'x-client-id':field('retrieve-client-id'),'x-client-secret':field('retrieve-client-secret')}});const v=await r.json();document.getElementById('retrieved').textContent=r.status+' '+(v.data?.id??'')}</script>`;
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("SHADOW_BODY_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function html(response: ServerResponse, value: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    `<!doctype html><html><body><script>const shadowSignal=(event)=>{const pixel=new Image();pixel.src='/shadow-fixture-signal?event='+event};addEventListener('error',()=>shadowSignal('client-error'));document.addEventListener('click',event=>{if(['create','retrieve'].includes(event.target.id))shadowSignal(event.target.id)},true)</script>${value}</body></html>`,
  );
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
