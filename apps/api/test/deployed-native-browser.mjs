import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export async function reproduceRetainedLogin({ api, operator, call, project, credential }) {
  const environment = await call("create_environment", {
    projectId: project.id,
    name: "Retained split-origin negative control",
    baseOrigin: "http://fixture:8080",
    allowedServiceOrigins: ["http://fixture:8082"],
    disclosureMode: "confidential",
  });
  const mission = await call("start_mission", {
    projectId: project.id,
    title: "Retained login reproduction",
    instruction: "Isolated negative control only; no real application accounts.",
    provider: "human",
  });
  const objective = await call("create_objective", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveOrder: 0,
    title: "Characterize split-origin login",
    completionCriteria: { target: "observe compatibility" },
  });
  const flow = await call("create_flow", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    name: "Retained negative control",
  });
  const saved = await call("create_credential", {
    projectId: project.id,
    displayName: "Fictional reproduction credential",
    value: credential,
    idempotencyKey: randomUUID(),
  });
  const run = await call("start_run", {
    projectId: project.id,
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveId: objective.objectiveId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId: environment.environmentId,
    protectedInputIds: [saved.protectedValueId],
  });
  const command = async (input) => {
    let result = await call("command", { browserSessionId: run.browserSessionId, command: input });
    for (let i = 0; !["completed", "failed"].includes(result.state) && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 250));
      result = {
        ...result,
        command: (await call("get_command", { commandId: result.commandId })).command,
      };
      result.state = result.command.state;
    }
    return result.command;
  };
  assert.equal(
    (await command({ kind: "navigate", url: "http://fixture:8080/login-app" })).state,
    "completed",
  );
  const observed = (await command({ kind: "observe" })).result;
  const email = observed.controls.find((c) => c.type === "email"),
    password = observed.controls.find((c) => c.type === "password");
  assert.ok(email && password);
  await command({
    kind: "fill",
    reference: email.reference,
    publicValue: "fictional@example.invalid",
  });
  await command({
    kind: "fill",
    reference: password.reference,
    protectedValueId: saved.protectedValueId,
  });
  const latest = (await command({ kind: "observe" })).result;
  const button = latest.controls.find((c) => c.name === "Sign in" || c.text === "Sign in");
  assert.ok(button, "RETAINED_SUBMIT_NOT_DISCOVERED");
  const before = await (await fetch("http://fixture:8080/login-facts")).json();
  const submitted = await command({
    kind: "commit",
    reference: button.reference,
    effectClass: "authentication",
    effectIdempotencyKey: randomUUID(),
    intentSummary: "Fictional split-origin login reproduction",
  });
  assert.equal(submitted.state, "failed", "NEGATIVE_CONTROL_DID_NOT_REPRODUCE");
  assert.equal(
    (await (await fetch("http://fixture:8080/login-facts")).json()).logins,
    before.logins,
    "RETAINED_REQUEST_WAS_DISPATCHED",
  );
  await command({ kind: "observe" });
  const owned = await operator(`/runs/${run.runId}`);
  await call("finalize_run", {
    runId: run.runId,
    ownerGeneration: Number(owned.ownerGeneration),
    outcome: "environment_failure",
    conclusion:
      "Controlled split-origin login did not dispatch despite the approved API origin; expected reproduction, not an application defect.",
  });
  console.log(
    "RETAINED_SPLIT_ORIGIN_FAILURE_REPRODUCED " +
      JSON.stringify({ runId: run.runId, errorCode: submitted.errorCode }),
  );
}

