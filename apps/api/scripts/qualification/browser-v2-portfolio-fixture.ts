import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Journey = "vitract" | "inventory" | "nested" | "async" | "workspace";
type State = {
  mutations: Record<string, number>;
  reads: number;
  statusPolls: number;
  ids: Record<string, string>;
  secrets: Record<string, string>;
  authenticated: boolean;
};

const host = process.env.BROWSER_V2_FIXTURE_HOST ?? "127.0.0.1";
const port = Number(process.env.BROWSER_V2_FIXTURE_PORT ?? 4130);
const states = new Map<string, State>();

const server = createServer((request, response) => void route(request, response));
server.listen(port, host, () =>
  process.stdout.write(`${JSON.stringify({ ready: true, origin: `http://${host}:${port}` })}\n`),
);

async function route(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "__oracle" && parts[1] && parts[2])
      return oracle(response, parts[1] as Journey, parts[2]);
    const journey = parts[0] as Journey | undefined;
    const namespace = parts[1];
    if (
      !journey ||
      !namespace ||
      !["vitract", "inventory", "nested", "async", "workspace"].includes(journey)
    )
      return notFound(response);
    const state = fixtureState(journey, namespace);
    return await journeyRoute(journey, namespace, parts.slice(2), state, request, response, url);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "fixture_failure" });
  }
}

async function journeyRoute(
  journey: Journey,
  namespace: string,
  parts: string[],
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (journey === "vitract") return vitract(namespace, parts, state, request, response);
  if (journey === "inventory") return inventory(namespace, parts, state, request, response, url);
  if (journey === "nested") return nested(namespace, parts, state, request, response, url);
  if (journey === "async") return asynchronous(namespace, parts, state, request, response);
  return workspace(namespace, parts, state, request, response);
}

async function vitract(
  ns: string,
  parts: string[],
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const root = `/vitract/${ns}`;
  const path = `/${parts.join("/")}`;
  if (request.method === "GET" && path === "/")
    return html(
      response,
      page(
        "Vitract Preview",
        `
    <main><h1>Vitract Preview/Test</h1><p>Sign in before managing applications.</p>
    <label>Email<input aria-label="Email" id="email"></label><label>Password<input aria-label="Password" type="password" id="password"></label>
    <button id="login">Log in</button><section aria-live="polite" id="login-status"></section></main>
    <script>document.getElementById('login').onclick=async()=>{const email=document.getElementById('email');const password=document.getElementById('password');const r=await fetch('${root}/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value,password:password.value})});if(r.ok){document.getElementById('login-status').innerHTML='<a href="${root}/applications">Applications</a>'}}</script>`,
      ),
    );
  if (request.method === "POST" && path === "/api/login") {
    const body = (await jsonBody(request)) as Record<string, string>;
    if (body.email !== "operator@example.test" || body.password !== "fixture-login-pass")
      return json(response, 403, { code: "invalid_login" });
    state.authenticated = true;
    bump(state, "login");
    return json(response, 200, { state: "authenticated" });
  }
  if (request.method === "GET" && path === "/applications")
    return html(
      response,
      page(
        "Applications",
        `
    <main><h1>Applications</h1><p>Application: vitract-preview-test</p><button id="issue">Add credentials</button><section aria-live="polite" id="result"></section></main>
    <script>issue.onclick=async()=>{const r=await fetch('${root}/api/credentials',{method:'POST'});const x=(await r.json()).result;result.innerHTML='<dialog open aria-label="Generated credentials"><span aria-label="Credential ID">'+x.application.credential_id+'</span><span aria-label="Client ID">'+x.application.client_identifier+'</span><span aria-label="Client secret">'+x.grants[0].value+'</span><a href="${root}/docs">API documentation</a></dialog>'}</script>`,
      ),
    );
  if (request.method === "POST" && path === "/api/credentials") {
    if (!state.authenticated) return json(response, 401, { code: "login_required" });
    bump(state, "credential");
    return json(response, 201, {
      result: {
        application: {
          credential_id: state.ids.credentialId,
          client_identifier: state.ids.clientId,
        },
        grants: [{ kind: "client_secret", value: state.secrets.clientSecret }],
      },
    });
  }
  if (request.method === "GET" && path === "/docs")
    return html(
      response,
      page(
        "API documentation",
        `
    <main><h1>Create and retrieve test orders</h1><p>Create endpoint: POST ${root}/api/orders. Response: {data:{order_id,state}}.</p>
    <label>Client ID<input aria-label="Client ID" id="client"></label><label>Client secret<input aria-label="Client secret" type="password" id="secret"></label>
    <label>Reference<input aria-label="Reference" id="reference" value="qualification-order"></label><button id="create">Create order</button><section aria-live="polite" id="created"></section></main>
    <script>create.onclick=async()=>{const r=await fetch('${root}/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:client.value,clientSecret:secret.value,reference:reference.value})});const x=(await r.json()).data;if(r.ok)created.innerHTML='<p>Order '+x.order_id+' '+x.state+'</p><a href="${root}/retrieve">Retrieve order</a>'}</script>`,
      ),
    );
  if (request.method === "POST" && path === "/api/orders") {
    const body = (await jsonBody(request)) as Record<string, string>;
    if (body.clientId !== state.ids.clientId || body.clientSecret !== state.secrets.clientSecret)
      return json(response, 403, { code: "credential_mismatch" });
    bump(state, "order");
    return json(response, 201, {
      data: { order_id: state.ids.orderId, state: "completed", reference: body.reference },
    });
  }
  if (request.method === "GET" && path === "/retrieve")
    return html(
      response,
      page(
        "Retrieve order",
        `
    <main><h1>Retrieve exact order</h1><label>Order ID<input aria-label="Order ID" id="order"></label><button id="retrieve">Retrieve</button><section aria-live="polite" id="found"></section></main>
    <script>retrieve.onclick=async()=>{const r=await fetch('${root}/api/orders/'+encodeURIComponent(order.value));const x=await r.json();found.textContent=r.ok?('Order '+x.data.order_id+' '+x.data.state):'Not found'}</script>`,
      ),
    );
  if (request.method === "GET" && parts[0] === "api" && parts[1] === "orders" && parts[2]) {
    state.reads += 1;
    return parts[2] === state.ids.orderId
      ? json(response, 200, { data: { order_id: state.ids.orderId, state: "completed" } })
      : json(response, 404, { code: "not_found" });
  }
  return notFound(response);
}

