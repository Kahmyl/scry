# MVP boundary

Status: historical initial execution-slice boundary

This document records the scope of Scry's original Chromium execution slice.
It does not define the intended product MVP. See the canonical
[Scry technical brief](technical-brief.md) for the product direction and MVP
outcome. Capabilities listed as excluded below were excluded from this initial
delivery slice and are not necessarily excluded from the intended MVP.

## Product statement

Scry accepts a structured browser test plan from a human or agent,
validates it against an execution policy, runs it in an isolated Playwright
context, and returns a durable evidence-backed report.

## Responsibility split

Codex or another intelligent client:

- Interprets natural-language requirements.
- Produces a structured Scry test plan.
- Reads the structured report.
- Fixes the application and requests an exact rerun.

Scry:

- Validates plan shape and protocol compatibility.
- Enforces policy independently of the client.
- Executes only supported actions.
- Captures events, assertions, diagnostics, and artifacts.
- Preserves immutable plan and configuration snapshots.
- Reruns the exact stored plan without replanning.

## MVP capabilities

- Chromium.
- One allowed HTTP(S) origin per environment.
- Deterministic, precomputed plans.
- Semantic locators with test-id and CSS fallbacks.
- Navigation, interaction, waiting, assertion, and screenshot actions.
- Configurable action, navigation, and duration budgets.
- Fresh browser context for each attempt.
- Screenshots, Playwright trace, console errors, page errors, and failed requests.
- Structured reports and exact-plan reruns.
- Dashboard/API and MCP access.

## Explicitly excluded

- Scry-hosted LLM calls.
- Natural-language planning in the dashboard.
- Runtime replanning or autonomous exploration.
- Arbitrary JavaScript evaluation.
- Production-site testing by default.
- Cross-origin journeys.
- File uploads, downloads, popups, purchases, and destructive actions.
- Visual design comparison.
- Firefox, WebKit, proxy, and geographic execution.
- Scheduled suites and multi-tenant access control.

## Success scenario

1. Codex converts a feature requirement into a Scry-compatible plan.
2. Scry validates the plan and rejects unsafe capabilities.
3. Scry runs the plan against an explicitly permitted staging origin.
4. A failed assertion is returned with its step, screenshot, and diagnostics.
5. Codex fixes the application.
6. Scry reruns the exact stored plan.
7. Both attempts remain independently auditable.
