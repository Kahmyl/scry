# Scry

Scry is an agent-ready browser test execution and reporting hub. Intelligent
clients such as Codex translate requirements into versioned Scry test plans;
Scry validates those plans, enforces execution policy, runs them with
Playwright, and preserves the resulting evidence.

## Current status

Phase 0 established the product boundary and protocol. Phase 1 adds a local,
deterministic Playwright executor and machine-readable evidence.

## Repository layout

```text
apps/api/            NestJS/Fastify durable application API
docs/                 Product, architecture, security, and lifecycle decisions
packages/contracts/   Versioned plan, policy, event, and result schemas
packages/executor/    Local deterministic Playwright interpreter and CLI
packages/policy/      Runtime request policy, capability classification, redaction
packages/artifact/    Artifact storage interface and local implementation
examples/plans/       Valid and rejected protocol examples
```

## Local validation

```bash
pnpm install
pnpm test
pnpm typecheck
```

Run a plan:

```bash
pnpm scry run examples/plans/signup.valid.json --channel chrome
```

See [the Phase 1 checklist](docs/phases/phase-1-executor.md).
## Authentication

See [apps/web/AUTH_SETUP.md](apps/web/AUTH_SETUP.md) for Supabase browser authentication, NestJS JWT verification, workspace authorization, and MCP service-token configuration.

## Docker development

The local stack includes PostgreSQL, Redis, automatic one-shot migrations, the
NestJS API, the Playwright worker, and the React application.

```bash
# Build, migrate, start, and wait for healthy services
pnpm docker:up

# Start Compose Watch for source synchronization and targeted rebuilds
pnpm docker:watch

# Or build, start, attach logs, and watch in one foreground command
pnpm docker:dev
```

Open `http://localhost:5173`. The API health endpoint is
`http://localhost:4000/v1/health`.

Useful commands:

```bash
pnpm docker:logs
pnpm docker:down
pnpm docker:reset # destructive: removes local database, Redis, and artifacts
```

## Deployment

Scry follows Elumra's hosted deployment pattern. The combined application image
is published as `kahmyl/scry`, and the complete Caddy-backed Compose application
is published as the `kahmyl/scry-stack` OCI artifact. The host does not need a
repository clone.

You need an AMD64 Linux server with Docker Engine, Docker Compose 2.34 or later,
a domain pointing to the server, and inbound ports 80 and 443 open. Create an
empty deployment directory and its environment:

```bash
mkdir -p /opt/scry
cd /opt/scry

# Create .env using .env.auth.example as the template, then start:
docker compose \
  --env-file .env \
  -f oci://docker.io/kahmyl/scry-stack:latest \
  up -d
```

Caddy obtains and renews TLS automatically. It is the only public service and
routes `/v1/*` to the API, `/mcp` to the MCP server, and everything else to the
web app. PostgreSQL, Redis, API, worker, MCP, and migrations stay on the private
Compose network. Supabase browser settings are injected at container runtime;
no `VITE_*` GitHub variables are required.

Pushes to `main` and version tags publish both artifacts through
`.github/workflows/docker-publish.yml`. Configure only `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` as GitHub Actions secrets.

Compose loads browser-safe variables from `apps/web/.env` and server-only
variables from `apps/api/.env`. Never put `SCRY_SERVICE_TOKEN`, credential
encryption keys, or browser-run credentials in the web environment.

Project test credentials are created in **Project settings → Test credentials**.
Their values are encrypted at rest and Flows store only opaque credential IDs.
Set `SCRY_CREDENTIAL_ENCRYPTION_KEY` in `apps/api/.env` to a long random value
for shared or production deployments. API and worker instances must use the
same key. Local development has a deterministic fallback so a fresh Docker
stack works without additional setup; production startup fails when the key is
missing.

## Connect an MCP client

Scry is not tied to one AI product. Its tools use the open Model Context Protocol
and are available through both standard transports:

- **Streamable HTTP** at `http://127.0.0.1:4100/mcp` for Codex, Claude Code,
  and other remote-MCP clients that support bearer headers.
- **stdio** through `pnpm --filter @scry/mcp start` for local MCP hosts.

Start the full local stack with Docker, sign in to the dashboard, then open
**Integrations**. Create a workspace-scoped access token and select the client
you want to connect. The dashboard produces copyable configuration for Codex,
Claude Code, desktop/custom connectors, and generic MCP clients.

MCP access tokens are hashed before storage, shown only once, individually
revocable, and restricted to the creator's workspace. Never place
`SCRY_SERVICE_TOKEN` in a client configuration; it is an internal
service-to-service credential.

Hosted clients that only accept OAuth are not supported by the local bearer-token
connection. They will use Scry's managed OAuth connection when that capability is
available.