async function inventory(
  ns: string,
  parts: string[],
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const root = `/inventory/${ns}`;
  const path = `/${parts.join("/")}`;
  if (request.method === "GET" && path === "/")
    return html(
      response,
      page(
        "Inventory documentation",
        `<main><h1>Inventory API guide</h1><p>Create: POST ${root}/api/stock. Required field sku. Response path record.stock_id. Retrieve: GET ${root}/api/stock/{stock_id}.</p><a href="${root}/console">Open inventory console</a></main>`,
      ),
    );
  if (request.method === "GET" && path === "/console")
    return html(
      response,
      page(
        "Inventory console",
        `<main><label>SKU<input aria-label="SKU" id="sku" value="SKU-${ns.slice(0, 6)}"></label><button id="create">Create stock item</button><label>Stock ID<input aria-label="Stock ID" id="id"></label><button id="get">Retrieve stock item</button><section aria-live="polite" id="result"></section></main><script>create.onclick=async()=>{const r=await fetch('${root}/api/stock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sku:sku.value})});const x=await r.json();result.textContent='Created '+x.record.stock_id};get.onclick=async()=>{const r=await fetch('${root}/api/stock/'+encodeURIComponent(id.value));const x=await r.json();result.textContent=r.ok?('Retrieved '+x.record.stock_id+' '+x.record.sku):'Not found'}</script>`,
      ),
    );
  if (request.method === "POST" && path === "/api/stock") {
    const body = (await jsonBody(request)) as Record<string, string>;
    if (!body.sku) return json(response, 400, { code: "sku_required" });
    bump(state, "stock");
    state.ids.sku = body.sku;
    return json(response, 201, { record: { stock_id: state.ids.stockId, sku: body.sku } });
  }
  if (request.method === "GET" && parts[0] === "api" && parts[1] === "stock" && parts[2]) {
    state.reads += 1;
    return parts[2] === state.ids.stockId
      ? json(response, 200, { record: { stock_id: state.ids.stockId, sku: state.ids.sku } })
      : json(response, 404, { code: "not_found", requested: url.pathname });
  }
  return notFound(response);
}

