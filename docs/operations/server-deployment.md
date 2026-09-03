# Reliable single-server deployment

Scry server releases are deployed through the **Deploy qualified Scry release** GitHub Actions workflow. Do not update a retained-data server with an uncoordinated `docker compose pull` followed by `docker compose up`.

The deployment workflow accepts an exact qualified commit SHA, resolves its published application image to an immutable registry digest, verifies the image release and schema labels, renders the Compose topology from that exact source revision, and transfers both the topology and release controller over pinned-host SSH.

## One-time GitHub environment setup

Create `scry-staging` and, when needed, `scry-production` GitHub environments. Configure approval and branch rules appropriate to each environment. GitHub does not expose environment secrets to a job until its protection rules pass.

Set these environment variables:

| Variable           | Example                    | Purpose                                        |
| ------------------ | -------------------------- | ---------------------------------------------- |
| `SCRY_DEPLOY_HOST` | `testnet.example.com`      | Pinned SSH target host                         |
| `SCRY_DEPLOY_USER` | `scry-deploy`              | Exact case-sensitive SSH deployment account    |
| `SCRY_DEPLOY_PATH` | `/opt/scry`                | Directory containing the protected `.env` file |
| `SCRY_DEPLOY_URL`  | `https://scry.example.com` | GitHub deployment link                         |

Set these environment secrets:

| Secret                    | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `SCRY_DEPLOY_SSH_KEY`     | Private key for the dedicated deployment account                                |
| `SCRY_DEPLOY_KNOWN_HOSTS` | Exact `known_hosts` entry for the server; do not use `StrictHostKeyChecking=no` |

Use a dedicated key and account. Membership in the Docker group is effectively host-root access, so do not reuse a personal SSH key or grant interactive access that the deployment account does not need.

## One-time server setup

The server requires Docker Engine, Docker Compose 2.34 or later, `bash`, and `flock`. The deployment user must be able to run Docker and write to `SCRY_DEPLOY_PATH`.

Keep all deployment secrets only in `/opt/scry/.env`, make the target database explicit, and restrict the file to its owner:

```bash
cd /opt/scry
printf '\nSCRY_DATABASE_NAME=scry_browser_v2\n' >> .env
chmod 0600 .env
```

Do not append the database setting if it is already present. The first controlled deployment discovers the currently running immutable API release and its existing Compose file, validates that metadata, and writes a non-secret rollback pointer beneath `/opt/scry/.scry-deploy/`.

## Deploy a release

1. Merge a change and wait for **Scry required qualification** and **Publish Scry beta to Docker Hub** to pass.
2. Open **Actions → Deploy qualified Scry release → Run workflow**.
3. Select `staging` or `production` and enter the exact published 40-character commit SHA.
4. Approve the protected GitHub environment if it requires a reviewer.

Only one deployment can run for a target at a time. The server also takes an exclusive host lock, so a second workflow or manual invocation cannot overlap it.
Replaying the exact already-healthy release verifies it and exits without stopping services, taking another backup, or rerunning migration.

## What the controller proves

Before interrupting the running release, the controller:

- requires an immutable image digest and matching release/schema image labels;
- validates the complete Compose configuration and the image-owned deployment preflight;
- refuses a missing target database instead of silently creating or selecting an empty database;
- downloads every candidate image;
- preserves the current release pointer for rollback.

During cutover, it:

- stops Caddy first so no new external request can enter;
- refuses deployment while a browser session or command is actively in flight (durable `unknown` state remains restart-safe and is never replayed);
- gracefully stops API, worker, MCP, and web only after the idle check passes;
- captures a fenced PostgreSQL dump before migration;
- runs migration as a separate one-shot gate;
- starts and verifies API, worker, MCP, and web before starting Caddy;
- validates Caddy's candidate configuration while public traffic remains fenced;
- checks component release IDs and internal health before starting Caddy as the final activation step;
- atomically advances the current release pointer immediately after Caddy becomes healthy;
- checks public TLS, Caddy routing, API health, and the web entrypoint independently from the GitHub runner.

If migration, application startup, internal health, or Caddy validation fails while traffic is fenced, the controller stops the candidate, restores the fenced database snapshot, restarts the previous immutable release, and verifies its health. If recovery itself cannot complete, the public entrypoint remains stopped and the workflow fails; it never marks the candidate active.

Once Caddy is healthy, the release is exposed and automatic database restoration is no longer safe because a real request may have committed. The independent GitHub-runner TLS and routing probe therefore reports an incident after activation instead of restoring an older snapshot that could erase accepted writes.

Successful receipts and pre-deployment dumps are retained under `/opt/scry/.scry-deploy/releases/<commit>/`. Treat that directory as sensitive operational data. Its database dumps contain production data and must follow the same access, encryption, retention, and off-host backup rules as PostgreSQL.

## Availability boundary

This is a controlled single-host deployment with a short maintenance window. It favors data and mutation safety over zero downtime. True zero-downtime releases require a separately qualified blue/green application topology and backward-compatible expand/contract database migrations; this controller does not claim that guarantee.
