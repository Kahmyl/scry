// Test-account provisioning only. Journey agents receive opaque selections,
// never these private fixture inputs or Scry's implementation history.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const root = process.env.SCRY_BLIND_ROOT;
if (!root || !process.env.SCRY_BLIND_INPUTS) throw new Error("Explicit lab paths required");
const inputs = JSON.parse(await readFile(process.env.SCRY_BLIND_INPUTS, "utf8"));
const { token } = await (await fetch("http://127.0.0.1:45491/fixture-input")).json();
const api = async (path, body) => {
  const r = await fetch("http://127.0.0.1:45400/api" + path, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Provisioning ${path}: ${r.status}`);
  return r.json();
};
await mkdir(root, { recursive: true, mode: 0o700 });
const project = await api("/projects", {
  name: "Fresh blind acceptance 20261031 " + randomUUID().slice(0, 8),
});
const assignments = {};
for (const app of [
  "grafana",
  "nextcloud",
  "odoo",
  "metabase",
  "openproject",
  "discourse",
  "mattermost",
  "erpnext",
  "penpot",
  "gitlab",
]) {
  const directory = root + "/" + app;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const credential = await api(`/projects/${project.id}/protected-inputs`, {
    projectId: project.id,
    displayName: app + " explicitly selected fictional test credential",
    value: inputs[app].password,
    expiresInSeconds: 86400,
    idempotencyKey: randomUUID(),
  });
  const access = await api("/mcp-tokens", { name: "Disposable blind " + app + " 20261031" });
  await writeFile(
    directory + "/connection.json",
    JSON.stringify({ token: access.token, tokenId: access.id }),
    { mode: 0o600, flag: "wx" },
  );
  assignments[app] = {
    projectId: project.id,
    username: inputs[app].username,
    protectedValueId: credential.protectedValueId,
  };
}
await writeFile(root + "/assignments.json", JSON.stringify(assignments, null, 2), {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify({ projectId: project.id, assignments, root }));
