// Independent read-only platform/evidence audit after customer-led journeys.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = process.env.SCRY_BLIND_ROOT;
if (!root) throw new Error("Explicit audit root required");
const base = process.env.SCRY_BLIND_API ?? "http://api:4000/api";
const fixture = process.env.SCRY_BLIND_FIXTURE ?? "http://fixture:8080/fixture-input";
const { token } = await (await fetch(fixture)).json();
const get = async (path) => {
  const operator = path.startsWith("/operator/");
  if (operator && !process.env.SCRY_SERVICE_TOKEN)
    throw new Error("Explicit internal operator credential required for qualification diagnostics");
  const response = await fetch(base + path, {
    headers: { authorization: "Bearer " + (operator ? process.env.SCRY_SERVICE_TOKEN : token) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Audit ${path}: ${response.status}`);
  return response;
};
const apps = process.argv.slice(2);
const privateInputs = process.env.SCRY_BLIND_INPUTS
  ? JSON.parse(await readFile(process.env.SCRY_BLIND_INPUTS, "utf8"))
  : undefined;
const audited = [];
for (const app of apps) {
  const directory = root + "/" + app;
  const text = await readFile(directory + "/results.jsonl", "utf8").catch(() => "");
  const rows = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const runs = [
    ...new Map(
      rows
        .filter((row) => row.name === "start_run")
        .map((row) => row.result.structuredContent)
        .filter((row) => row?.runId)
        .map((row) => [row.runId, row]),
    ).values(),
  ];
  const record = {
    app,
    startedRuns: runs.length,
    knownSecretInText: privateInputs ? text.includes(privateInputs[app].password) : null,
    runs: [],
    reports: [],
    evidenceGaps: [],
    errors: [],
  };
  await mkdir(directory + "/audited", { recursive: true });
  for (const started of runs) {
    try {
      const run = await (await get(`/operator/runs/${started.runId}`)).json();
      const publication = await (await get(`/runs/${started.runId}/media`)).json();
      const media = [];
      for (const item of publication.items) {
        const response = await get(`/runs/${started.runId}/media/${item.index}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const digestMatches = createHash("sha256").update(bytes).digest("hex") === item.artifactId;
        const filename = `${directory}/audited/${started.runId}-${item.index}.${item.kind === "video" ? "mp4" : "png"}`;
        await writeFile(filename, bytes, { mode: 0o600 });
        let probe;
        if (item.kind === "video") {
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
              { encoding: "utf8", timeout: 10000 },
            ),
          );
          execFileSync(
            "ffmpeg",
            ["-v", "error", "-xerror", "-i", filename, "-map", "0:v:0", "-f", "null", "-"],
            { timeout: 120000, stdio: "ignore" },
          );
        }
        media.push({
          ...item,
          bytes: bytes.length,
          digestMatches,
          mime: response.headers.get("content-type"),
          ...(probe ? { probe, fullVideoDecoded: true } : {}),
        });
      }
      const mediaContentVerified = media.every(
        (m) =>
          m.digestMatches &&
          (m.kind === "video"
            ? m.mime?.startsWith("video/mp4")
            : m.mime?.startsWith("image/png")) &&
          (m.kind !== "video" ||
            (m.fullVideoDecoded &&
              m.probe?.streams?.[0]?.codec_name === "h264" &&
              m.probe.streams[0].width === 1280 &&
              m.probe.streams[0].height === 720 &&
              m.probe.streams[0].r_frame_rate === "20/1" &&
              Number(m.probe.format.duration) > 0)),
      );
      record.runs.push({
        runId: started.runId,
        missionId: run.missionId,
        state: run.state,
        outcome: run.outcomeClassification,
        runtimeAdapter: run.runtimeAdapter,
        activity: run.activity,
        evidence: run.evidence,
        media,
        mediaContentVerified,
        mediaVerified: media.some((m) => m.kind === "video") && mediaContentVerified,
        duplicateScreenshots:
          new Set(media.filter((m) => m.kind === "screenshot").map((m) => m.artifactId)).size !==
          media.filter((m) => m.kind === "screenshot").length,
      });
    } catch (error) {
      record.errors.push({ runId: started.runId, message: String(error.message) });
    }
  }
  const reportIds = new Set(
    rows
      .filter((row) => row.name === "publish_mission_report")
      .map((row) => row.result.structuredContent?.reportId)
      .filter(Boolean),
  );
  for (const id of reportIds) {
    try {
      record.reports.push(await (await get(`/operator/reports/${id}`)).json());
    } catch (error) {
      record.errors.push({ reportId: id, message: String(error.message) });
    }
  }
  if (!record.startedRuns || record.runs.length !== record.startedRuns)
    record.errors.push({ message: "Every independently started attempt must be audited" });
  if (record.reports.length !== 1)
    record.errors.push({ message: "Expected one published customer report" });
  if (record.reports.some((report) => report.state !== "final"))
    record.errors.push({ message: "Customer report is not final" });
  if (record.knownSecretInText !== false)
    record.errors.push({ message: "Known-secret text check failed or was not configured" });
  for (const run of record.runs) {
    if (
      run.runtimeAdapter !== "playwright_mcp" ||
      !["passed", "failed", "cancelled", "infrastructure_error"].includes(run.state)
    )
      record.errors.push({ runId: run.runId, message: "Unexpected adapter or terminal Run state" });
    if (
      !run.mediaContentVerified ||
      run.duplicateScreenshots ||
      (run.state === "passed" && !run.mediaVerified)
    )
      record.errors.push({
        runId: run.runId,
        message: "Media verification or deduplication failed",
      });
    if (
      !run.evidence?.length ||
      run.evidence.some(
        (stream) => stream.state !== "complete" || stream.custodyMode !== "admitted",
      )
    )
      (run.state === "passed" ? record.errors : record.evidenceGaps).push({
        runId: run.runId,
        message: "Evidence stream is not complete and admitted",
      });
    if (run.media.some((item) => item.kind === "video" && item.coverage !== "complete"))
      (run.state === "passed" ? record.errors : record.evidenceGaps).push({
        runId: run.runId,
        message: "Incomplete recording coverage",
      });
  }
  if (!record.runs.some((run) => run.state === "passed"))
    record.errors.push({
      message: "No successful customer attempt; failure evidence is not acceptance",
    });
  record.classification = record.errors.length
    ? "blocked"
    : record.runs.some((run) => run.state !== "passed")
      ? "recovered_attempts_require_business_review"
      : "clean_attempts_require_business_review";
  // A passing mechanical audit is not a clean business-compatibility verdict.
  // Agents' report findings and UI readbacks must still be reviewed separately.
  if (record.errors.length) process.exitCode = 1;
  await writeFile(directory + "/audit.json", JSON.stringify(record, null, 2), { mode: 0o600 });
  audited.push(record);
  console.log(
    JSON.stringify({
      app,
      classification: record.classification,
      evidenceGaps: record.evidenceGaps,
      runs: record.runs.map((r) => ({
        runId: r.runId,
        state: r.state,
        outcome: r.outcome,
        mediaVerified: r.mediaVerified,
        duplicateScreenshots: r.duplicateScreenshots,
        videos: r.media
          .filter((m) => m.kind === "video")
          .map((m) => ({
            coverage: m.coverage,
            durationMs: m.durationMs,
            digestMatches: m.digestMatches,
          })),
      })),
      knownSecretInText: record.knownSecretInText,
      errors: record.errors,
    }),
  );
}
await writeFile(
  root + "/audit-" + apps.join("-") + ".json",
  JSON.stringify({ audited, at: new Date().toISOString() }, null, 2),
  { mode: 0o600 },
);
