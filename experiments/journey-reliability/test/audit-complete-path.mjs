import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const file = process.env.SCRY_COMPLETE_PATH_RESULT;
if (!file) throw Error("Explicit result path required");
const result = JSON.parse(await readFile(file, "utf8")),
  root = path.dirname(file);
const { token } = await (await fetch("http://fixture:8080/fixture-input")).json();
const get = async (endpoint) => {
  const r = await fetch("http://api:4000/api" + endpoint, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(45000),
  });
  assert.ok(r.ok, endpoint + ": " + r.status);
  return r;
};
const publication = await (await get("/runs/" + result.runId + "/media")).json(),
  items = [];
for (const item of publication.items) {
  const response = await get(`/runs/${result.runId}/media/${item.index}`),
    bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), item.artifactId);
  const filename = root + "/audited-" + item.index + (item.kind === "video" ? ".mp4" : ".png");
  await writeFile(filename, bytes, { mode: 0o600 });
  let probe;
  if (item.kind === "video") {
    assert.equal(response.headers.get("content-type"), "video/mp4");
    probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,width,height,r_frame_rate:format=duration",
          "-of",
          "json",
          filename,
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    assert.equal(probe.streams[0].codec_name, "h264");
    assert.equal(probe.streams[0].width, 1280);
    assert.equal(probe.streams[0].height, 720);
    assert.equal(probe.streams[0].r_frame_rate, "20/1");
    assert.ok(Number(probe.format.duration) > 0, "Recording has no playable duration");
    assert.ok(
      Math.abs(Number(probe.format.duration) * 1000 - item.durationMs) < 250,
      "Published duration disagrees with the actual recording",
    );
    if (result.video.durationMs > 900000)
      assert.ok(Number(probe.format.duration) > 900, "Long recording was cut off");
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-xerror", "-i", filename, "-map", "0:v:0", "-f", "null", "-"],
      { stdio: "ignore", timeout: 120000 },
    );
  }
  items.push({
    ...item,
    bytes: bytes.length,
    digestMatches: true,
    ...(probe ? { probe, fullVideoDecoded: true } : {}),
  });
}
const run = await (await get("/runs/" + result.runId)).json(),
  report = await (await get("/reports/" + result.reportId)).json();
assert.equal(run.state, "passed");
assert.equal(report.state, "final");
assert.equal(report.missionId, result.missionId);
assert.ok(items.some((i) => i.kind === "video" && i.coverage === "complete"));
const audit = {
  kind: "full_path_evidence_audit_not_universal_app_acceptance",
  runId: result.runId,
  missionId: result.missionId,
  reportId: result.reportId,
  items,
  passed: true,
  at: new Date().toISOString(),
};
await writeFile(root + "/audit.json", JSON.stringify(audit, null, 2));
console.log(
  JSON.stringify({
    passed: true,
    root,
    videos: items
      .filter((i) => i.kind === "video")
      .map((i) => ({
        durationMs: i.durationMs,
        fullVideoDecoded: i.fullVideoDecoded,
        digestMatches: i.digestMatches,
      })),
  }),
);
