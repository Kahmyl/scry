# Agent workflow integration: review, rollout and recovery

This is a locally qualified review candidate. It has not been pushed, merged or
deployed. The owner requires review before any push or deployment. The complete
issue register is in `agent-workflow-reliability-plan.md`; current evidence is in
`artifacts/assurance/remaining-workflow-20261110/`.

## Release and migration contract

API, worker, MCP, web, Contracts, Praxis, Veil, Chronicle and packaged instructions
must come from the same immutable release. The web build now copies Contracts
source into its build stage; a successful host build alone does not prove that
the container contains those types.

Apply the additive migrations 0018 (workflow identity), 0019 (deployment
admission) and 0020 (cleanup decisions and scoped playback grants). Current
readiness requires their actual capabilities. Historical migration rehearsals
remain valid without becoming a bypass for current runtime readiness. Do not
mark migration history manually or remove the capability checks.

Both rollout flags default to false in deployment Compose:

- `SCRY_BROWSER_WORKFLOW_V1_ENABLED`: atomic journey setup and guarded known-step
  sequences. Individual existing calls remain available when disabled.
- `SCRY_BROWSER_WORKFLOW_V2_ENABLED`: native scoped HTTP, completed-download
  verification and viewport profiles. Disabled admission persists no command.

Enable a flag in the matching API and worker only after migration and release
compatibility verification. The native capabilities also require the existing
native adapter selection. Capability rollout flags do not select another
browser runtime, queue, privacy authority or secret store.

Private-network HTTP destinations additionally require
`SCRY_BROWSER_PRIVATE_NETWORK_ORIGINS`, a JSON array of at most 20 exact HTTP(S)
origins. Default is `[]`. This does not expand the Environment's allowed origins:
both scopes must agree. Metadata and multicast destinations remain denied even
with an operator entry. The deployment preflight validates flag spelling and
origin syntax without echoing values. Unused private-origin configuration is not
parsed when V2 is disabled. Never place credentials in this configuration.

## First controller rollout dependency

The deployment controller calls `browser_try_deployment` before touching the
serving release. A database without migration 0019 refuses that deployment
without stopping public services. Therefore the revised controller cannot itself
bootstrap its own admission function.

Use the existing trusted, guarded migration path to install the reviewed additive
catalog with both flags off. Preserve exact database target confirmation,
existing backup policy and active-owner migration guards. Verify migration
history, the admission function and both triggers. This production preparation
has not been performed in this campaign.

After the gate is installed, use the existing controller and matching immutable
release. Active Sessions, pending commands or unreleased current owners refuse
admission while public services remain untouched. Database locking and triggers
serialize new work against admission; a controller precheck alone is insufficient.

## Supported boundaries

Scoped HTTP runs inside the existing private worker command lane. It accepts
bounded JSON objects and explicitly bound credential references, uses no ambient
browser cookies, validates every DNS answer and pins one address, follows no
redirects and performs no automatic retries. Header/body/response/time limits
are enforced. Dispatched writes whose response cannot be established remain
unknown and quarantine later writes. It is not an unrestricted HTTP shell.

Download receipts expose completion facts, not raw files or filesystem paths.
Verification is limited to 16 MiB, 20 receipts and two pending transfers per
Session. The owner has a 30-second transfer deadline; verification waits at most
15 seconds per call. Browser progress cancellation is best effort and may
overshoot, so this is not a hard disk quota. Hash/signature checks are not full
PDF/ZIP/document semantic validation. Known private scratch is removed after
confirmed retirement; no arbitrary path deletion endpoint is introduced.

Viewport profiles are desktop 1280×720, mobile 390×720, landscape 720×390 and
tablet 768×720. They resize the viewport; they do not emulate touch, phone
hardware or user agent. Native recording uses a fixed 1280×720 private canvas,
explicit padding and actual capture start timing where available. Recorder-start
fallback remains identified. Chrome UI or overlays can affect visible pixels.

Video playback requires authenticated grant minting and a path-scoped HttpOnly,
SameSite Strict cookie (Secure in production). The URL contains only an opaque
identity, no bearer secret. Grants last up to 120 seconds and renew through
account authentication. Every range read revalidates source authorization,
workspace membership, retention and admitted digest. Four concurrent read
snapshots per API process, each up to 128 MiB, use 64 KiB memory chunks; verified
private copies disappear on close/abort. Source revocation prevents future reads;
already buffered bytes cannot be recalled. Original user JWT expiry bounds its
grant; this does not add instantaneous logout revocation to existing JWT semantics.

Masking reasons and recovery intervals are admitted evidence facts. History is
bounded to 256 events; truncation remains explicitly partial. A recovered page
does not erase an earlier interval, and a closed popup does not indefinitely
degrade unrelated pages. Masking remains best effort; review before sharing.

Cleanup records an explicit scoped decision before external work. Shared or
pre-existing credentials can only be retained; Mission-created credentials can
be revoked only after all bound attempts end. Customer mailboxes disconnect
locally without provider deletion. Resource expiry alone never proves external
cleanup. Missing decisions or unavailable provider closure remain visible as
pending; no retention choice is inferred from an agent's silence.

## Acceptance after review, before rollout

Review the complete source patch, schema changes, original failures and final
reconciled results. The isolated campaign covers actual MCP/API/worker execution,
recording bytes and seeking, exact replay, changed controls, unknown writes,
release/sealed evidence, explicit cleanup and customer report readback. Also
review the disabled-feature and role compatibility paths.

Actual Desktop idle/restart/expiry and disappearing-tool behavior require a
separate host acceptance check. Server diagnostics distinguish stored facts from
host tool exposure; they do not claim to fix an unproven client/provider defect.
Live external mailbox/webhook delivery, actual Windows behavior and production
rollout/rollback remain separate gates. Do not reinstall or repeatedly request
consent merely because a host has not exposed the diagnostic tool.

## Recovery and rollback

A stop fences new dispatch and preserves in-flight uncertainty. A terminal Run
alone is not physical release. Inspect current owner retirement, pending commands
and sealed evidence through agent status and dashboard recovery.

Unknown native results quarantine later mutations, including previously queued
ones. Inspect observations or finish incomplete. Exact replay retrieves the
existing durable receipt; never redispatch a write for a cleaner report.

Provider refreshes preserve saved observations and expose waiting, partial
refresh, shared throttle and timing facts. Metadata locks return retryable
unavailability; every claimed refresh releases its lease even when the baseline
lookup fails. A caller-owned transport deadline bounds non-cooperative header
and body waits. External creation/closure may still need reconciliation using
the same resource identity.

The release controller retains its gate after failure until healthy activation
or verified rollback. A trusted operator must establish controller ownership
and reconcile pending work before clearing an abandoned gate.

Before rollback to an older worker, disable both workflow flags and drain or
reconcile admitted work. Preserve additive tables, receipts, cleanup decisions,
uncertainty and evidence. Do not drop migration 0020 to hide facts. Expired
playback cookies naturally cease working; older application code need not read
the additional grant table. Use the existing verified snapshot rollback policy
when rollback requires database restoration; this campaign has not executed it
against production.

Connection presentation groups never combine security grants. Disconnect only
the selected authorization, not every entry with the same client name.
