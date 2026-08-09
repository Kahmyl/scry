# Direct Browser Recovery

Status: implemented behind a feature flag  
Purpose: restore a small, dependable exploratory browser path before adding deterministic qualification.

## Boundary

The direct lane owns one persistent Playwright context and four operations:

1. `start_direct_session`
2. `execute_direct_turn`
3. `observe_direct_session`
4. `close_direct_session`

It does not create or require Missions, Objectives, Flows, Probes, Praxis transactions, Veil artifacts, compilations, certifications, or Runs. Those systems remain available for downstream qualification after a journey works.

The lane accepts semantic targets only. Raw selectors, arbitrary JavaScript, coordinates, plaintext credential values, unrestricted downloads, and generic HTTP requests are not accepted. Repeated documentation controls can be scoped by their visible section heading. A turn contains at most ten actions and a session expires after thirty idle minutes.

## Safety

- Origins come from the environment policy. Extra origins must also be explicitly configured through `SCRY_DIRECT_EXTERNAL_ORIGINS`.
- Credential input uses encrypted project credential IDs. Values are decrypted only inside the API process and are never returned.
- Credential generation uses one atomic `clickAndCaptureCredential` action. A post-dispatch failure seals the session as `DIRECT_CAPTURE_OUTCOME_UNKNOWN`; callers must reconcile before retrying.
- A dispatched failed action is never retried automatically.
- Page observations expose bounded headings, controls, dialogs, and input metadata. URLs omit query strings and fragments.
- Inspected text is bounded and redacts known session secrets and secret-shaped fields.
- Closing a session returns at most the latest 100 sanitized transcript entries and reports whether truncation occurred.
- The feature defaults on for local Compose and off for deployment Compose.

## Configuration

Required runtime settings:

```text
SCRY_DIRECT_BROWSER_ENABLED=true
SCRY_DIRECT_EXTERNAL_ORIGINS=https://preview-api.vitract.com
```

The Vitract campaign additionally requires credential and resource references. Values must be supplied through environment variables and must not be committed:

```text
SCRY_SERVICE_TOKEN
SCRY_VITRACT_PROJECT_ID
SCRY_VITRACT_ENVIRONMENT_ID
SCRY_VITRACT_EMAIL_CREDENTIAL_ID
SCRY_VITRACT_PASSWORD_CREDENTIAL_ID
SCRY_VITRACT_API_CLIENT_ID
SCRY_VITRACT_API_SECRET_CREDENTIAL_ID
```

Run:

```sh
pnpm verify:direct-browser-boundary
pnpm campaign:direct:vitract
```

The campaign is Test Mode only. It creates uniquely named sandbox identities and orders with idempotency keys. It never performs a Live Mode mutation.

## Promotion Rule

Direct transcripts are diagnostic records, not executable contracts. They may inform a later authoring request, but Scry must not automatically publish or replay them because they do not contain certified expected effects, mutation reconciliation, or evidence admission. Promotion remains explicit: translate a successful journey into the existing learned-interaction compiler, run fresh certification, and publish only the exact certified contract.

This rule prevents the recovery lane from becoming a second unqualified execution compiler.
