# Customer plugin connections

Status: implemented local candidate; not activated or submitted to directories.

## Customer outcome

Customers choose their AI client, install Scry through a supported client flow,
sign in with their existing Scry account, explicitly approve one workspace and
begin testing. A setup click is not a verified connection. Scry marks access as
used only after an authenticated client request succeeds. Manual access-token
setup remains an advanced compatibility option, not the primary journey.

## Selected boundary

Supabase remains the identity authority for dashboard sign-in. The existing
application database remains the workspace/membership authority. A bounded OAuth
layer uses the maintained `oidc-provider` implementation for authorization codes,
PKCE, discovery, client registration, access tokens and refresh-token rotation.
It does not create another customer identity database or change browser execution.

The built-in Supabase OAuth server was considered. It has no separate fee, but
currently exposes identity scopes rather than Scry testing scopes, and its default
access tokens have normal user-data access. A thin package-only change would leave
manual credential setup unresolved. Rebuilding customer identity is unnecessary.
Use the standards library with existing identity and a narrow Scry grant instead.

## Invariants

- Each approved grant binds one existing user, OAuth client and workspace. Access
  always intersects current membership; losing membership removes access.
- The client receives only resource-bound Scry testing tokens, never dashboard
  credentials or a Supabase refresh token. Plugin credentials cannot approve new
  grants, create access tokens or manage connections.
- Authorization details come from the provider's pending interaction, bound to
  the initiating browser cookie. The customer approves a displayed workspace and
  permissions; untrusted client names never imply verified vendor identity.
- Codes require S256 PKCE and exact registered callbacks. Unsupported resources,
  grants and permissions are refused. No implicit or client-credentials grant.
- OAuth state is durable and expires. Revocation is authoritative in the database:
  existing access and refresh paths must stop, including an already-open MCP
  transport. Reconnection creates a new grant rather than reviving old tokens.
- The approved workspace connection lasts up to 30 days independently of the
  short-lived consent browser session. Five-minute access tokens renew through
  rotating refresh tokens; closing or expiring the consent browser session does
  not disconnect the assistant. Testing-only MCP grants do not need the optional
  OIDC offline_access scope for this lifetime. Legacy session-bound access and
  refresh payloads use the same connection policy when read, while token expiry,
  grant expiry, explicit revocation and current membership remain authoritative.
- MCP sessions bind stable authorized identity, not the current token bytes.
  Every HTTP request revalidates access; each tool uses that request's credential.
- Refresh issuance and its encrypted retry receipt commit atomically under a
  PostgreSQL grant-family lock shared by API processes. For ten seconds, an
  identically authenticated request may retrieve the same immediately succeeding,
  unused refresh credential. A later successor, changed effective parameters,
  expired window, removed membership or revoked grant cannot use this receipt.
  Access-token expiry is not extended. Older replay retains family revocation.
  This deliberately permits brief identical bearer replay; it does not make a
  stolen bearer credential safe during that interval or repair arbitrary stale
  host caches. Revoked connections require a fresh explicit connection.
- Existing evidence, workers and customer records stay unchanged. OAuth storage
  is additive. Signing/cookie keys persist across restarts; no generated runtime
  fallback keys or development login views may activate in deployment.
- Plugin packages contain public endpoint configuration, assets and short skills,
  never credentials. Essential guidance stays in MCP for clients without skills.

## Delivery and gates

Implement API/provider/storage, MCP discovery and renewal, consent/sign-in return,
connection management, client packages and setup guidance together. Keep this
inactive unless explicitly configured. Verify success, denial, bad PKCE, replay,
wrong resource, cross-workspace access, token renewal, revocation, restart and
client setup. A fresh-user trial must complete a test and locate its report and
recording; passing authentication tests alone is not that trial.

Public directory review is separate. Do not claim a listing, automatic installation
or sensitive-data policy clearance. Local code work does not authorize submission,
paid accounts, remote configuration changes, publication or deployment.

## Operator setup and rollback

The additive application migration is `0017-plugin-connections.sql`. Apply it
through the existing guarded migration runner; never reset or move the identity
database. OAuth records belong to Scry's application database, not a new Supabase
project. No change to the existing Google callback is needed.

