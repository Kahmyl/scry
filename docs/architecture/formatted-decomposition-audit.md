# Formatted decomposition audit

## Decision

Source formatting is now a repository contract rather than an editor preference. Prettier is checked in, `pnpm format` performs the mechanical rewrite, and `pnpm format:check` verifies it. Architectural size analysis must use formatted source because compressed one-line implementations conceal ownership and review risk.

Line count is only a discovery signal. A large declarative corpus, campaign, fixture, or schema table does not require the same response as a large stateful runtime. Production modules are classified for review at 350 lines, major decomposition pressure at 500 lines, and critical pressure at 800 lines. Splits must follow authority, lifecycle, state, and dependency boundaries rather than arbitrary line quotas.

## Corrected findings

The earlier assessment that MCP registration was substantially decomposed was incorrect. Once normalized, `apps/mcp/src/server.ts` is more than 1,300 lines and still owns most product-domain registrations. Extracting server composition, registry primitives, Core tools, and Artifact tools established useful seams but did not complete the domain split.

The normalized audit also identifies these critical production boundaries:

- MCP tool registration;
- Executor transaction orchestration;
- Praxis grounding;
- current-contract aggregation;
- web settings and integration setup;
- Mission and Flow application services.

Major boundaries include Authoring and Orchestration services, Praxis runtime and transaction coordination, protected transaction coordination, dashboard observation views, web API access, and Run observation projection.

## Required decomposition sequence

### 1. MCP registration

Reduce `server.ts` to server construction plus ordered registrar calls. Registrars own cohesive tools and no transport lifecycle:

- Mission lifecycle and objectives;
- Mission orchestration and authorization;
- project environments and credentials;
- Flow discovery and calibration;
- Flow drafts, probes, compilation, and publication;
- authenticated-session leases;
- Runs, Praxis observation, and Veil preferences;
- protected recovery and Mission evidence/reporting;
- artifacts;
- core capability discovery.

The MCP test suite must continue proving the exact tool-name set, schemas, annotations, instructions, and client routes.

### 2. Executor transaction orchestration

Keep `executePlan` as the public façade. Extract browser/session lifecycle, step orchestration, assertion evaluation, request interception, outcome classification, and final report assembly. Praxis and Veil remain injected authorities; the façade must not recreate grounding or privacy decisions.

### 3. Praxis internals

Split grounding by observation acquisition, candidate inventory, evidence fusion/scoring, deterministic selection, revalidation, and diagnostic projection. Split runtime transaction coordination from strategy dispatch and verification. Preserve one mutation boundary and one terminal result.

### 4. API application services

- Mission: definition/session lifecycle, objectives, evidence/classification, reports/resume pointer, and read projection.
- Flow: capability/readiness projection, validation, calibration binding, and Run creation.
- Authoring: draft lifecycle, probe lifecycle, compilation, and publication.
- Orchestration: plan validation/activation, readiness calculation, scheduling, and control commands.

Controllers remain transport adapters. Transactions stay at the application-operation boundary and repositories retain persistence ownership.

### 5. Web surfaces and contracts

Split Settings into credentials, MCP setup, integrations, workspace, and account surfaces. Split large observation views by report section without duplicating data fetching. Divide `current.ts` by schema family and retain a compatibility barrel so published imports do not change.

## Verification gates

Each decomposition slice must pass formatting, typecheck, focused characterization, package tests, boundary inventories, Praxis and Veil change gates, and `git diff --check`. Browser campaigns are required only when a slice touches Executor, Praxis, Veil, browser adapters, or their contracts. MCP domain moves require exact registry compatibility tests. Formatting-only changes must not be mixed with behavioral changes in review.