async function nested(
  ns: string,
  parts: string[],
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const root = `/nested/${ns}`;
  const path = `/${parts.join("/")}`;
  if (request.method === "GET" && path === "/")
    return html(
      response,
      page(
        "Collections",
        `<main><h1>Collection resource tool</h1><p>Create one resource with marker exact-${ns.slice(0, 6)}. The response contains candidates; correlate by marker. Retrieve the resulting resource ID.</p><label>Marker<input aria-label="Marker" id="marker" value="exact-${ns.slice(0, 6)}"></label><button id="create">Create resource</button><label>Resource ID<input aria-label="Resource ID" id="id"></label><button id="get">Retrieve resource</button><section aria-live="polite" id="result"></section></main><script>create.onclick=async()=>{const r=await fetch('${root}/api/resources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({marker:marker.value})});result.textContent='Creation response received'};get.onclick=async()=>{const r=await fetch('${root}/api/resources/'+encodeURIComponent(id.value));const x=await r.json();result.textContent=r.ok?('Retrieved '+x.payload.resource.uuid+' '+x.payload.resource.marker):'Not found'}</script>`,
      ),
    );
  if (request.method === "POST" && path === "/api/resources") {
    const body = (await jsonBody(request)) as Record<string, string>;
    if (!body.marker) return json(response, 400, { code: "marker_required" });
    bump(state, "resource");
    state.ids.marker = body.marker;
    return json(response, 201, {
      envelope: {
        candidates: [
          { uuid: `decoy-${ns}`, marker: "other" },
          {
            uuid: state.ids.resourceId,
            marker: body.marker,
            attributes: [{ name: "state", value: "ready" }],
          },
          { uuid: `stale-${ns}`, marker: body.marker + "-old" },
        ],
      },
    });
  }
  if (request.method === "GET" && parts[0] === "api" && parts[1] === "resources" && parts[2]) {
    state.reads += 1;
    return parts[2] === state.ids.resourceId
      ? json(response, 200, {
          payload: { resource: { uuid: state.ids.resourceId, marker: state.ids.marker } },
        })
      : json(response, 404, { code: "not_found", requested: url.pathname });
  }
  return notFound(response);
}

async function asynchronous(
  ns: string,
  parts: string[],
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const root = `/async/${ns}`;
  const path = `/${parts.join("/")}`;
  if (request.method === "GET" && path === "/")
    return html(
      response,
      page(
        "Provisioning",
        `<main><h1>Provisioning guide</h1><p>Submit exactly once. Poll the documented status button until ready (maximum five polls), capture the protected access token from the result dialog, then activate the workspace.</p><button id="submit">Submit provisioning</button><button id="poll" hidden>Check documented status</button><section aria-live="polite" id="result"></section><label>Access token<input aria-label="Access token" type="password" id="token"></label><button id="activate">Activate workspace</button></main><script>let job='';submit.onclick=async()=>{const r=await fetch('${root}/api/provision',{method:'POST'});const x=await r.json();job=x.job.id;poll.hidden=false;result.textContent='Pending '+job};poll.onclick=async()=>{const r=await fetch('${root}/api/status/'+job);const x=await r.json();if(x.state==='ready')result.innerHTML='<dialog open aria-label="Provisioned access"><span aria-label="Workspace ID">'+x.workspace.id+'</span><span aria-label="Access token">'+x.workspace.access_token+'</span></dialog>';else result.textContent='Pending '+job};activate.onclick=async()=>{const r=await fetch('${root}/api/activate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token.value})});result.textContent=r.ok?'Activated':'Denied'}</script>`,
      ),
    );
  if (request.method === "POST" && path === "/api/provision") {
    bump(state, "submit");
    return json(response, 202, {
      job: { id: state.ids.jobId, status_path: `${root}/api/status/${state.ids.jobId}` },
    });
  }
  if (
    request.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "status" &&
    parts[2] === state.ids.jobId
  ) {
    state.reads += 1;
    state.statusPolls += 1;
    return state.statusPolls < 3
      ? json(response, 200, { state: "pending", job_id: state.ids.jobId })
      : json(response, 200, {
          state: "ready",
          workspace: { id: state.ids.workspaceId, access_token: state.secrets.accessToken },
        });
  }
  if (request.method === "POST" && path === "/api/activate") {
    const body = (await jsonBody(request)) as Record<string, string>;
    if (body.token !== state.secrets.accessToken) return json(response, 403, { state: "denied" });
    bump(state, "activate");
    return json(response, 200, { state: "active", workspace_id: state.ids.workspaceId });
  }
  return notFound(response);
}

