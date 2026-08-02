# Praxis cutoff record

## Cutoff

Praxis contract version 1, runtime version 1, and scoring policy version 1 are the minimum and only admitted interaction versions at this cutoff. New executable work is rejected unless API, worker, browser runtime, schema fingerprint, and all three Praxis versions agree. MCP also rejects authoring and execution against an API that does not advertise the cutoff versions.

The consumer rollback flag and the legacy grounding event and MCP projections have been removed. `get_run.observation.praxis` is the authoritative interaction record. Historical stored grounding data remains readable at the database level for retention and audit purposes, but it is not an execution authority or public retry signal.

Direct browser control is restricted to the Praxis dispatcher and reviewed browser/session, recording, privacy, protected-transaction, acquisition, and adapter boundaries recorded in the interaction inventory. Navigation initiated by the executor remains a lifecycle operation outside Praxis.

## Operational thresholds

Page immediately when unknown mutation outcomes increase above zero for protected operations, privacy-channel violations occur, or mixed Praxis versions are detected. Alert on semantic p95 or visual/OCR p95 crossing the checked-in performance profile, cancelled expensive work exceeding 250 ms, target ambiguity or drift materially exceeding the accepted corpus, browser runtime health failure, or adapter-specific failure spikes. Metrics must use safe bounded identifiers and must not contain origins, customer paths, target text, screenshots, OCR buffers, or protected values.

## Rollback

Rollback deploys the previous complete, schema-compatible release as a unit across API, worker, MCP, and web. Components from different releases or Praxis versions must never be mixed. The cutoff does not permit restoring a code-level consumer bypass. Before retrying any interrupted transaction, inspect its Praxis mutation outcome; an `unknown` outcome is never retried and requires reconciliation or user-directed recovery.
