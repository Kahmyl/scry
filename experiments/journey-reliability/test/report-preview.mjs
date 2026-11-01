// Read-only localhost UX experiment using already-audited fictional lab evidence.
// This does not modify Scry data, authorization, routes or historical artifacts.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
const root = process.env.SCRY_UI_ARTIFACTS;
if (!root) throw Error("Explicit lab artifact root required");
const rows = (await readFile(path.join(root, "gitlab/calls.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map(JSON.parse);
const published = rows.findLast((r) => r.name === "publish_mission_report").arguments;
const audit = JSON.parse(await readFile(path.join(root, "gitlab/audit.json"), "utf8")).runs[0];
const report = published.safeReport;
const evidence = audit.media.map((m) => ({
  kind: m.kind,
  title:
    m.kind === "video"
      ? "Issue lifecycle: create, edit, verify and sign out"
      : (report.screenshots[m.index]?.state ?? "Captured page"),
  url: "/media/" + m.index,
  coverage: m.coverage,
  durationMs: m.durationMs,
}));
const findingTitles = [
  "Avatar images did not load",
  "Issue totals disagreed",
  "Navigation completed after a timeout",
  "A toast temporarily blocked Comment",
  "Console warnings were not investigated",
];
const data = {
  title: "GitLab issue lifecycle",
  summary: published.summary,
  outcome: report.outcome,
  findings: report.findings.map((f, i) => ({ ...f, title: findingTitles[i] })),
  verification: report.verification,
  limitations: report.limitations,
  evidence,
  flowName: "Create and review a fictional issue",
  runName: "Attempt 1 — issue, label, comment and saved edits",
  missionId: published.missionId,
  runId: audit.runId,
};
const html = await readFile(new URL("../ui/preview.html", import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (u.pathname === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
      return;
    }
    if (u.pathname === "/data") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(data));
      return;
    }
    const match = /^\/media\/(\d+)$/.exec(u.pathname);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const media = audit.media.find((m) => m.index === Number(match[1]));
    if (!media) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = path.join(
      root,
      "gitlab/audited",
      audit.runId + "-" + media.index + (media.kind === "video" ? ".mp4" : ".png"),
    );
    const s = await stat(file);
    res.setHeader("content-type", media.kind === "video" ? "video/mp4" : "image/png");
    res.setHeader("accept-ranges", "bytes");
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]),
        end = range[2] ? Math.min(Number(range[2]), s.size - 1) : s.size - 1;
      if (start > end || start >= s.size) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${s.size}`,
        "content-length": end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.setHeader("content-length", s.size);
      createReadStream(file).pipe(res);
    }
  } catch {
    res.writeHead(500);
    res.end("Preview unavailable");
  }
});
server.listen(0, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      preview: "http://127.0.0.1:" + server.address().port,
      readOnly: true,
      source: "existing audited GitLab trial; not new qualification",
    }),
  ),
);
