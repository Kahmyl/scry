# Deterministic recovery and calibration

Safe-state snapshots flow only from an evidence-safe browser into a protected capsule or an independently restored safe browser. State from a protected capsule is never accepted. The parked safe browser is the preferred continuation source because it never observes the generated secret; clean recreation and approved reauthentication are explicit fallbacks. A one-time protected mutation is never replayed.

Calibration contracts are project-scoped immutable revisions. Agent-driven calibration begins with an immutable rehearsal proposal derived from the source Flow's protected operation. The worker executes the authenticated setup journey through the ordinary controlled executor, stops before the reveal mutation, destroys rehearsal artifacts, derives the safe structural fingerprint, and appends an attested revision. An owner or admin records one append-only approval or rejection decision through MCP, dashboard, or API. Unattended execution verifies the approved revision and recomputes the fingerprint before reveal. Drift returns `CALIBRATION_REQUIRED` before mutation.

The proposal and attested revision are separate because fingerprints are never filled into an existing revision. This preserves immutable domain history while allowing Scry—not an agent—to derive structural evidence.

Adapters are built into the Scry release and selected by registered identifiers. User-supplied executable adapter code is prohibited. Clipboard and network extraction operate only inside protected intervals, safe-exit adapters must prove a boundary, and revocation is attempted once within a bounded timeout. Every unresolved compromise remains inactive and creates a durable credential incident.
