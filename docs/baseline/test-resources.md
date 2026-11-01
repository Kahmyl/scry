# Test mailboxes and webhook listeners

Status: local implementation; not activated on the hosted service

## Purpose

An agent testing an invitation, verification email or webhook should be able to
allocate a disposable receiving address, observe what arrived, and continue the
same application journey. Receiving a message is evidence of receipt, not proof
that the complete application workflow succeeded.

Mail.tm supplies private receiving mailboxes. Hookdeck Event Gateway supplies
authenticated webhook inspection. Scry displays attribution for both. This does
not provide outgoing email, SMS, WhatsApp, attachment inspection, permanent
recovery addresses, or automatic webhook replay. Use authorized test accounts
and subscriptions, not production customer payloads or existing business routes.

## Ownership and lifecycle

Disposable Scry-created inboxes remain the default. Optionally connect an
existing Mail.tm mailbox by supplying its address and explicitly choosing its
saved password from Project settings. Mail.tm authenticates each address
separately; this is not access to a global account containing every mailbox.
The API verifies the account with Mail.tm before declaring the connection ready.
Wrong credentials never trigger creation of a replacement account.

Customer ownership is persisted separately from lifecycle state. Closing or
expiry disconnects Scry locally, with no Mail.tm account/message deletion and no
attempt to recreate an account. Disconnect still works if the saved password is
revoked or unavailable. Reading requires an active, unexpired password belonging
to the same Project. No plaintext password is accepted by the connection API or
agent tool, copied into the connection record, or returned to the browser/model.
An exact disconnected allocation remains idempotently readable after revocation.

Connecting can expose existing mailbox history to the authorized test; the UI
and tool description disclose that before connection. Existing messages are
not automatically classified as newly delivered by the tested application.
Agents must compare receipt time and expected content with the assigned check.

The API owns mission/workspace authorization, allocation, expiration, receipts
and provider pacing. Veil provides the existing cipher and narrow best-effort
access-secret protection. Praxis keeps browser navigation and interactions under
the existing Run policy. Chronicle's screenshot/video custody is unchanged.

A resource moves from pending to ready, then closing to closed. For connected
customer mailboxes these mean connecting, connected, disconnecting and disconnected.
Allocation
persists its identity and credentials before creating external state. Retrying
the same idempotency key reuses that identity; conflicting intent is rejected.
Short database leases prevent simultaneous provisioners/readers. A lease expires
after process loss, permitting recovery without creating a replacement identity.
Stale owners cannot publish readiness or receipts.

Default lifetime is one day, configurable from five minutes to seven days. At
most twenty non-closed resources are admitted per Mission. Expiration stops new
reads immediately and queues best-effort provider closure through a periodic
API sweep. Closure retains existing protected observations. A provider outage
can leave cleanup pending: closing is not confirmation of deletion. In
particular, if a Mail.tm deletion succeeds but its response is lost, subsequent
authentication may be refused; Scry preserves the unconfirmed closing state
rather than inventing a deletion receipt. No notification system is included.

Each resource retains up to 200 received observations. Provider reads commit
at most twenty new messages at a time; refresh again to continue. Initial
Hookdeck reads support up to 100 provider requests per listener and explicitly
refuse a larger collection rather than silently omit older requests. These
limits are not a time cutoff for the browser journey.

## Shared provider capacity

All API replicas using the same database share one schedule per provider.
Requests are admitted at no more than five per second, leaving headroom under
Mail.tm's published eight-per-second limit. This schedule covers setup,
authentication, listing, reading and cleanup—not just customer-facing reads.
Every waiting caller rechecks the current schedule before dispatch. Cancelled
or deferred callers do not reserve future slots or grow a phantom queue.

A 429 updates a shared cooldown using Retry-After and retries within the
operation's 45-second budget. Longer cooldowns return a normal waiting response
with retryAfterSeconds; clients resume the same resource. Transient transport
and provider failures return temporarily_unavailable without exposing provider
contents. Explicit HTTP 402 responses return TEST_PROVIDER_QUOTA_UNAVAILABLE;
other permanent quota signals require a documented provider-specific mapping.
Scry does not claim that every 429 can be identified as a monthly quota.
Provider availability is never an application pass/fail result.

