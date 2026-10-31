import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = process.env.SCRY_INTEGRATION_RESUME_ROOT;
assert.ok(root?.startsWith("/integration-evidence/ten-app-"));
const { token } = await (await fetch("http://fixture:8080/fixture-input")).json();
const api = async (path, body) => {
  const response = await fetch("http://api:4000/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `API ${path}: ${response.status}`);
  return response.json();
};
const { completed } = JSON.parse(await readFile(root + "/results.json", "utf8"));
const mission = (await readFile(root + "/tools.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((row) => row.name === "start_mission").result;
const verified = [];
await mkdir(root + "/verified", { recursive: true });
for (const revisit of completed) {
  const run = await api(`/runs/${revisit.runId}`);
  const publication = await api(`/runs/${revisit.runId}/media`);
  const video = publication.items.find((item) => item.kind === "video");
  assert.ok(video, "Native recording missing");
  const response = await fetch(`http://api:4000/api/runs/${revisit.runId}/media/${video.index}`, {
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), video.artifactId);
  const file = `${root}/verified/${revisit.app}-${revisit.runId}.mp4`;
  await writeFile(file, bytes, { mode: 0o600 });
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate:format=duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", timeout: 10000 },
    ),
  );
  assert.equal(probe.streams[0].codec_name, "h264");
  assert.equal(probe.streams[0].width, 1280);
  assert.equal(probe.streams[0].height, 720);
  assert.equal(probe.streams[0].r_frame_rate, "20/1");
  assert.ok(Number(probe.format.duration) > 0);
  verified.push({
    ...revisit,
    outcome: run.outcomeClassification,
    state: run.state,
    video,
    probe,
    videoBytes: bytes.length,
  });
}
const passing = verified.filter(
  (row) => row.state === "passed" && row.video.coverage === "complete",
);
assert.equal(new Set(passing.map((row) => row.app)).size, 10);
assert.equal(verified.filter((row) => row.outcome === "environment_failure").length, 1);
const summary =
  "Ten established-app integrated revisits passed with authenticated native MP4 evidence. One earlier Odoo packaging iteration failed and is retained as environment failure. These are operator-led integration revisits, not a repeated blind ten-app deep-journey qualification. Best-effort masking has a documented API-key phrase false positive.";
const report = await api(`/missions/${mission.missionId}/report`, {
  agentSessionId: mission.agentSessionId,
  summary,
  safeReport: { scope: "controlled platform integration", completed: verified },
});
await writeFile(
  root + "/verified-results.json",
  JSON.stringify({ missionId: mission.missionId, report, summary, completed: verified }, null, 2),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    verifiedApps: 10,
    retainedEnvironmentFailures: 1,
    ...report,
    missionId: mission.missionId,
  }),
);
