import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const filename = process.env.SCRY_CAPACITY_RESULT;
if (!filename) throw Error("Explicit capacity result required");
const result = JSON.parse(await readFile(filename, "utf8")),
  root = path.dirname(filename);
const { token } = await (await fetch("http://fixture:8080/fixture-input")).json();
const get = async (url) => {
  const response = await fetch("http://api:4000/api" + url, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(45000),
  });
  assert.ok(response.ok, url + ": " + response.status);
  return response;
};
const runs = [];
for (const started of result.runs) {
  const run = await (await get("/runs/" + started.runId)).json();
  assert.ok(["failed", "cancelled", "passed"].includes(run.state));
  const publication = await (await get("/runs/" + started.runId + "/media")).json(),
    media = [];
  for (const item of publication.items) {
    const response = await get(`/runs/${started.runId}/media/${item.index}`),
      bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.artifactId);
    const file = `${root}/${started.runId}-${item.index}.${item.kind === "video" ? "mp4" : "png"}`;
    await writeFile(file, bytes, { mode: 0o600 });
    let probe;
    if (item.kind === "video") {
      assert.ok(response.headers.get("content-type")?.startsWith("video/mp4"));
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
            file,
          ],
          { encoding: "utf8", timeout: 15000 },
        ),
      );
      assert.equal(probe.streams[0].codec_name, "h264");
      assert.equal(probe.streams[0].width, 1280);
      assert.equal(probe.streams[0].height, 720);
      assert.equal(probe.streams[0].r_frame_rate, "20/1");
      assert.ok(Number(probe.format.duration) > 0);
      assert.ok(Math.abs(Number(probe.format.duration) * 1000 - item.durationMs) < 250);
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-f", "null", "-"],
        { timeout: 120000, stdio: "ignore" },
      );
    } else assert.ok(response.headers.get("content-type")?.startsWith("image/png"));
    media.push({
      ...item,
      bytes: bytes.length,
      digestMatches: true,
      ...(probe ? { probe, fullVideoDecoded: true } : {}),
    });
  }
  if (run.state === "passed") {
    assert.ok(run.evidence.every((e) => e.state === "complete" && e.custodyMode === "admitted"));
    assert.ok(media.some((m) => m.kind === "video" && m.coverage === "complete"));
  }
  runs.push({ runId: started.runId, state: run.state, evidence: run.evidence, media });
}
const report = await (await get("/reports/" + result.reportId)).json();
assert.equal(report.state, "final");
assert.equal(report.missionId, result.missionId);
assert.equal(runs.length, 3);
assert.equal(runs[1].state, "cancelled");
assert.equal(runs[2].state, "passed");
const audit = {
  passed: true,
  kind: "controlled_capacity_not_real_app_acceptance",
  runs,
  reportId: result.reportId,
  evidenceCoverage: report.evidenceCoverage,
};
await writeFile(root + "/audit.json", JSON.stringify(audit, null, 2));
console.log(
  JSON.stringify({
    passed: true,
    root,
    runs: runs.map((r) => ({
      runId: r.runId,
      state: r.state,
      videos: r.media
        .filter((m) => m.kind === "video")
        .map((m) => ({
          coverage: m.coverage,
          durationMs: m.durationMs,
          fullVideoDecoded: m.fullVideoDecoded,
        })),
    })),
    evidenceCoverage: report.evidenceCoverage,
  }),
);
