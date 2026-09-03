# Mission suspension at agent-session boundaries

## Observed gap

The browser execution v2 model moves a mission to `running` when a run starts, but ending or losing the active agent session does not durably move a nonterminal mission out of that state. The current mission states include `planning`, `running`, `blocked`, `awaiting_user`, and terminal outcomes; none expresses a resumable mission whose agent session has ended.

This can leave the dashboard showing a mission as running after no agent session remains capable of advancing it.

## Why this is outside the minimal UI release

Correcting the label in the UI would hide the underlying state mismatch. A complete repair changes the database constraint and shared contracts, defines the transaction between agent-session termination and mission suspension, establishes resume and idempotency behavior, and prevents a stale owner from changing a resumed mission. It therefore crosses the API, worker, MCP, and dashboard boundaries.

## Required behavior for a later implementation

- Add an explicit resumable mission state such as `suspended`, with a reason and timestamp.
- On normal session closure, interruption, process loss, or expired ownership, atomically end the session and suspend any nonterminal mission that has no other active owner.
- Do not suspend a mission while a dispatched effect has an unresolved outcome; expose that condition accurately and require reconciliation.
- Resume through a durable transition that creates or binds a new agent session without discarding existing flows, runs, evidence, or the mission instruction.
- Fence stale sessions so they cannot advance the mission after a resume.
- Show the durable state in the dashboard rather than inferring activity from timestamps.
- Verify normal disconnect, crash, expired lease, concurrent resume, multiple flows and runs, terminal missions, and unresolved dispatched effects.

This item is intentionally not implemented as part of the responsive dashboard cleanup.
