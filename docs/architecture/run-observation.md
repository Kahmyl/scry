# Canonical run observation

`RunObservation` is the only public detail model for an active or terminal run.
It is assembled by `RunObservationService` from persisted execution records and
returned by `GET /api/runs/:runId`. MCP and the dashboard consume that same
endpoint. Artifact bytes remain separate `ArtifactStore` resources.

## Invariants

- A terminal attempt declares one typed outcome and failure provenance.
- Step action, readiness, assertions, and evidence remain independent channels.
- The observation describes only the current attempt; prior attempts remain
  bounded metadata in `attempts` and cannot be mixed into current evidence.
- Every available artifact has safe metadata and a stable
  `scry://artifact/{id}` resource. Storage keys are never public.
- Video and trace artifacts must be represented in the authoritative artifact
  timeline, and every timeline artifact reference must resolve in the manifest.
- Quarantined, destroyed, incomplete, and failed artifacts never receive a
  readable resource identifier.
- Empty active sections are `pending`. Terminal integrity omissions are typed
  failures rather than silently empty arrays.
- Events are supporting audit facts; clients never reconstruct step truth or
  artifact timelines from them.
- `safeActions` is authoritative for client follow-up affordances.

## Consumer boundary

- API: `GET /api/runs/:runId` returns `RunObservation`.
- MCP: `get_run` returns the same aggregate under `observation`.
- Dashboard: report views render the aggregate directly.
- Artifact access: `get_artifact`, range, pagination, search, and HTML extraction
  start from IDs in the observation manifest.

There is no separate report read model or recording-timeline reconstruction.
HTML pages and agent reports are presentations of `RunObservation`, not sources
of execution truth.
