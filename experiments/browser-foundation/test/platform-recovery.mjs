import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const mode = process.argv[2] ?? "prepare";
const file = "/integration-evidence/qualification/recovery.json";
const { token } = await (await fetch("http://fixture:8080/fixture-input")).json();
const api = async (path, body) => {
  const r = await fetch("http://api:4000/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`API ${path} ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const wait = async (id) => {
  for (let i = 0; i < 300; i++) {
    const command = await api(`/browser-commands/${id}`);
    if (["completed", "failed"].includes(command.state)) return command;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Command did not settle");
};
if (mode === "prepare") {
  const project = await api("/projects", {
    name: "Controlled recovery " + randomUUID().slice(0, 8),
  });
  const environment = await api(`/projects/${project.id}/environments`, {
    name: "Owned recovery fixture",
    baseOrigin: "http://target:8081",
    disclosureMode: "confidential",
    idempotencyKey: randomUUID(),
  });
  const mission = await api("/missions", {
    projectId: project.id,
    title: "Native platform interruption",
    instruction: "Verify independent shutdown and admitted-prefix recovery without replay.",
    provider: "human",
    idempotencyKey: randomUUID(),
  });
  const objective = await api(`/missions/${mission.missionId}/objectives`, {
    agentSessionId: mission.agentSessionId,
    title: "Recover evidence without repeating save",
    completionCriteria: { notReplayed: true },
    objectiveOrder: 0,
    idempotencyKey: randomUUID(),
  });
  const flow = await api(`/missions/${mission.missionId}/flows`, {
    agentSessionId: mission.agentSessionId,
    name: "Interruption",
    idempotencyKey: randomUUID(),
  });
  const run = await api("/runs", {
    projectId: project.id,
    missionId: mission.missionId,
    objectiveId: objective.objectiveId,
    agentSessionId: mission.agentSessionId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId: environment.environmentId,
    idempotencyKey: randomUUID(),
  });
  const command = await api(`/browser-sessions/${run.browserSessionId}/commands`, {
    idempotencyKey: randomUUID(),
    command: {
      kind: "browser_tool",
      tool: "browser_navigate",
      args: { url: "http://target:8081/" },
    },
  });
  assert.equal((await wait(command.commandId)).state, "completed");
  await mkdir("/integration-evidence/qualification", { recursive: true });
  await writeFile(file, JSON.stringify({ ...run, missionId: mission.missionId }));
  console.log(JSON.stringify({ prepared: true, ...run }));
} else {
  const run = JSON.parse(await readFile(file, "utf8"));
  if (mode === "cancel-preparation") {
    const owned = await api(`/runs/${run.runId}`);
    await api(`/runs/${run.runId}/finalize`, {
      ownerGeneration: Number(owned.ownerGeneration),
      outcome: "cancelled",
      conclusion:
        "Preparation closed before fault injection to keep the heavy-client qualification batch bounded.",
    });
    console.log(JSON.stringify({ preparationClosed: true, runId: run.runId }));
  } else if (mode === "dispatch") {
    const writesBefore = (await (await fetch("http://target:8081/facts")).json()).writes;
    const command = await api(`/browser-sessions/${run.browserSessionId}/commands`, {
      idempotencyKey: "interrupted-save-" + randomUUID(),
      command: { kind: "browser_tool", tool: "browser_click", args: { target: "#slow" } },
    });
    await writeFile(file, JSON.stringify({ ...run, writesBefore, commandId: command.commandId }));
    for (let i = 0; i < 200; i++) {
      if ((await (await fetch("http://target:8081/facts")).json()).writes > writesBefore) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await (await fetch("http://target:8081/facts")).json()).writes, writesBefore + 1);
    console.log(JSON.stringify({ appliedOnce: true, commandId: command.commandId }));
  } else if (mode === "verify") {
    const command = await wait(run.commandId);
    assert.ok(command.result, "No durable dispatch/result receipt");
    assert.equal(
      (await (await fetch("http://target:8081/facts")).json()).writes,
      run.writesBefore + 1,
    );
    const owned = await api(`/runs/${run.runId}`);
    try {
      await api(`/runs/${run.runId}/finalize`, {
        ownerGeneration: Number(owned.ownerGeneration),
        outcome: "environment_failure",
        conclusion: "Interrupted once-applied action; retain native prefix without replay.",
      });
    } catch (error) {
      // A replacement owner advances the generation during close. The caller
      // refreshes that factual generation; this does not repeat a browser action.
      if (!String(error.message).includes("OWNER_FENCED")) throw error;
      const current = await api(`/runs/${run.runId}`);
      await api(`/runs/${run.runId}/finalize`, {
        ownerGeneration: Number(current.ownerGeneration),
        outcome: "environment_failure",
        conclusion: "Recovered native prefix without browser action replay.",
      });
    }
    const media = await api(`/runs/${run.runId}/media`);
    const video = media.items.find((m) => m.kind === "video");
    assert.ok(video, "Finalized native prefix missing");
    assert.equal(video.coverage, "partial");
    const response = await fetch(`http://api:4000/api/runs/${run.runId}/media/${video.index}`, {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), video.artifactId);
    const recording = "/integration-evidence/qualification/recovered-recording.mp4";
    await writeFile(recording, bytes, { mode: 0o600 });
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
          recording,
        ],
        { encoding: "utf8", timeout: 10000 },
      ),
    );
    assert.equal(probe.streams[0].codec_name, "h264");
    assert.equal(probe.streams[0].width, 1280);
    assert.equal(probe.streams[0].height, 720);
    assert.ok(Number(probe.format.duration) > 0);
    const current = await api(`/runs/${run.runId}`);
    assert.ok(current.evidence.some((e) => e.state === "incomplete"));
    await writeFile(
      file,
      JSON.stringify(
        { ...run, verified: true, command, media: media.items, probe, videoBytes: bytes.length },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        verified: true,
        commandState: command.state,
        result: command.result,
        video,
        runId: run.runId,
      }),
    );
  }
}
