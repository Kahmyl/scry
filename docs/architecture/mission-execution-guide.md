# Mission execution guide

Scry readiness is authoritative. Agents must create and validate a revisioned execution plan, activate it, and inspect the orchestration projection before requesting any Run. Objective order is presentation only; dependencies define sequencing.

- Split objectives when they have independent completion criteria, risk boundaries, environments, or reusable execution definitions.
- Add a dependency only when the downstream objective cannot be validly executed before the prerequisite passes. Objectives without a dependency path may run in parallel.
- Bind every automated objective to one immutable Flow revision and environment. Mark work manual when Scry cannot execute it; do not create placeholder Runs.
- Never infer credentials, calibration, protected-mutation approval, or Live authorization. Owners/admins grant scoped Mission execution authorizations first; plans reference their opaque IDs, and expired, revoked, cross-objective, or cross-environment approvals are rejected.
- Activate only an explicitly approved plan. Scry limits each project to three queued or running objectives and rejects direct starts that are not ready.
- After failure, inspect the recorded blocker and causal activity. Independent branches continue; dependent branches wait or block. Product, plan, policy, and privacy failures require review and are not automatic retries.
- Review recommendation eligibility and scoring before explicitly accepting evidence. A recommendation is not accepted evidence.
- Generate a deterministic report draft after required objectives reach terminal states. Review stale-state and privacy gates before explicit publication.

Every mutating MCP command carries `missionId`, `objectiveId` when scoped, and an active `agentSessionId`. A later agent starts by reading the active plan, orchestration projection, blockers, accepted evidence, activities, and resume pointer.