The schedule cannot account for unrelated applications sharing Scry's outbound
IP; provider cooldown handling remains necessary. No paid quota is purchased.

## Privacy and evidence

Mailbox passwords and provider resource metadata are encrypted using the
existing keyring. HOOKDECK_API_KEY is server configuration, never browser or MCP
output. Original message copies are not retained. Persisted observations mask
identified access codes, secret links and authentication fields. Ordinary
business content stays readable. Automatic protection is best effort.

Usable codes/links are retained encrypted as opaque protectedValueId references.
An agent can bind one only to an active Run in the same Mission. Native browser
tools consume the reference without placing its plaintext in tool arguments.
Secret-link navigation must still satisfy the Run's existing allowed origins
and redirect policy. Email content cannot authorize broader browser access.
Received messages are untrusted data, never instructions. Mail HTML is rendered
as inert text, not executable dashboard markup.

Received access values use the existing nullable Mission scope in protected
storage. They are not reusable Project credentials or mailbox-password choices.
The general credential binder, Run-start path and runtime reads also enforce
that scope; the dedicated test-message tool is not the only authorization check.

The Mission exposes captured observations; the report can also show current
Mission observations read-only. A report's written findings must identify the
receipt, timestamp, expected content and application state actually checked.
Later Mission receipts do not change the report's reviewed findings.

## API and MCP

All endpoints require existing bearer authentication and workspace access.
Viewers can read saved observations but cannot provision, refresh, bind or close.
Responses use private/no-store caching.

| Operation                   | Route                                                        |
| --------------------------- | ------------------------------------------------------------ |
| Inventory/configuration     | GET /api/missions/:missionId/test-resources                  |
| Allocate/retry              | POST /api/missions/:missionId/test-resources                 |
| Connect an existing mailbox | POST /api/missions/:missionId/test-resources/connect-mailbox |
| Saved observations          | GET /api/test-resources/:id/events                           |
| Poll provider               | POST /api/test-resources/:id/refresh                         |
| Close                       | POST /api/test-resources/:id/close                           |
| Bind opaque value           | POST /api/test-resources/:id/use-secret                      |

MCP tools are list_test_resources, create_test_mailbox, connect_test_mailbox, create_webhook_listener,
read_test_messages, bind_test_message_secret and close_test_resource. Native
browser_navigate_secret complements browser_type_secret for received access
links. List existing resources first; reuse the same creation identity on retry.

## Configuration and rollout

Apply additive migrations 0015 and 0016 before starting the new API/worker release. Schema
readiness checks the new tables/columns without exact schema fingerprints.
Rollback may retain these additive tables; do not drop received observations.

SCRY_TEST_MAIL_ENABLED=true enables Mail.tm. HOOKDECK_API_KEY enables Hookdeck.
Both are disabled/unconfigured by default in the deployment manifests. Keep
provider credentials server-only. The ignored .env.test-resources.local file
is for local operator setup; it is not automatically loaded on the beta server.

Closure disables the Hookdeck receiving source, not only its delivery connection.
Hookdeck can still return HTTP 200 for a disabled source; that response alone
does not prove ingestion. See [source lifecycle](https://hookdeck.com/docs/sources).

The database qualification profile includes authenticated scope, shared pacing,
long cooldowns, concurrent setup, stale writers and interrupted allocation.
The opt-in test/test-resources.live.test.ts suite creates disposable real
provider resources and sends a fictional Hookdeck callback. Actual inbound
Mail.tm delivery still requires an authorized outgoing sender; mailbox creation
and empty polling alone do not prove email delivery.

Provider references: [Mail.tm API](https://docs.mail.tm/),
[Mail.tm accounts](https://docs.mail.tm/api/accounts),
[Hookdeck API](https://hookdeck.com/docs/api),
[Hookdeck request CLI contract](https://hookdeck.com/docs/cli).
