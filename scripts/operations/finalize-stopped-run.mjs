import { pathToFileURL } from "node:url";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const runTerminal = new Set(["passed", "failed", "cancelled", "infrastructure_error"]);
const sessionTerminal = new Set(["completed", "failed", "cancelled"]);

/** Operator-only cleanup of one explicitly selected stopped Run. Uses the
 * running API's service credential locally; never prints or exports it. */
export async function finalizeStoppedRun({
  missionId,
  runId,
  confirmation,
  token,
  fetchFn = fetch,
}) {
  if (!uuid.test(missionId ?? "") || !uuid.test(runId ?? "")) throw Error("RUN_IDENTITY_REQUIRED");
  if (confirmation !== "FINALIZE_STOPPED_RUN_AS_INCOMPLETE")
    throw Error("EXPLICIT_FINALIZATION_REQUIRED");
  if (!token) throw Error("OPERATOR_CREDENTIAL_REQUIRED");
  async function request(path, body) {
    const response = await fetchFn(`http://127.0.0.1:4000/api${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(65000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw Object.assign(Error(`RUN_API_HTTP_${response.status}`), {
        code: detail?.code ?? detail?.message?.code,
      });
    }
    return response.json();
  }
  const inspect = async () => {
    const run = await request(`/operator/runs/${runId}`);
    if (run.id !== runId || run.missionId !== missionId) throw Error("RUN_SCOPE_MISMATCH");
    return run;
  };
  const before = await inspect();
  const released = (run) =>
    runTerminal.has(run.state) && sessionTerminal.has(run.browserSessionState);
  if (released(before))
    return {
      finalized: true,
      replay: true,
      runId,
      state: before.state,
      outcome: before.outcomeClassification,
      browserReleased: true,
    };
  if (runTerminal.has(before.state)) throw Error("TERMINAL_RUN_REQUIRES_OPERATOR_REVIEW");
  if (before.runtimeAdapter !== "playwright_mcp" || !Array.isArray(before.activity))
    throw Error("STOPPED_NATIVE_RUN_REQUIRED");
  if (before.activity.some((action) => !["completed", "failed"].includes(action.state)))
    throw Error("RUN_ACTION_STILL_ACTIVE");
  const generation = Number(before.ownerGeneration);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw Error("CURRENT_OWNER_REQUIRED");
  const finalize = (ownerGeneration) =>
    request(`/runs/${runId}/finalize`, {
      ownerGeneration,
      outcome: "blocked",
      conclusion:
        "Owner-authorized finalization of a stopped, incomplete assessment while the client connection is unavailable. Preserve all evidence and uncertain outcomes. No application action or invitation acceptance is asserted.",
    });
  try {
    await finalize(generation);
  } catch (error) {
    if (error.code !== "SCRY_BROWSER_OWNER_FENCED") throw error;
    // Failure closure can recover a lost worker and advance its generation.
    // Re-read that fact once; the API preserves sealed evidence and never
    // replays an application action when finalization is retried.
    const current = await inspect();
    const recoveredGeneration = Number(current.ownerGeneration);
    if (!Number.isSafeInteger(recoveredGeneration) || recoveredGeneration <= generation)
      throw Error("OWNER_RECOVERY_UNCONFIRMED");
    await finalize(recoveredGeneration);
  }
  const after = await inspect();
  if (!released(after) || after.outcomeClassification !== "blocked")
    throw Error("RUN_RELEASE_UNCONFIRMED");
  return {
    finalized: true,
    replay: false,
    runId,
    state: after.state,
    outcome: "blocked",
    browserReleased: true,
  };
}

if (
  process.argv[1] === "-" ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  try {
    const result = await finalizeStoppedRun({
      missionId: process.argv[2],
      runId: process.argv[3],
      confirmation: process.argv[4],
      token: process.env.SCRY_SERVICE_TOKEN,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Raw HTTP bodies, errors and credentials are never an operator log surface.
    console.error(
      /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "")
        ? error.message
        : "RUN_FINALIZATION_UNAVAILABLE",
    );
    process.exitCode = 1;
  }
}
