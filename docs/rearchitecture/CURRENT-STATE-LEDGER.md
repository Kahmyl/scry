# Four-Boundary Reset Current-State Ledger

## Frozen baseline

- Source commit: `0c9cf69cd91eaad1bcd2b11af0c2a8b76d676398`
- Immutable tag: `four-boundary-reset-baseline`
- Source-tree digest: `ecbe1e8d158f61fec436b9e3d8fbaa0967ff0c0f1ba8b6fe5a11b43aeceeabdb`
- Schema fingerprint: `daa811d7119f9bdf1d64cca1ea72a0ca8ce4f3fac4c80c277043d1b3afb21e5b`
- Starting capability identity: `browser-runtime-v2.7`
- Starting schema version: `8`
- Deployed image: `kahmyl/scry@sha256:6867d5c2bfdb86f7199ce6edf63281b38ceae80035bb2cb8188b19dad0ba5d64`
- Required qualification: successful, GitHub Actions run `33816326698`
- Staging deployment: successful and reported healthy/active, GitHub Actions run `33816893051`

## Current deployed entrypoints

- API: `apps/api/src/browser-v2-main.ts`
- Worker: `apps/api/src/browser-v2-worker.ts`
- Migration: `apps/api/scripts/migrate-browser-v2.ts`
- MCP stdio: `apps/mcp/src/browser-v2-main.ts`
- MCP HTTP: `apps/mcp/src/browser-v2-http.ts`
- Web: `apps/web/src/main.tsx`

The semantic `main.ts`, `worker.ts`, and old MCP entrypoints are retirement markers rather than the deployed authority at this baseline.

## Current execution ownership reality

The deployed execution roots reach:

- application `browser-execution` code;
- `@scry/browser-runtime`;
- `@scry/contracts`.

They do not reach the repository's Praxis, Veil, Chronicle, Assurance, Executor, Policy, or Observability packages.

This means repository package names and older architecture prose cannot be used as evidence of deployed ownership.

## Browser mechanics

Production-reachable direct Playwright imports currently exist in:

- the API browser worker engine;
- the API browser command repository;
- browser-runtime recording;
- browser-runtime offline rendering.

The desired Praxis-only browser-mechanics invariant is therefore not yet true.

## Protection and evidence

The active closure includes browser-runtime source named for:

- classification;
- protection authority;
- sanitization;
- protected capture vaulting;
- authenticated evidence storage;
- recording;
- offline rendering.

Application browser-execution source also contains protected keyring, cipher, lifecycle, command, execution, and publication persistence concerns.

The exact responsibility disposition of these behaviors will be established before any ownership move.

## Older repository machinery

Large API, MCP, Executor, Policy, Praxis, Veil, Chronicle, Observability, and Assurance trees remain in the repository.

Most are not reachable from deployed runtime roots.

Their existence is not evidence that they are authoritative. Their non-reachability is also not sufficient evidence that they may be deleted.

Each displaced area must receive a capability review and one Phase 1 disposition before later deletion.

## Current dependency observations

The workspace package manifest graph contains no Scry package cycle.

However the API manifest declares dependencies on many packages that the deployed source closure does not reach. Manifest dependencies must therefore not be used as production-reachability evidence.

## Governance consequences

During this reset:

1. Working behavior is characterized from the deployed browser baseline.
2. Capabilities are moved only after identifying active consumers, tests, persistence, failure semantics, and privacy/security boundaries.
3. Older code is salvaged only when it contains a proven required capability.
4. No unreachable package is restored into production simply to make package names resemble the target architecture.
5. No deletion occurs until required behavior has a canonical owner and zero remaining consumer reachability is proven.
6. Assurance remains independent of synchronous production execution.
7. Historical runtime-version names in this ledger are baseline evidence only and are not the desired final naming scheme.
