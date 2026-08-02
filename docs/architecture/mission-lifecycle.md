# Mission lifecycle

Mission owns instruction-level progress, evidence selection, and continuation. All mutations carry an explicit `missionId` and `agentSessionId`; objective work also carries `objectiveId`. The API validates that all three belong to one project and that the session is active.

```text
Project
└── Mission
    ├── Objectives
    ├── Agent sessions
    ├── Reusable or local Flow links
    ├── Classified Runs
    ├── Accepted evidence per objective
    ├── Append-only activity and causal relations
    ├── Durable resume pointer
    └── Immutable report revisions
```

## Invariants

1. A Run belongs to one Mission and one Objective for its entire lifetime.
2. Reusable Flows are associated through links rather than assigned to one Mission owner.
3. Mission state changes and their activity records commit transactionally.
4. Only passed Runs with safe, available artifacts and no unresolved credential incident can be accepted.
5. Publishing requires terminal required objectives, conclusions for blocked/skipped work, and accepted evidence for passed objectives.
6. Published reports are immutable snapshots; later publication supersedes rather than edits.
7. Resume behavior comes only from the persisted pointer.
8. Stateless MCP calls repeat explicit Mission context; transport memory is never authoritative.

## Cutover

This model is a clean pre-production cutoff. Writers must be stopped, existing application records and queues cleared under the guarded reset procedure, the squashed baseline applied, and API/worker/MCP/web restarted on one release and schema fingerprint. No legacy Flow or Run backfill is supported.
