# Phase 6: MCP and Codex loop

## Goal

Make Scry an asynchronous test execution tool for Codex without adding a
second AI planner inside Scry.

## Responsibility boundary

- Codex interprets the feature requirement and builds protocol v1.
- Scry validates, persists, executes, records, and reports the plan.
- Exact reruns never invoke a model or change the plan snapshot.

## MCP tools

```text
list_projects
create_project
list_environments
validate_test_plan
submit_test_spec
start_run
get_run_status
get_test_report
list_failed_steps
list_run_artifacts
rerun_exact_plan
cancel_run
```

## Asynchronous workflow

1. Find the project and environment.
2. Build a protocol v1 plan from the user's requirement.
3. Call `validate_test_plan`.
4. Call `submit_test_spec`.
5. Call `start_run` once.
6. Poll `get_run_status` until terminal.
7. Read `get_test_report` and `list_failed_steps`.
8. Fix the application.
9. Call `rerun_exact_plan`.

## Local connection

The trusted-project `.codex/config.toml` registers Scry as a local STDIO MCP
server. Start the API and worker before using the tools:

```bash
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev:api
pnpm --filter @scry/api worker
```

Restart the Codex host after changing MCP configuration.