async function workspace(
  ns: string,
  parts: string[],
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const root = `/workspace/${ns}`;
  const path = `/${parts.join("/")}`;
  if (request.method === "GET" && path === "/")
    return html(
      response,
      page(
        "Browser workspace",
        `<main><h1>Browser-only workspace</h1><p>Create one workspace. The one-time recovery code exists only in the result dialog. Capture it, use it in the confirmation field, and verify completion.</p><label>Name<input aria-label="Workspace name" id="name" value="Workspace ${ns.slice(0, 6)}"></label><button id="create">Create workspace</button><section aria-live="polite" id="result"></section><label>Recovery code<input aria-label="Recovery code" type="password" id="code"></label><button id="confirm">Confirm workspace</button></main><script>document.getElementById('create').onclick=async()=>{const r=await fetch('${root}/submit',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'name='+encodeURIComponent(document.getElementById('name').value)});if(r.ok)document.getElementById('result').innerHTML='<dialog open aria-label="One-time workspace result"><span aria-label="Workspace ID">${state.ids.workspaceId}</span><span aria-label="Recovery code">${state.secrets.recoveryCode}</span></dialog>'};document.getElementById('confirm').onclick=async()=>{const r=await fetch('${root}/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value})});document.getElementById('result').textContent=r.ok?'Workspace verified':'Denied'}</script>`,
      ),
    );
  if (request.method === "POST" && path === "/submit") {
    bump(state, "create");
    return json(response, 200, { ok: true });
  }
  if (request.method === "POST" && path === "/confirm") {
    const body = (await jsonBody(request)) as Record<string, string>;
    if (body.code !== state.secrets.recoveryCode) return json(response, 403, { verified: false });
    bump(state, "confirm");
    return json(response, 200, { verified: true, workspace_id: state.ids.workspaceId });
  }
  return notFound(response);
}

function fixtureState(journey: Journey, namespace: string): State {
  const key = `${journey}:${namespace}`;
  const existing = states.get(key);
  if (existing) return existing;
  const id = (name: string) =>
    `${name}-${createHash("sha256")
      .update(key + name)
      .digest("hex")
      .slice(0, 12)}`;
  const state: State = {
    mutations: {},
    reads: 0,
    statusPolls: 0,
    authenticated: false,
    ids: {
      credentialId: id("cred"),
      clientId: id("client"),
      orderId: id("order"),
      stockId: id("stock"),
      resourceId: id("resource"),
      jobId: id("job"),
      workspaceId: id("workspace"),
    },
    secrets: {
      clientSecret: `secret_${randomUUID().replaceAll("-", "")}`,
      accessToken: `token_${randomUUID().replaceAll("-", "")}`,
      recoveryCode: `secret_${randomUUID().replaceAll("-", "")}`,
    },
  };
  states.set(key, state);
  return state;
}

function oracle(response: ServerResponse, journey: Journey, namespace: string) {
  const state = fixtureState(journey, namespace);
  json(response, 200, {
    journey,
    namespace,
    mutations: state.mutations,
    reads: state.reads,
    statusPolls: state.statusPolls,
    ids: state.ids,
    secretDigests: Object.fromEntries(
      Object.entries(state.secrets).map(([key, value]) => [
        key,
        createHash("sha256").update(value).digest("hex"),
      ]),
    ),
  });
}

function bump(state: State, name: string) {
  state.mutations[name] = (state.mutations[name] ?? 0) + 1;
}
function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}
function html(response: ServerResponse, body: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
function notFound(response: ServerResponse) {
  return json(response, 404, { code: "not_found" });
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