export async function exerciseNativeBrowser({
  api,
  operator,
  rpc,
  call,
  project,
  credential,
  token,
  otherToken,
}) {
  const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
  for (const name of [
    "browser_navigate",
    "browser_snapshot",
    "browser_type",
    "browser_type_secret",
    "browser_click",
    "browser_take_screenshot",
    "get_command",
    "connect_test_mailbox",
    "create_webhook_listener",
  ])
    assert.ok(tools.includes(name), "DEPLOYED_NATIVE_TOOL_MISSING:" + name);
  assert.ok(!tools.includes("command"), "DEPLOYED_RETAINED_PROFILE_EXPOSED");
  const environment = await call("create_environment", {
    projectId: project.id,
    name: "Approved split-origin workspace",
    baseOrigin: "http://fixture:8080",
    allowedServiceOrigins: ["http://fixture:8082"],
    disclosureMode: "confidential",
  });
  const mission = await call("start_mission", {
    projectId: project.id,
    title: "Deployed split-origin sign-in",
    instruction:
      "Verify fictional login, profile, persisted session, logout and evidence through the deployed native browser path.",
    provider: "human",
  });
  const objective = await call("create_objective", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveOrder: 0,
    title: "Authenticated workspace continuity",
    completionCriteria: { session: "confirmed after reload" },
  });
  const flow = await call("create_flow", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    name: "Sign in and return to the workspace",
  });
  const saved = await call("create_credential", {
    projectId: project.id,
    displayName: "Explicit fictional login",
    value: credential,
    idempotencyKey: randomUUID(),
  });
  const run = await call("start_run", {
    projectId: project.id,
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveId: objective.objectiveId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId: environment.environmentId,
    protectedInputIds: [saved.protectedValueId],
    attemptId: randomUUID(),
  });
  let active = run;
  const invoke = async (tool, args = {}, actionId = randomUUID(), allowError = false) => {
    const result = await rpc("tools/call", {
      name: tool,
      arguments: { ...args, browserSessionId: active.browserSessionId, actionId },
    });
    let command = result.structuredContent?.command;
    const pending = !command && result.content?.find((c) => c.type === "text");
    const commandId = pending ? JSON.parse(pending.text).commandId : command?.id;
    for (let i = 0; !command || !["completed", "failed"].includes(command.state); i++) {
      assert.ok(commandId && i < 200, "NATIVE_COMMAND_RESULT_MISSING");
      await new Promise((r) => setTimeout(r, 250));
      const response = await rpc("tools/call", { name: "get_command", arguments: { commandId } });
      command = response.structuredContent?.command;
    }
    if (!allowError) {
      assert.equal(command.state, "completed", "NATIVE_COMMAND_FAILED:" + command.errorCode);
      assert.equal(command.result?.execution, "completed", "NATIVE_ACTION_NOT_COMPLETED:" + tool);
    }
    assert.ok(!JSON.stringify(command).includes(credential), "NATIVE_RESULT_SECRET_ESCAPED");
    return command;
  };
  const text = (command) =>
    command.result?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") ?? "";
  const snapshot = async () => text(await invoke("browser_snapshot"));
  const expectText = async (value) => {
    for (let i = 0; i < 8; i++) {
      if ((await snapshot()).includes(value)) return;
    }
    assert.fail("NATIVE_EXPECTED_STATE_MISSING:" + value);
  };
  const facts = async () => (await fetch("http://fixture:8080/login-facts")).json();
  await invoke("browser_navigate", { url: "http://fixture:8080/login-app" });
  const beforeStale = await facts();
  const stale = await invoke("browser_click", { target: "e999999" }, randomUUID(), true);
  assert.equal(stale.result?.execution, "tool_error", "STALE_TARGET_NOT_REPORTED_AS_ERROR");
  assert.deepEqual(await facts(), beforeStale, "STALE_TARGET_CHANGED_APPLICATION_STATE");
  await expectText("Sign in to the fictional workspace");
  await invoke("browser_type", { target: "input[type=email]", text: "rejected@example.invalid" });
  await invoke("browser_type_secret", {
    target: "input[type=password]",
    protectedValueId: saved.protectedValueId,
  });
  const before = await facts();
  await invoke("browser_click", { target: "form button" });
  await expectText("Credentials rejected");
  assert.equal((await facts()).logins, before.logins + 1);
  // A rejected application login must not destroy a still-owned browser.
  await invoke("browser_type", { target: "input[type=email]", text: "fictional@example.invalid" });
  const identity = randomUUID();
  await invoke("browser_click", { target: "form button" }, identity);
  await invoke("browser_click", { target: "form button" }, identity);
  await expectText("Signed in as fictional user");
  await expectText("Profile loaded");
  assert.equal((await facts()).logins, before.logins + 2, "AUTHENTICATION_REPLAYED");
  assert.equal((await facts()).profiles, before.profiles + 1, "NORMAL_POST_READ_NOT_COMPLETED");
  await invoke("browser_navigate", { url: "http://fixture:8080/login-app" });
  await expectText("Signed in as fictional user");
  await invoke("browser_click", { target: "#forbidden" });
  await expectText("Excluded service blocked");
  assert.equal((await facts()).forbidden, 0, "UNAPPROVED_SERVICE_REACHED");
  const screenshot = await invoke("browser_take_screenshot", {
    type: "png",
    evidenceTitle: "Authenticated workspace after reload",
    evidenceDescription:
      "Fictional split-origin login persists without a second submission; excluded service remains blocked.",
  });
  const artifactId = screenshot.result.media[0].artifactId;
  await invoke("browser_click", { target: "#logout" });
  await expectText("Signed out");
  await invoke("browser_navigate", { url: "http://fixture:8080/login-app" });
  await expectText("Sign in to the fictional workspace");
  assert.equal((await facts()).logouts, before.logouts + 1);
  const owned = await operator(`/runs/${run.runId}`);
  await call("finalize_run", {
    runId: run.runId,
    ownerGeneration: Number(owned.ownerGeneration),
    outcome: "passed",
    conclusion:
      "Rejected login preserved the browser; approved split-origin login/profile persisted after reload, duplicate action did not resubmit, excluded service stayed blocked, and logout persisted.",
  });
  const media = await api(`/runs/${run.runId}/media`);
  const video = media.items.find((i) => i.kind === "video");
  assert.ok(video && video.coverage === "complete", "NATIVE_RECORDING_NOT_COMPLETE");
  const response = await fetch(`http://api:4000/api/runs/${run.runId}/media/${video.index}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok, "NATIVE_RECORDING_NOT_READABLE");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp", "NATIVE_MP4_MISSING");
  writeFileSync("/tmp/qualified-native-login.mp4", bytes);
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", "/tmp/qualified-native-login.mp4", "-f", "null", "-"],
    { timeout: 60000, stdio: "pipe" },
  );
  assert.ok(
    !(
      await fetch(`http://api:4000/api/runs/${run.runId}/media/${video.index}`, {
        headers: { authorization: `Bearer ${otherToken}` },
      })
    ).ok,
    "CROSS_WORKSPACE_NATIVE_MEDIA_VISIBLE",
  );
  const report = await call("publish_mission_report", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    summary: "The fictional workspace supports sign-in, session continuity and sign-out.",
    safeReport: {
      presentation: {
        subject: "application",
        scope: ["Fictional split-origin workspace authentication"],
        checks: [
          {
            title: "Authenticated session survives reload",
            expected: "The signed-in workspace remains available",
            actual: "Signed-in workspace and profile were observed after reload",
            status: "matched_expectation",
            evidence: [{ runId: run.runId, artifactId }],
          },
        ],
        observations: [],
        limitations: ["Controlled fixture; not a Vitract business-journey assessment."],
      },
    },
  });
  assert.equal(
    (await api(`/reports/${report.reportId}`)).safeReport.presentation.checks[0].status,
    "matched_expectation",
  );
  assert.equal((await api(`/runs/${run.runId}`)).state, "ended");
  assert.ok(
    !(
      await fetch(`http://api:4000/api/runs/${run.runId}`, {
        headers: { authorization: `Bearer ${otherToken}` },
      })
    ).ok,
    "CROSS_WORKSPACE_RUN_VISIBLE",
  );
  assert.equal(
    (
      await fetch(`http://api:4000/api/operator/runs/${run.runId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    403,
    "CUSTOMER_GRANTED_OPERATOR_ACCESS",
  );
  assert.ok(
    !JSON.stringify(await operator(`/runs/${run.runId}`)).includes(credential),
    "OPERATOR_SECRET_ESCAPED",
  );
  // Preserve the release gate's missing-evidence guarantee on the native path.
  const limited = await call("start_mission", {
    projectId: project.id,
    title: "Unavailable native evidence",
    instruction: "Read only fictional fixture; preserve an injected evidence gap honestly.",
    provider: "human",
  });
  const limitedObjective = await call("create_objective", {
    missionId: limited.missionId,
    agentSessionId: limited.agentSessionId,
    objectiveOrder: 0,
    title: "Honest unavailable evidence",
    completionCriteria: { coverage: "explicit" },
  });
  const limitedFlow = await call("create_flow", {
    missionId: limited.missionId,
    agentSessionId: limited.agentSessionId,
    name: "Native evidence failure",
  });
  active = await call("start_run", {
    projectId: project.id,
    missionId: limited.missionId,
    agentSessionId: limited.agentSessionId,
    objectiveId: limitedObjective.objectiveId,
    flowId: limitedFlow.flowId,
    flowRevisionId: limitedFlow.flowRevisionId,
    environmentId: environment.environmentId,
    attemptId: randomUUID(),
  });
  await invoke("browser_navigate", { url: "http://fixture:8080/login-app" });
  await invoke("browser_snapshot");
  const { Client } = createRequire("/workspace/apps/api/package.json")("pg");
  const database = new Client({
    connectionString: process.env.FIXTURE_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  let receipt;
  try {
    await database.connect();
    await database.query("BEGIN READ ONLY");
    receipt = (
      await database.query(
        "SELECT c.object_key,c.object_digest,c.object_bytes FROM browser_evidence_chunks c JOIN browser_evidence_streams s ON s.id=c.stream_id WHERE s.session_id=$1 ORDER BY c.chunk_index LIMIT 1",
        [active.browserSessionId],
      )
    ).rows[0];
    await database.query("ROLLBACK");
  } finally {
    await database.end();
  }
  assert.ok(receipt, "NATIVE_AVAILABILITY_RECEIPT_MISSING");
  assert.match(receipt.object_key, /^objects\/[1-9][0-9]*\/[a-f0-9-]{36}\.json$/);
  const directory = path.resolve("/evidence", active.browserSessionId, "evidence");
  const filename = path.resolve(directory, receipt.object_key);
  assert.ok(filename.startsWith(directory + path.sep));
  const admitted = readFileSync(filename);
  assert.equal(admitted.length, Number(receipt.object_bytes));
  assert.equal(createHash("sha256").update(admitted).digest("hex"), receipt.object_digest);
  const held = filename + ".fixture-held-" + randomUUID();
  renameSync(filename, held);
  try {
    const ownedLimited = await operator(`/runs/${active.runId}`);
    await call("finalize_run", {
      runId: active.runId,
      ownerGeneration: Number(ownedLimited.ownerGeneration),
      outcome: "environment_failure",
      conclusion: "Injected unavailable evidence; application outcome remains unverified.",
    });
    const limitedFacts = await operator(`/runs/${active.runId}`);
    assert.ok(
      limitedFacts.evidence.some(
        (e) => e.state === "incomplete" && e.closureIssue === "object_unavailable",
      ),
      "NATIVE_UNAVAILABLE_EVIDENCE_NOT_RETAINED",
    );
    const limitedReport = await call("publish_mission_report", {
      missionId: limited.missionId,
      agentSessionId: limited.agentSessionId,
      summary: "The available evidence cannot establish an application result.",
      safeReport: {
        presentation: {
          subject: "application",
          scope: ["Fictional workspace with an unavailable recording"],
          checks: [
            {
              title: "Application behavior",
              actual: "Evidence is unavailable for this attempt",
              status: "inconclusive",
              evidence: [],
            },
          ],
          observations: [],
          limitations: ["No application outcome is inferred from missing evidence."],
        },
      },
    });
    const publicLimited = await api(`/reports/${limitedReport.reportId}`);
    assert.equal(publicLimited.safeReport.presentation.checks[0].status, "inconclusive");
    assert.equal(publicLimited.evidenceCoverage.complete, 0);
    assert.ok(!JSON.stringify(publicLimited).includes("object_unavailable"));
  } finally {
    renameSync(held, filename);
  }
  const { chromium } = createRequire("/workspace/packages/praxis/package.json")("playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRY_FIXTURE_BROWSER_CHANNEL
      ? { channel: process.env.SCRY_FIXTURE_BROWSER_CHANNEL }
      : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto("http://web:3000/");
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Sign in to Scry" });
    await dialog.getByLabel("Work email").fill("fixture-0@example.invalid");
    await dialog.getByLabel("Password", { exact: true }).fill("fixture-ui-signin-only");
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    await page.goto(`http://web:3000/dashboard/reports/${report.reportId}`);
    await page
      .getByRole("heading", { name: "Authenticated session survives reload", exact: true })
      .waitFor();
    // A check-linked report correctly selects its exact screenshot first.
    // Select the recording explicitly before asserting video playback.
    await page
      .getByRole("group", { name: "Select evidence" })
      .getByRole("button", { name: /Recording/ })
      .click();
    await page.locator(".native-evidence video").waitFor();
    const codec = await page
      .locator(".native-evidence video")
      .evaluate((video) => video.canPlayType('video/mp4; codecs="avc1.42E01E"'));
    if (codec) {
      await page.locator(".native-evidence video").evaluate((video) => video.play());
      await page.waitForFunction(
        () => document.querySelector(".native-evidence video")?.currentTime > 0.1,
      );
      await page.locator(".native-evidence video").evaluate((video) => video.pause());
      console.log("DEPLOYED_SUPPORTED_BROWSER_PLAYBACK_PASS");
    } else {
      assert.ok(!process.env.SCRY_FIXTURE_BROWSER_CHANNEL, "SUPPORTED_BROWSER_CODEC_MISSING");
      console.log(
        "DEPLOYED_DASHBOARD_CODEC_UNAVAILABLE: bundled Chromium lacks H.264; FFmpeg decode and delivery passed, actual Chrome playback remains a separate check.",
      );
    }
    assert.ok(!(await page.locator("body").innerText()).includes(credential));
    mkdirSync("/evidence/qualification-ui", { recursive: true, mode: 0o700 });
    await page.screenshot({
      path: "/evidence/qualification-ui/native-login-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelector(".sidebar")?.getBoundingClientRect().right <= 0,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "NATIVE_REPORT_MOBILE_OVERFLOW",
    );
    await page.screenshot({
      path: "/evidence/qualification-ui/native-login-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`http://web:3000/dashboard/runs/${active.runId}`);
    await page.getByText("Recording unavailable", { exact: true }).waitFor();
    assert.equal(await page.locator("video").count(), 0);
    const body = await page.locator("body").innerText();
    assert.ok(body.includes("Do not infer an application result"));
    assert.ok(!body.includes("object_unavailable") && !body.includes(credential));
    await page.screenshot({
      path: "/evidence/qualification-ui/unavailable-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelector(".sidebar")?.getBoundingClientRect().right <= 0,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "NATIVE_UNAVAILABLE_MOBILE_OVERFLOW",
    );
    await page.screenshot({
      path: "/evidence/qualification-ui/unavailable-mobile.png",
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
  console.log("DEPLOYED_AUTHENTICATED_DASHBOARD_PASS");
  console.log(
    "DEPLOYED_NATIVE_AUTHENTICATION_PASS " +
      JSON.stringify({
        missionId: mission.missionId,
        runId: run.runId,
        reportId: report.reportId,
        artifactId,
        videoDurationMs: video.durationMs,
      }),
  );
  return { runId: run.runId, reportId: report.reportId };
}
