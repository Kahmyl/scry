export function normalizeDriverArguments(args) {
  const normalized = args.filter((argument) => argument !== "--");

  return {
    audit: normalized.includes("--audit"),
    affectedArguments: normalized.filter((argument) => argument !== "--audit"),
  };
}

export function workspaceFromResultId(id) {
  const match = /^(@scry\/[^:]+):/.exec(id);

  return match?.[1] ?? null;
}

export function failedWorkspaceNames(results) {
  return [
    ...new Set(
      results
        .filter((result) => result.passed === false)
        .map((result) => workspaceFromResultId(result.id))
        .filter(Boolean),
    ),
  ].sort();
}

export function focusedWorkspaceNames(plan) {
  return plan.selected
    .filter((workspace) => workspace.verification?.testMode === "focused")
    .map((workspace) => workspace.name)
    .sort();
}

export function workspaceWasFullyHealthy(workspace, results) {
  if (workspace.verification?.testMode !== "full") {
    return false;
  }

  const relevant = results.filter((result) => workspaceFromResultId(result.id) === workspace.name);

  if (relevant.length === 0) {
    return false;
  }

  return relevant.every((result) => result.passed);
}

export function mergeFailureState({
  priorWorkspaces,
  currentFailedWorkspaces,
  fullChecks,
  fullyHealthyWorkspaces,
  knownWorkspaces,
}) {
  const failures = new Set(currentFailedWorkspaces);

  const checked = new Map(fullChecks.map((check) => [check.workspace, check.passed]));

  for (const workspace of priorWorkspaces) {
    if (fullyHealthyWorkspaces.includes(workspace)) {
      continue;
    }

    if (checked.has(workspace)) {
      if (checked.get(workspace) === false) {
        failures.add(workspace);
      }

      continue;
    }

    if (knownWorkspaces.includes(workspace)) {
      failures.add(workspace);
    }
  }

  for (const check of fullChecks) {
    if (!check.passed) {
      failures.add(check.workspace);
    }
  }

  return [...failures].sort();
}
