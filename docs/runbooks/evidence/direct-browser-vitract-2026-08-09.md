# Direct Browser Vitract Acceptance Evidence

Date: 2026-08-09  
Target: `https://preview.vitract.com`  
Verdict: pass for the implemented direct-browser boundary and authorized Test Mode API scope

## Scry Boundary Results

- Three consecutive login gates reached the Partner Portal and Developer Test Mode without Mission, Flow, Probe, compilation, or Run state.
- The steady login/Developer journey used two client calls: session start and one grouped turn.
- A grouped login, Developer navigation, and documentation popup turn completed in approximately 4.4-5.4 seconds. Browser/session startup was approximately 6.3 seconds on the final campaign host.
- The documentation popup remained in the same direct session and was admitted only because its origin was deployment-configured and request-authorized.
- A generated Test API secret was captured atomically into encrypted Scry credential storage. No plaintext secret appeared in tool responses, transcripts, logs, or this report.
- The full Test Mode campaign passed through the interactive documentation using the encrypted secret reference.
- Live Mode was selected and its Developer view was inspected. No Live application, credential, order, notification, charge, or other mutation was performed.

## Test Mode API Results

Passed checks:

- authenticated order listing;
- inline client order creation;
- identical idempotent replay returning the same order;
- changed payload with the same idempotency key rejected with `PARTNER_IDEMPOTENCY_CONFLICT`;
- inline practitioner order creation;
- client order using an existing client ID;
- practitioner order using an existing practitioner ID;
- retrieval of a newly created order;
- list pagination and documented status filtering;
- missing owner identity rejected with `VALIDATION_ERROR`;
- simultaneous ID and inline identity rejected with `VALIDATION_ERROR`;
- nonexistent client ID rejected with `PARTNER_CLIENT_NOT_FOUND`;
- client `on_site` delivery rejected with `PARTNER_DELIVERY_MODE_NOT_ALLOWED_FOR_OWNER`;
- invalid credentials rejected with `INVALID_PARTNER_CREDENTIALS`.

Four sandbox orders and two sandbox identities were created. The public API documentation exposes no deletion endpoint, so the campaign could not safely clean them up. Resource IDs are retained in the sanitized command artifact, not repeated here.

## Findings Fixed During Acceptance

1. High: popup navigation originally returned before the documentation tab became session-owned. Fixed by waiting only for controls that declare a new browsing context and validating the popup origin.
2. High: a failed credential reveal could leave an unknown creation outcome. Fixed with atomic click/capture/encrypted-registration and terminal unknown-outcome handling; the first uncertain credential was reconciled and revoked before retry.
3. Medium: repeated controls in API documentation were ambiguous. Fixed with heading-scoped semantic locators.
4. Medium: the docs request button starts asynchronous work, so an immediate observation could mistake static examples for actual responses. Fixed with semantic live-region waits and live-response inspection.
5. Medium: long sessions could return unbounded transcripts. Fixed with bounded close output and explicit truncation metadata.

## Product Observations

- The Vitract order documentation and observed API behavior agreed for the tested identity variants, required owner identity, client delivery restrictions, idempotency, retrieval, pagination, status filtering, and authentication errors.
- Sorting is not listed for Partner order collection requests, so it was recorded as unsupported rather than tested through an undocumented parameter.
- The documentation does not expose a cleanup/delete operation for sandbox orders or identities. A Test Mode cleanup endpoint would make repeatable external acceptance campaigns less noisy.

## Verification

- Workspace typecheck: passed for all packages.
- Direct API tests: 8 passed.
- MCP tests: 24 passed.
- API suite with both integration database variables set: 48 files and 212 tests passed, zero skipped.
- Praxis suite with host browser permission: 11 files and 74 tests passed.
- Executor suite: 235 passed, 1 skipped, 4 pre-existing failures in authoring target capabilities and keyboard selected-input acquisition. The direct recovery change does not modify Executor or those paths.