Activation requires persistent private cookie/signing keys. Generate them once
with `node scripts/operations/generate-oauth-keys.mjs --out /absolute/private/path.env`.
The helper creates a new owner-readable file and refuses overwriting. Never
paste, commit or place its contents in browser configuration. Load its two values
through the deployment's private secret configuration. Retain these keys across
restarts; the existing Veil encryption keyring is also required to read provider
state. Retain older keys when rotating; test rotation before retiring old keys.

Set `SCRY_OAUTH_ENABLED=true`, `SCRY_OAUTH_ISSUER=https://scry.giize.com/oauth`
and `SCRY_OAUTH_RESOURCE=https://scry.giize.com/mcp` consistently on API and MCP.
Only API receives `SCRY_OAUTH_COOKIE_KEYS_JSON` and `SCRY_OAUTH_JWKS_JSON`.
Compose defaults remain disabled. API startup refuses incomplete key/schema
configuration. Public issuer and resource must share one HTTPS origin. The
local exception is loopback HTTP; local web proxy routes preserve that origin.

Renewal retry handling requires additive migration `0021-oauth-renewal-receipts.sql`
before enabling the new API release. OAuth startup checks both new tables. Retry
receipts use the existing Veil keyring, one receipt per connection and a fixed
ten-second validity; the bounded minute sweeper removes expired ciphertext. Safe
connection events retain at most 32 entries per connection and expire after 30
days. Diagnostics expose finite outcomes and dates, never provider credentials.
Deploy matching API instances together. An old API does not honor the receipt:
rolling back to strict single-use behavior can invalidate a client retrying during
that interval. Keep schema/key material on rollback and do not revive old grants.

Deploy matching API, MCP and web artifacts. The reverse proxy routes `/oauth/*`
and authorization-server discovery to API, protected-resource discovery and
`/mcp` to MCP, and consent/support pages to web. Keep API/MCP container ports
private behind that proxy and monitor API authentication/readiness errors.
Expired provider state is refused before a bounded, minute-based cleanup batch;
cleanup failure does not extend authorization. Registration is rate-limited
and has a durable client-record cap; reaching capacity requires operator review,
not silent removal of customer registrations.

To roll back activation, disable OAuth on API and MCP together. This refuses
OAuth access and hides guided setup; existing manual tokens keep their original
path. Do not drop OAuth tables or replace encryption keys on rollback. Preserve
them for investigation and controlled reactivation. An older image needs its
own schema-compatibility rehearsal before rollback.

## Distribution and customer verification

Saved-result review uses the read-only `list_reports` and `get_report` MCP tools.
They call the same workspace-scoped customer report API as the dashboard, retaining
recorded application checks, limitations, evidence references and coverage while
excluding operator originals. Review does not start or rerun a Mission. Evidence
metadata does not establish that an image or recording was visually inspected.

MCP returns `reportUrl` and `evidenceUrl` navigation links after publication and
when observing a Mission with a final report. The evidence link opens the report's
authenticated Supporting evidence section; it is not a public media or signed
download URL. Links use `SCRY_WEB_ORIGIN`, or the validated OAuth resource origin
when no explicit web origin is set. An explicit web origin must be HTTPS (loopback
HTTP is allowed locally) and agree with the OAuth origin. Compose sets the public
domain in deployment and port 5173 locally. Without either setting, report data
remains readable but links are omitted; internal API hostnames are never used.

Web builds generate credential-free ChatGPT, Codex, Claude and Cursor archives
from an explicit source allowlist. ChatGPT and Codex share the same portable
package. For the hosted Scry endpoint, package installation is the primary
Connections guide: ChatGPT web uses Add → Upload plugin archive, while desktop /
Codex opens a setup chat with a prefilled message the customer must send.
Manual MCP setup remains under Other methods. Claude, Cursor and other MCP clients
retain their custom connection guides. No package download or setup click marks
account access as verified.

