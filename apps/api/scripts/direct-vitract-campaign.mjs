const apiBase = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api";
const token = required("SCRY_SERVICE_TOKEN");
const projectId = required("SCRY_VITRACT_PROJECT_ID");
const environmentId = required("SCRY_VITRACT_ENVIRONMENT_ID");
const emailCredentialId = required("SCRY_VITRACT_EMAIL_CREDENTIAL_ID");
const passwordCredentialId = required("SCRY_VITRACT_PASSWORD_CREDENTIAL_ID");
const clientSecretCredentialId = required("SCRY_VITRACT_API_SECRET_CREDENTIAL_ID");
const clientId = required("SCRY_VITRACT_API_CLIENT_ID");
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const checks = [];
let sessionId;

try {
  const startedAt = performance.now();
  const started = await request("POST", "/direct-sessions", {
    projectId,
    environmentId,
    additionalOrigins: ["https://api.vitract.com", "https://preview-api.vitract.com"],
  });
  sessionId = started.sessionId;
  checks.push(check("session_started", started.state === "active", { durationMs: elapsed(startedAt) }));

  const login = await turn([
    credential("Enter your email", emailCredentialId),
    credential("Enter your password", passwordCredentialId),
    clickRole("Login"),
    { type: "waitForUrl", value: "/partner", match: "path" },
    { type: "navigate", url: "https://preview.vitract.com/partner/developer" },
    { type: "waitForElement", target: role("link", "Open API documentation (opens in a new tab)"), state: "visible" },
    { type: "click", target: role("link", "Open API documentation (opens in a new tab)") },
  ]);
  checks.push(check("login_and_docs", login.state === "active" && login.observation?.title === "Vitract Partner API Reference", { durationMs: login.durationMs }));

  const initialList = await runOperation("List Orders", "Run", "200", [
    fillSection("List Orders", "Client ID", clientId),
    fillSectionCredential("List Orders", "Client secret", clientSecretCredentialId),
  ]);
  checks.push(check("authenticated_list", initialList.status.startsWith("200"), { status: initialList.status }));

  const clientOrderBody = baseOrder({
    orderedFor: "client",
    deliveryMode: "dropship",
    client: { firstName: "Scry", lastName: "Client", email: `scry.client.${suffix}@example.test` },
  });
  const clientKey = `scry-client-${suffix}`;
  const clientOrder = await createOrder(clientOrderBody, clientKey, "201");
  checks.push(check("inline_client_order", clientOrder.status.startsWith("201") && Boolean(clientOrder.data?.id) && Boolean(clientOrder.data?.clientId), resource(clientOrder)));

  const replay = await createOrder(clientOrderBody, clientKey, "200");
  checks.push(check("idempotent_replay", replay.status.startsWith("200") && replay.data?.id === clientOrder.data?.id, resource(replay)));

  const conflict = await createOrder({ ...clientOrderBody, quantity: 2 }, clientKey, "409");
  checks.push(check("idempotency_conflict", conflict.status.startsWith("409"), { status: conflict.status, errorCode: conflict.body?.data?.errorCode }));

  const practitionerOrderBody = baseOrder({
    orderedFor: "practitioner",
    deliveryMode: "on_site",
    practitioner: { firstName: "Scry", lastName: "Practitioner", email: `scry.practitioner.${suffix}@example.test`, practiceName: "Scry Acceptance" },
  });
  const practitionerOrder = await createOrder(practitionerOrderBody, `scry-practitioner-${suffix}`, "201");
  checks.push(check("inline_practitioner_order", practitionerOrder.status.startsWith("201") && Boolean(practitionerOrder.data?.id) && Boolean(practitionerOrder.data?.practitionerId), resource(practitionerOrder)));

  const byClientId = await createOrder(baseOrder({ orderedFor: "client", deliveryMode: "dropship", clientId: clientOrder.data.clientId }), `scry-client-id-${suffix}`, "201");
  checks.push(check("existing_client_id_order", byClientId.status.startsWith("201") && byClientId.data?.clientId === clientOrder.data.clientId, resource(byClientId)));

  const byPractitionerId = await createOrder(baseOrder({ orderedFor: "practitioner", deliveryMode: "dropship", practitionerId: practitionerOrder.data.practitionerId }), `scry-practitioner-id-${suffix}`, "201");
  checks.push(check("existing_practitioner_id_order", byPractitionerId.status.startsWith("201") && byPractitionerId.data?.practitionerId === practitionerOrder.data.practitionerId, resource(byPractitionerId)));

  const retrieved = await runOperation("Retrieve Order", "Run", "200", [fillSection("Retrieve Order", "orderId", clientOrder.data.id)]);
  checks.push(check("retrieve_created_order", retrieved.status.startsWith("200") && retrieved.data?.id === clientOrder.data.id, resource(retrieved)));

  const filtered = await runOperation("List Orders", "Run", "200", [
    fillSection("List Orders", "page", "1"),
    fillSection("List Orders", "limit", "2"),
    fillSection("List Orders", "status", "pending-invoice"),
  ]);
  checks.push(check("list_filter_pagination", filtered.status.startsWith("200") && filtered.body?.data?.page === 1 && filtered.body?.data?.limit === 2, { status: filtered.status, count: filtered.body?.data?.count }));

  const missingIdentity = await createOrder(baseOrder({ orderedFor: "client", deliveryMode: "dropship" }), `scry-missing-${suffix}`, "400");
  checks.push(check("missing_identity_rejected", missingIdentity.status.startsWith("400"), { status: missingIdentity.status, errorCode: missingIdentity.body?.data?.errorCode }));

  const conflictingIdentity = await createOrder(baseOrder({ orderedFor: "client", deliveryMode: "dropship", clientId: clientOrder.data.clientId, client: { firstName: "Conflict", lastName: "Case", email: `conflict.${suffix}@example.test` } }), `scry-conflict-${suffix}`, "400");
  checks.push(check("conflicting_identity_rejected", conflictingIdentity.status.startsWith("400"), { status: conflictingIdentity.status, errorCode: conflictingIdentity.body?.data?.errorCode }));

  const nonexistent = await createOrder(baseOrder({ orderedFor: "client", deliveryMode: "dropship", clientId: "11111111-1111-4111-8111-111111111111" }), `scry-missing-id-${suffix}`, "404");
  checks.push(check("nonexistent_id_rejected", nonexistent.status.startsWith("404"), { status: nonexistent.status, errorCode: nonexistent.body?.data?.errorCode }));

  const forbiddenMode = await createOrder(baseOrder({ orderedFor: "client", deliveryMode: "on_site", clientId: clientOrder.data.clientId }), `scry-mode-${suffix}`, "400");
  checks.push(check("client_on_site_rejected", forbiddenMode.status.startsWith("400"), { status: forbiddenMode.status, errorCode: forbiddenMode.body?.data?.errorCode }));

  const invalidAuth = await runOperation("List Orders", "Run", "401", [fillSection("List Orders", "Client secret", "intentionally-invalid")]);
  checks.push(check("invalid_auth_rejected", invalidAuth.status.startsWith("401"), { status: invalidAuth.status, errorCode: invalidAuth.body?.data?.errorCode }));
  await turn([fillSectionCredential("List Orders", "Client secret", clientSecretCredentialId)]);

  const verdict = checks.every((entry) => entry.passed) ? "pass" : "fail";
  console.log(JSON.stringify({ schemaVersion: 1, target: "vitract_preview", mode: "test", verdict, checks }, null, 2));
  process.exitCode = verdict === "pass" ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, target: "vitract_preview", mode: "test", verdict: "fail", checks, failure: safeError(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (sessionId) await request("DELETE", `/direct-sessions/${sessionId}`).catch(() => undefined);
}

async function createOrder(body, idempotencyKey, expectedStatus) {
  return runOperation("Create Order", "Run POST", expectedStatus, [
    fillSection("Create Order", "JSON body", JSON.stringify(body), false),
    fillSection("Create Order", "Idempotency-Key", idempotencyKey),
    { type: "check", target: sectionRole("Create Order", "checkbox", "I understand this sends a real request that may create or change Partner data."), checked: true },
  ]);
}

async function runOperation(heading, button, expectedStatus, setup) {
  const response = await turn([
    { type: "click", target: role("link", heading) },
    { type: "waitForElement", target: { strategy: "sectionLiveRegion", sectionHeading: heading }, state: "visible", timeoutMs: 10_000 },
    ...setup,
    { type: "click", target: sectionRole(heading, "button", button) },
    { type: "waitForText", target: { strategy: "sectionLiveRegion", sectionHeading: heading }, value: expectedStatus, match: "contains", timeoutMs: 30_000 },
    { type: "inspectTarget", target: { strategy: "sectionLiveRegion", sectionHeading: heading }, maxCharacters: 500 },
    { type: "inspectTarget", target: { strategy: "sectionResponse", sectionHeading: heading }, maxCharacters: 8_000 },
  ]);
  const failed = response.results.find((result) => result.status === "failed");
  if (failed) throw new Error(`${heading}:${failed.reasonCode}:action-${failed.index}-${failed.type}`);
  const status = response.results.at(-2)?.content ?? "unknown";
  const content = response.results.at(-1)?.content ?? "{}";
  let body;
  try { body = JSON.parse(content); } catch { body = { unparsed: true }; }
  return { status, body, data: body?.data };
}

async function turn(actions) {
  return request("POST", `/direct-sessions/${sessionId}/turns`, { actions, timeoutMs: 60_000 });
}

async function request(method, path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Scry ${response.status}: ${payload.code ?? payload.message ?? "request failed"}`);
  return payload;
}

function baseOrder(identity) {
  return {
    orderType: "monthly-billing",
    quantity: 1,
    kitType: "gut-scan",
    currency: "usd",
    shipping: { country: "US", addressLineOne: "100 Example Street", city: "Boston", state: "MA", postalCode: "02108" },
    ...identity,
  };
}

function role(roleName, name) { return { strategy: "role", role: roleName, name, exact: true }; }
function clickRole(name) { return { type: "click", target: role("button", name) }; }
function credential(placeholder, credentialId) { return { type: "fillCredential", target: { strategy: "placeholder", value: placeholder, exact: true }, credentialId }; }
function sectionRole(sectionHeading, roleName, name) { return { strategy: "sectionRole", sectionHeading, role: roleName, name, exact: true }; }
function fillSection(sectionHeading, value, content, exact = true) { return { type: "fillPublic", target: { strategy: "sectionLabel", sectionHeading, value, exact }, value: content }; }
function fillSectionCredential(sectionHeading, value, credentialId) { return { type: "fillCredential", target: { strategy: "sectionLabel", sectionHeading, value, exact: true }, credentialId }; }
function resource(result) { return { status: result.status, orderId: result.data?.id, clientId: result.data?.clientId, practitionerId: result.data?.practitionerId }; }
function check(name, passed, details = {}) { return { name, passed, ...details }; }
function elapsed(startedAt) { return Math.round((performance.now() - startedAt) * 100) / 100; }
function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function safeError(error) { return error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]") : "unknown failure"; }
