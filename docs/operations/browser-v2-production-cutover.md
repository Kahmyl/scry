# Browser execution v2.7 production cutover

This is a permanent, identity-only cutover. It preserves user accounts, workspaces, workspace memberships, and the identifying fields of projects. It deliberately discards project execution configuration, MCP tokens, environments, protected inputs, Missions, Flows, Runs, browser state, effects, captures, evidence, reports, and all other execution history.

The target must be a separate empty PostgreSQL database. The source and target must use the same Supabase identity provider. Do not direct application traffic to the target before activation.

## Preconditions

1. Build one immutable image and use that digest for migration, API, worker, MCP, and web.
2. Provision a versioned 32-byte browser protection key in the production secret manager. Set `BROWSER_V2_PROTECTED_KEYS_JSON` and `BROWSER_V2_PROTECTED_KEY_VERSION` from that secret; never place the key in source or the deployment bundle.
3. Create the empty target database with an exact, operator-chosen name. Keep the old database available until the pre-activation checks pass.
4. Take an operator backup even though the execution data is intentionally disposable. The backup is an incident-recovery aid, not a backfill source.
5. Confirm that no real provider mutation or active Mission is running during the cutover window.

## Prepare and rehearse

Apply the schema to the empty target:

```sh
BROWSER_V2_SCHEMA_CONFIRM=CREATE_EMPTY_V2 \
BROWSER_V2_DATABASE_URL="$TARGET_DATABASE_URL" \
BROWSER_V2_EXPECTED_DATABASE="$TARGET_DATABASE_NAME" \
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-browser-v2.ts
```

Run the identity-only import in rehearsal mode against a disposable target. Repeating this command must return `replay: true` with the same identity digest.

```sh
BROWSER_V2_CUTOVER_CONFIRM=REHEARSE_IDENTITY_CUTOVER \
BROWSER_V2_SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
BROWSER_V2_TARGET_DATABASE_URL="$REHEARSAL_DATABASE_URL" \
BROWSER_V2_EXPECTED_SOURCE_DATABASE="$SOURCE_DATABASE_NAME" \
BROWSER_V2_EXPECTED_TARGET_DATABASE="$REHEARSAL_DATABASE_NAME" \
apps/api/node_modules/.bin/tsx apps/api/scripts/cutover-browser-v2.ts
```

The rehearsal is acceptable only when its counts match the source identity spine and the target contains zero MCP tokens and zero execution records.

## Freeze and import

Stop the old API, worker, and MCP processes. Block new writes at the routing or database boundary and confirm the source identity provider is unchanged. Then run the permanent import:

```sh
BROWSER_V2_CUTOVER_CONFIRM=EXECUTE_IDENTITY_CUTOVER \
BROWSER_V2_SOURCE_WRITES_FROZEN=I_ATTEST_SOURCE_WRITES_ARE_FROZEN \
BROWSER_V2_IDENTITY_PROVIDER_CONTINUITY=I_ATTEST_SAME_IDENTITY_PROVIDER \
BROWSER_V2_SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
BROWSER_V2_TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
BROWSER_V2_EXPECTED_SOURCE_DATABASE="$SOURCE_DATABASE_NAME" \
BROWSER_V2_EXPECTED_TARGET_DATABASE="$TARGET_DATABASE_NAME" \
apps/api/node_modules/.bin/tsx apps/api/scripts/cutover-browser-v2.ts
```

The import commits a digest receipt in state `identity_imported`. The API and worker still refuse startup because the target is not active.

## Retire and activate

Revoke the old MCP tokens, retire the old execution database from application access, and dispose of old execution artifacts according to the approved retention decision. Confirm that the load balancer is ready to send traffic only to the new runtime. Activate the imported target:

```sh
BROWSER_V2_ACTIVATION_CONFIRM=ACTIVATE_PERMANENT_BROWSER_V2_CUTOVER \
BROWSER_V2_LEGACY_RUNTIME_STOPPED=I_ATTEST_LEGACY_RUNTIME_STOPPED \
BROWSER_V2_TRAFFIC_SWITCH_READY=I_ATTEST_TRAFFIC_SWITCH_READY \
BROWSER_V2_LEGACY_MCP_TOKENS_REVOKED=I_ATTEST_LEGACY_MCP_TOKENS_REVOKED \
BROWSER_V2_LEGACY_DATABASE_RETIRED=I_ATTEST_LEGACY_DATABASE_RETIRED \
BROWSER_V2_LEGACY_ARTIFACTS_DISPOSED=I_ATTEST_LEGACY_ARTIFACTS_DISPOSED \
BROWSER_V2_DATABASE_URL="$TARGET_DATABASE_URL" \
BROWSER_V2_EXPECTED_DATABASE="$TARGET_DATABASE_NAME" \
apps/api/node_modules/.bin/tsx apps/api/scripts/activate-browser-v2-cutover.ts
```

Activation refuses any pre-existing execution record, schema/catalog drift, a missing permanent receipt, or any missing retirement attestation. Repeating a successful activation returns `replay: true`.

## Start and verify

Set `BROWSER_V2_REQUIRE_ACTIVATED_CUTOVER=true` for API and worker. Start PostgreSQL, Redis, migration, API, worker, MCP, and web from the same immutable image. Verify:

- API `/api/v2/health` returns `ready: true` and `browser-runtime-v2.7`;
- MCP `/health` reports the same API capability;
- the web dashboard loads projects and the v2 Mission, Run, and report read models;
- a newly issued MCP token can list projects;
- old MCP tokens do not authenticate;
- no old API, worker, MCP, or migration entrypoint is selected by the deployment model.

Before activation, recovery is to discard the target and resume the frozen source. After activation, this is a forward-only cutover: do not restart the retired execution runtime or combine its data with the new database. Correct a post-activation defect in the new runtime or restore the complete pre-cutover system during an explicit outage; never dual-write or merge the two lifecycle models.
