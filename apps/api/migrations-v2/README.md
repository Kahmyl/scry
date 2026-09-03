# Browser execution v2 schema

This directory is the fresh-database baseline for browser execution v2. It is intentionally separate from `apps/api/migrations`.

- Apply it only to a new, explicitly selected database.
- Do not apply it automatically during application startup.
- Do not run it against the current production database.
- The only later cutover import is the identity spine: users, workspaces, memberships, and projects.
- Execution history, credentials, tokens, environments, Missions, Flows, Runs, evidence, and runtime state are never backfilled.

The default API, worker, migration, and MCP commands now select this runtime. Historical executable entrypoints are retired and fail closed.

- `pnpm --filter @scry/api start`
- `pnpm --filter @scry/api worker`
- `pnpm --filter @scry/mcp start`

All components require the same `browser-runtime-v2.7` capability and a database created by this migration runner. Browser commands are persisted before Redis dispatch. Public fill values are encrypted at rest in the command ledger; generated protected values and browser continuity checkpoints remain encrypted and scoped to their Project, Mission, and Run. Mutation-response fields remain quarantined until the single protection authority records a scope-bound decision; every safe sink enforces that decision rather than classifying independently.

Permanent cutover has two durable phases. `cutover-browser-v2.ts` imports the identity spine while source writes are frozen and records an `identity_imported` receipt. `activate-browser-v2-cutover.ts` changes that receipt to `active` only after operators attest that the historical API, workers, MCP tokens, database, artifacts, and traffic path have been retired. Production API readiness refuses a database without an active permanent receipt.

Every schema replay compares the migration-source fingerprint and a fresh PostgreSQL catalog fingerprint. A changed column, constraint, or index is rejected even if the mutable baseline row still claims the expected capability. Historical project execution configuration is deliberately discarded; only the project identity and description cross the boundary.

Production key custody accepts a secret-manager-injected JSON keyring through `BROWSER_V2_PROTECTED_KEYS_JSON`, with `BROWSER_V2_PROTECTED_KEY_VERSION` selecting the active version. Keep older versions present while records or active Runs still reference them. The legacy single-key `BROWSER_V2_PROTECTED_KEY_BASE64` input remains available for isolated and one-version deployments. Evidence and capture keys are purpose-separated and derived per Run/session; they are never written into artifact directories.

The production worker also requires `BROWSER_V2_RENDER_VIDEO=true`. Startup refuses any other value so a deployment cannot silently produce final Mission evidence without the sanitized WebM replay.
