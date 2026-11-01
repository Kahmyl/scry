import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { platformClient, sleep } from "./platform-client.mjs";
const root = "/results/complete-path-" + Date.now();
await mkdir(root, { recursive: true });
const p = await platformClient(),
  rows = [];
const check = (name, detail = {}) => {
  rows.push({ name, passed: true, ...detail });
  console.log(JSON.stringify(rows.at(-1)));
};
const project = await p.api("/projects", {
  name: "Candidate journeys " + randomUUID().slice(0, 8),
});
const env = await p.life("create_environment", {
  projectId: project.id,
  name: "Isolated styled workspace",
  baseOrigin: "http://target:8081",
  disclosureMode: "confidential",
});
const mission = await p.life("start_mission", {
  projectId: project.id,
  title: "Project note editing and save confirmation",
  instruction:
    "Test ordinary and rich text editing, inspect saved application state, retain every attempt and publish a useful report.",
  provider: "human",
});
const objective = await p.life("create_objective", {
  missionId: mission.missionId,
  agentSessionId: mission.agentSessionId,
  title: "Edit and save a project note",
  completionCriteria: { savedAndInspected: true },
  objectiveOrder: 0,
});
const flow = await p.life("create_flow", {
  missionId: mission.missionId,
  agentSessionId: mission.agentSessionId,
  name: "Edit and save the project",
  purpose: "Inspect rich and ordinary inputs and verify the final application state.",
});
const start = () =>
  p.life("start_run", {
    projectId: project.id,
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveId: objective.objectiveId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId: env.environmentId,
    attemptId: randomUUID(),
  });
let active,
  closed = false;