Desktop setup uses a tested standalone Node installer and a short, prefilled
command whose installer digest is pinned by the same web build. A generated data
payload contains only the seven allowlisted plugin files with per-file SHA-256
checksums. The installer validates the manifests, rejects file/catalog conflicts
and symlinks, and invokes at most three supported CLI commands. It does not ask
the model to research installation, generate Python, inspect general configuration,
or implement its own archive extraction. Node.js 18+ and Codex CLI are prerequisites.
The executable resolves its entry path canonically so symlinked temporary
directories on macOS start correctly. The bootstrap requires an explicit
installation confirmation instead of treating an empty successful exit as a pass.

The installer uses a dedicated local marketplace, preserves existing configuration,
and leaves OAuth consent to the customer through the host's plugin Connect action.
An explicit host result of `OAuth authorization required` allows one supported
login attempt even when credential inventory still says `oAuth`. Network, server
and generic discovery failures do not trigger sign-in or repeated consent. A
successful login still requires a new tool-discovery check before success.
Do not use a bare-name `codex mcp login scry` as proof of plugin authorization: it
can authenticate an unrelated pre-existing direct MCP configuration. Verify access
using the actual plugin's tools. Installation time, agent response time, host
activation and human sign-in time are distinct measurements; a total 10–15 second
onboarding duration is not guaranteed.

The setup does not assume an unknown marketplace
can be installed by a deep link. A local installation does not establish a cloud
or mobile installation. Accounts must allow the relevant upload/custom-connection
capabilities; fresh independent personal-account import and OAuth remain a
separate compatibility gate, not a claim established by this setup UI.

The archives target `https://scry.giize.com/mcp`; the UI warns when the current
server address differs and keeps manual setup primary there. A local-server trial must use that server's address,
not silently install a package targeting the hosted deployment.
These are local installation candidates, not public marketplace listings.
Claude has its native manifest alongside the portable manifest; Codex and Cursor
use the Agent Plugins format. Review each client's installation documentation
and plan/organization restrictions before promising a particular setup path.

Installation and consent alone do not mark a connection verified: an authenticated request
must reach Scry. The customer can refresh all connections and explicitly
disconnect an owned grant without deleting evidence. Expired grants are labeled
for reconnection. Manual token management stays collapsed under Advanced.

Local checks cover PKCE, code replay, exact callback/resource binding, denial,
cross-origin approval rejection, workspace membership, credential-management
isolation, revocation, expiry, encrypted provider storage and provider restart.
The disposable database trial upgrades a populated preceding baseline and checks
existing Projects. Independent browser review uses fictional data and establishes
presentation and keyboard behavior only. It is not a live client installation
or an end-to-end testing journey.

Before customer activation: complete a fresh account-linking trial in each
advertised client, renew access on an existing connection, run an authorized
application journey, locate its report/recording, and disconnect/reconnect without
reviving old credentials. Public listing policy review and remote deployment
remain separate gates. Scry does not claim that skills guarantee agent behavior
or that clients have approved the service.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[plugin packaging](https://developers.openai.com/plugins/build/plugins),
[Supabase OAuth limits](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows),
[provider documentation](https://github.com/panva/node-oidc-provider/tree/main/docs).

### Plugin catalog compatibility

Successful OAuth discovery is distinct from model-visible tool availability.
Codex applies a shared 64,000-byte agent-plugin tool budget and an 8,000-byte
per-tool budget; its serialized namespace instructions are charged for each tool.
See the [public exposure implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_exposure.rs).
Do not repeat the complete Scry workflow in initialization instructions. The
short bootstrap directs the agent to `list_projects`, which returns full guidance
in its existing message field even when no Project exists. This preserves the
strict output schema already cached by older clients. `get_testing_context` also
returns `workflowGuidance` with its normal readiness snapshot. Both use the
existing scoped API and normal authorization; guidance never grants permission.

The MCP compatibility check measures the whole native and retained catalogs,
including per-tool namespace overhead, and requires every tool to remain visible
with room below the host limit. Input schemas, validation and permission hints
must not be loosened to shrink a catalog. Future tools or metadata changes must
pass this check. Multiple agent plugins share the host budget; successful server
discovery alone still cannot prove any particular client's final tool exposure.
