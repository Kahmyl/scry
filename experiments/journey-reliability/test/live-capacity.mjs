// Controlled public-path proof, not a blind real-app acceptance journey.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platformClient, sleep } from "./platform-client.mjs";
const root = "/results/live-capacity-" + Date.now();
await mkdir(root, { recursive: true });
const p = await platformClient(),
  checks = [],
  runs = [];
const check = (name) => {
  checks.push({ name, passed: true });
  console.log(JSON.stringify(checks.at(-1)));
};
const project = await p.api("/projects", {
  name: "Capacity qualification " + randomUUID().slice(0, 8),
});
const env = await p.life("create_environment", {
  projectId: project.id,
  name: "Controlled workspace",
  baseOrigin: "http://target:8081",
  disclosureMode: "confidential",
});
const mission = await p.life("start_mission", {
  projectId: project.id,
  title: "Browser capacity, cancellation and crash recovery",
  instruction: "Qualify lifetime admission without replaying application actions.",
  provider: "human",
});
const objective = await p.life("create_objective", {
  missionId: mission.missionId,
  agentSessionId: mission.agentSessionId,
  title: "Bound live browser admission and recover safely",
  completionCriteria: { capacity: true, recovery: true },
  objectiveOrder: 0,
});
const flow = await p.life("create_flow", {
  missionId: mission.missionId,
  agentSessionId: mission.agentSessionId,
  name: "Capacity and recovery",
  purpose: "Retain the interrupted and cancelled attempts without inventing continuity.",
});
const input = (attemptId) => ({
  projectId: project.id,
  missionId: mission.missionId,
  agentSessionId: mission.agentSessionId,
  objectiveId: objective.objectiveId,
  flowId: flow.flowId,
  flowRevisionId: flow.flowRevisionId,
  environmentId: env.environmentId,
  attemptId,
});
const finish = async (run, outcome, conclusion) => {
  for (let n = 0; n < 3; n++) {
    try {
      return await p.finish(run, outcome, conclusion);
    } catch (error) {
      if (!String(error.message).includes("OWNER_FENCED") || n === 2) throw error;
    }
  }
};
let active;
try {
  const firstInput = input(randomUUID()),
    nextInput = input(randomUUID());
  active = await p.life("start_run", firstInput);
  runs.push(active);
  await p.browser(active, "browser_navigate", { url: "http://target:8081/" });
  assert.equal((await p.life("start_run", firstInput)).runId, active.runId);
  check("exact start replay works at full capacity");
  const refuse = async () => {
    const result = await p.rpc("tools/call", { name: "start_run", arguments: nextInput });
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result).includes("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED"));
    return result;
  };
  const refusal = await refuse();
  assert.equal(
    (await p.life("get_mission", { missionId: mission.missionId })).mission.runs.length,
    1,
  );
  assert.ok(
    p
      .text((await p.browser(active, "browser_snapshot")).command)
      .includes("Original styled application"),
  );
  await p.browser(active, "browser_take_screenshot", {
    type: "png",
    evidenceTitle: "Existing browser remains usable at capacity",
  });
  check("excess start is refused before creation while current browser remains usable");
  if (process.env.SCRY_CAPACITY_CRASH_TEST === "1") {
    await writeFile(
      root + "/awaiting-worker-stop.json",
      JSON.stringify({ root, run: active, missionId: mission.missionId }),
    );
    console.log(
      JSON.stringify({
        phase: "awaiting_isolated_worker_kill_and_restart",
        root,
        runId: active.runId,
      }),
    );
    // The orchestrator records the actual isolated worker restart. Starting a
    // timer before that operation is not proof that its last lease has expired.
    let confirmation;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try {
        confirmation = JSON.parse(await readFile(root + "/restart-confirmed.json", "utf8"));
        break;
      } catch {
        await sleep(500);
      }
    }
    assert.equal(confirmation?.restarted, true, "No confirmed isolated worker restart");
    // No session command renews the old lease during this wait.
    await sleep(65000);
    await refuse();
    check("worker loss and expired lease do not release the reservation");
    await finish(
      active,
      "environment_failure",
      "Controlled worker-crash experiment interrupted native recording. No application write was repeated.",
    );
  } else await finish(active, "cancelled", "Controlled cancellation before application writes.");
  active = undefined;
  const cancelled = await p.life("start_run", nextInput);
  runs.push(cancelled);
  active = cancelled;
  await p.browser(cancelled, "browser_navigate", { url: "http://target:8081/" });
  await finish(
    cancelled,
    "cancelled",
    "Controlled cancellation released capacity only through normal confirmed finalization.",
  );
  active = undefined;
  check(
    "previously refused start succeeds after recovered closure; cancellation remains available",
  );
  const last = await p.life("start_run", input(randomUUID()));
  runs.push(last);
  active = last;
  await p.browser(last, "browser_navigate", { url: "http://target:8081/" });
  await p.browser(last, "browser_take_screenshot", {
    type: "png",
    evidenceTitle: "Fresh browser after cancellation and recovery",
  });
  await finish(
    last,
    "passed",
    "Lifetime admission, capacity refusal, exact replay, recovered closure and cancellation verified in the controlled public path.",
  );
  active = undefined;
  check("a fresh browser opens after cancellation without reviving old attempts");
  const report = await p.life("publish_mission_report", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    summary:
      "Controlled live-capacity checks passed; the intentional worker interruption remains a separate failed attempt.",
    safeReport: {
      presentation: {
        verified: checks.map((c) => c.name),
        limitations: [
          "Controlled fixture, not app acceptance or arbitrary concurrency. An intentional worker crash leaves a partial recording; no continuity is reconstructed.",
        ],
      },
    },
  });
  await writeFile(
    root + "/result.json",
    JSON.stringify(
      {
        root,
        missionId: mission.missionId,
        reportId: report.reportId,
        runs,
        checks,
        refusal,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: true, root, missionId: mission.missionId, reportId: report.reportId }),
  );
} catch (error) {
  await writeFile(
    root + "/failure.json",
    JSON.stringify({ message: error.message, checks, runs, active }, null, 2),
  );
  throw error;
} finally {
  if (active)
    await finish(
      active,
      "environment_failure",
      "Controlled capacity qualification did not complete; no business success is claimed.",
    ).catch(() => {});
}