try {
  active = await start();
  await p.browser(active, "browser_navigate", { url: "http://target:8081/" });
  const invalid = await p.browser(
    active,
    "browser_edit_text",
    { target: "e999999", text: "No text should be sent", intent: "replace", method: "paste" },
    randomUUID(),
    true,
  );
  assert.equal(invalid.command.result?.inputObservation?.status, "not_dispatched");
  assert.equal(invalid.command.result.businessOutcome, "not_dispatched");
  assert.ok(
    p
      .text((await p.browser(active, "browser_snapshot")).command)
      .includes("Original styled application"),
  );
  await p.finish(
    active,
    "blocked",
    "Controlled stale-reference trial refused before text input. No application defect was inferred.",
  );
  closed = true;
  check("stale-reference trial recorded honestly");
  active = await start();
  closed = false;
  await p.browser(active, "browser_navigate", { url: "http://target:8081/" });
  const rich = "Updated project document\nSecond line stays in the original editor.";
  let snapshot = (await p.browser(active, "browser_snapshot")).command;
  const edit = await p.browser(active, "browser_edit_text", {
    target: p.ref(snapshot, "Document editor"),
    text: rich,
    intent: "replace",
    method: "paste",
  });
  assert.equal(edit.command.result.inputObservation.status, "observed");
  assert.equal(edit.command.result.businessOutcome, "unverified");
  check("rich native paste observed without claiming persisted success");
  snapshot = (await p.browser(active, "browser_snapshot")).command;
  const note = "Project note verified through the full path " + randomUUID().slice(0, 8);
  await p.browser(active, "browser_edit_text", {
    target: p.ref(snapshot, "Public note"),
    text: note,
    intent: "replace",
    method: "keyboard",
  });
  const id = randomUUID(),
    before = (await (await fetch("http://target:8081/facts")).json()).writes;
  const saved = await p.browser(active, "browser_click", { target: "#save" }, id);
  await p.browser(active, "browser_click", { target: "#save" }, id);
  assert.equal((await (await fetch("http://target:8081/facts")).json()).writes, before + 2);
  assert.equal(saved.command.result.businessOutcome, "unverified");
  snapshot = (await p.browser(active, "browser_snapshot")).command;
  assert.ok(p.text(snapshot).includes("Saved successfully"));
  assert.ok(p.text(snapshot).includes(note));
  check("exact action identity does not replay the save");
  const image = await p.browser(active, "browser_take_screenshot", {
    type: "png",
    evidenceTitle: "Project note saved successfully",
    evidenceDescription:
      "The original styled page after the save, with the updated document and public note.",
  });
  const screenshotId = image.command.result.media[0].artifactId;
  const publication = await p.api("/runs/" + active.runId + "/media");
  assert.equal(
    publication.items.find((i) => i.artifactId === screenshotId).title,
    "Project note saved successfully",
  );
  check("human evidence title survives worker and Chronicle admission");
  const longMs = Number(process.env.SCRY_INTEGRATED_SOAK_MS ?? 0),
    started = Date.now();
  let observations = 0;
  while (Date.now() - started < longMs) {
    await sleep(Math.min(30000, longMs - (Date.now() - started)));
    const s = (await p.browser(active, "browser_snapshot")).command;
    assert.ok(p.text(s).includes("Saved successfully"));
    observations++;
    console.log(
      JSON.stringify({ soakSeconds: Math.floor((Date.now() - started) / 1000), observations }),
    );
  }
  if (longMs)
    check("integrated long-lived browser remained usable", {
      elapsedMs: Date.now() - started,
      observations,
    });
  await p.finish(
    active,
    "passed",
    "Native rich paste and ordinary keyboard replacement observed, save status independently inspected, and duplicate action identity did not repeat the save.",
  );
  closed = true;
  const observed = (await p.life("get_mission", { missionId: mission.missionId })).mission;
  assert.equal(observed.runs.length, 2);
  assert.ok(observed.runs[0].conclusion.includes("stale-reference"));
  assert.ok(observed.runs[1].conclusion.includes("Native rich paste"));
  check("both attempt conclusions retained");
  const report = await p.life("publish_mission_report", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    summary:
      "The project note was edited and its save confirmation was inspected. Sharing and backend persistence were not tested.",
    safeReport: {
      presentation: {
        subject: "application",
        scope: ["Edit the project document and public note, then inspect the save confirmation"],
        checks: [
          {
            title: "Edited project note",
            expected: "The note field shows the revised text",
            actual: "The revised note was visible in the application",
            status: "matched_expectation",
            evidence: [{ runId: active.runId, artifactId: screenshotId }],
          },
          {
            title: "Save confirmation",
            expected: "The application acknowledges saving the note",
            actual: "Saved successfully was displayed with the revised note",
            status: "matched_expectation",
            evidence: [{ runId: active.runId, artifactId: screenshotId }],
          },
          {
            title: "Sharing",
            actual: "Not included in this test",
            status: "not_tested",
            evidence: [],
          },
        ],
        observations: [
          {
            title: "Final saved project note inspected",
            detail:
              "The application displayed its save confirmation with the updated project note.",
            evidence: [{ runId: active.runId, artifactId: screenshotId }],
          },
        ],
        limitations: [
          "The visible save confirmation was checked; backend persistence after reopening and sharing were not tested. Only the assigned browser was used.",
        ],
      },
      operatorDiagnostics: { qualificationOnly: "PRIVATE_REPORT_QUALIFICATION_MARKER" },
    },
  });
  const customerReport = await p.api("/reports/" + report.reportId);
  assert.equal(customerReport.safeReport.presentation.subject, "application");
  assert.equal(customerReport.safeReport.presentation.checks[2].status, "not_tested");
  assert.ok(!JSON.stringify(customerReport).includes("PRIVATE_REPORT_QUALIFICATION_MARKER"));
  const customerMission = await p.api("/dashboard/missions/" + mission.missionId);
  assert.equal(customerMission.runs.length, 2);
  assert.ok(
    customerMission.runs.every(
      (r) => r.state === "ended" && !r.conclusion && !r.outcomeClassification,
    ),
  );
  const denied = await fetch("http://api:4000/api/operator/reports/" + report.reportId, {
    headers: {
      authorization:
        "Bearer " + (await (await fetch("http://fixture:8080/fixture-input")).json()).token,
    },
  });
  assert.equal(denied.status, 403);
  const operator = await fetch("http://api:4000/api/operator/reports/" + report.reportId, {
    headers: { authorization: "Bearer " + process.env.SCRY_SERVICE_TOKEN },
  });
  assert.equal(operator.status, 200);
  assert.ok(JSON.stringify(await operator.json()).includes("PRIVATE_REPORT_QUALIFICATION_MARKER"));
  check("customer app checks and private operator original are separated over real HTTP");
  const media = await p.api("/runs/" + active.runId + "/media"),
    video = media.items.find((i) => i.kind === "video");
  assert.ok(video);
  assert.equal(video.coverage, "complete");
  if (longMs)
    assert.ok(video.durationMs > 900000, "Recording stopped at the old fifteen-minute limit");
  const result = {
    kind: "controlled_public_mcp_api_worker_chronicle_dashboard_data",
    projectId: project.id,
    missionId: mission.missionId,
    runId: active.runId,
    reportId: report.reportId,
    screenshotId,
    rows,
    video,
  };
  await writeFile(root + "/result.json", JSON.stringify(result, null, 2));
  check("compiled report references the same admitted screenshot and continuous video", {
    root,
    missionId: mission.missionId,
    reportId: report.reportId,
    durationMs: video.durationMs,
  });
} catch (e) {
  await writeFile(
    root + "/failure.json",
    JSON.stringify({ error: e.message, rows, active, missionId: mission.missionId }, null, 2),
  );
  throw e;
} finally {
  if (active && !closed)
    await p
      .finish(
        active,
        "environment_failure",
        "Controlled qualification stopped at an assertion. Preserve the actual attempt and evidence; do not infer application failure.",
      )
      .catch((e) => console.error("Failure closure unavailable: " + e.message));
}
