# Phase 2: Runtime safety and policy enforcement

## Goal

Treat submitted plans and applications under test as untrusted. Enforce project
policy inside the browser worker, independently of plan generation.

## Deliverables

- [x] Exact-origin enforcement for every HTTP(S) browser request and redirect.
- [x] Private, loopback, link-local, and local-host destination detection.
- [x] DNS resolution checks for allowed hostnames.
- [x] Popup, new-page, download, and service-worker blocking.
- [x] Action capability classification.
- [x] Auditable `policy.rejected` events that fail the active step.
- [x] Secret redaction in events, diagnostics, network evidence, and reports.
- [x] Adversarial unit and real-browser tests.

## Security boundary

The worker performs runtime enforcement even when the API or client already
validated the plan. A plan's origins can only narrow project policy; it cannot
enable private-network access, popups, or downloads.

## Exit gate

1. Cross-origin subresources and redirects are aborted.
2. Private destinations require `allowPrivateNetwork: true`.
3. Popups and downloads cannot complete.
4. Every rejection creates an append-only policy event.
5. Resolved secrets do not appear in JSON reports, JSONL events, or text evidence.
6. `pnpm test` and `pnpm typecheck` pass.
