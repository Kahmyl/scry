# Scry security and authentication

Status: canonical baseline security model

This document defines authentication, authorization, protected-information
handling, and security boundaries for the product described in the
[Scry baseline brief](../product/baseline-brief.md).

## Security objectives

The baseline is designed to:

- isolate every workspace and Project;
- authenticate people, agents, and internal services distinctly;
- limit browser work to authorized application origins;
- prevent ordinary interactions from making undeclared changes;
- protect saved credentials and captured sensitive output;
- preserve honest mutation truth through retries and failures;
- make evidence tampering detectable; and
- keep secrets out of observations, logs, replay, and reports.

Scry reduces risk inside its controlled execution boundary. It does not make an
untrusted tested application safe, verify the user's authorization to test a
third-party system, or eliminate the need to use dedicated test accounts and
least-privilege data.

## Principal types

### Signed-in user

The dashboard sends a Supabase access token. The API validates its signature
against the configured issuer keys, requires the authenticated audience, and
maps the subject to a Scry user.

On first valid authentication, Scry may create the local user mapping, personal
workspace, and owner membership in one transaction. The external identity
subject remains the stable login identity.

### Agent principal

An AI agent uses a Scry agent access token. Tokens carry a distinctive prefix
for safe identification, but the database stores only a cryptographic digest
and a non-secret display prefix.

The plaintext token is returned only when it is created. Authentication checks
that the token exists, is not revoked, has not expired, and belongs to the
required user and workspace. Protocol sessions are bound to the token digest
that opened them.

### Internal service principal

Trusted internal automation may use a separately configured service secret.
Comparison is constant-time. This principal is reserved for controlled
service-to-service work and must not be distributed to users or agents.

## Authentication boundary

Every product route requires a valid bearer credential except the minimal
health route. The authentication guard establishes:

- principal type;
- user identity where applicable;
- workspace identity;
- membership role or trusted service scope; and
- credential expiry and revocation state.

Authentication failure returns a safe unauthorized response. Raw token values,
key material, signature detail, and lookup results are not logged or returned.

## Workspace authorization

Workspace membership roles are:

- owner;
- admin;
- member; and
- viewer.

Project creation requires a signed-in owner or admin. Agent and service
principals cannot use that user action. Environment creation is unavailable to
viewers.

All other resource access must still prove workspace ownership through the
relational path from the requested resource to its Project. Possession of a
resource identifier is never authorization. A cross-workspace identifier is
treated as unavailable.

The database does not independently expose user connections or rely on row
security as the primary enforcement layer. API transactions and relational
joins enforce scope, so every new operation must include an explicit workspace
authorization path.

## Origin and browser security

An Environment declares one first-party application origin and optional service
origins. A Run receives an immutable snapshot of that policy.

The browser runtime:

- permits navigation only within the first-party origin;
- rejects cross-origin writes;
- applies a read-only network gate to ordinary clicks and key presses;
- permits one declared same-origin write for a controlled change;
- blocks every additional write from that action; and
- invalidates element references when the document changes.

Service origins allow required application traffic; they do not grant the
agent navigation authority or mutation authority on those origins.

## Protected values

Saved credentials and protected application outputs are encrypted with
authenticated encryption using a random nonce. Stored material includes a key
identifier, ciphertext, authentication tag, and digest. Authenticated context
binds ciphertext to its purpose and owning records so it cannot be transplanted
into another Project, Run, session, or field.

Key material is supplied through a deployment keyring. Key identifiers permit
controlled rotation while keeping decryption explicit. Session- and
purpose-specific keys are derived from configured master material.

Protected-input reads return metadata only. Decryption occurs inside the
current fenced worker for the specific bound Run and browser fill. The safe
command history records a protected reference, never the plaintext.

Even an ordinary fill value is encrypted in durable command storage and removed
from the safe command representation.

## Protected capture and disclosure

Controlled-change responses are captured into encrypted quarantine. The agent
receives a structural description and safe field handles rather than the raw
payload.

Publication requires an explicit field selection and a protection decision for
every selected field. A field can be released only when:

- the Environment permits trusted application output;
- the value has no protected-input lineage;
- secret detection finds no high-confidence protected signal; and
- the persisted protection decision permits release.

Protection wins over a proposed public classification. Confidential
Environments always return protected references. Discard destroys the raw
payload and field index without creating output handles.

## Mutation safety

Authentication alone does not authorize an application change. Each controlled
change also requires:

- an active Run and current browser owner;
- a current document-scoped element reference;
- remaining budget in the declared mutation class;
- no unresolved sibling Effect in that class;
- a unique or matching idempotency key; and
- successful installation of the network gate before dispatch.

Dispatch, capture, publication, and application outcome remain separate facts.
After a post-dispatch failure, Scry records `unknown` when truth cannot be
established and refuses automatic replay.

## Checkpoint security

Browser checkpoints contain sensitive resume state. They are encrypted and
authenticated, bound to the Project, Mission, Run, Browser session, owner
generation, origin, and checkpoint revision.

Restoration fails closed on origin mismatch, digest mismatch, malformed state,
unavailable key material, or ownership mismatch. A checkpoint is removed after
evidence closure.

## Evidence security

The recorder masks user input, sanitizes protected values, and blocks risky
media surfaces from replay capture. Event chunks are compressed, encrypted,
and linked through cryptographic digests.

Artifact directories are private to the service account. Database metadata
records object identity, ordering, size, digest, retention, and chain head.
Replay is rendered only from a verified complete stream and is sanitized before
review.

Evidence confidentiality and evidence integrity are separate requirements. A
chunk must be both unreadable without authorized keys and detectably changed if
its bytes, order, or authenticated metadata are altered.

The baseline writes one canonical evidence format. During the reset, workers may
also read authenticated historical evidence through explicitly configured
compatibility keys and metadata. Historical keys are read-only: new evidence is
never written with them, and every historical record must still pass its
original authentication and digest checks.

## Report security

Before storage, report text and structured data are checked against bound
protected inputs and generated protected outputs. Detected secret material is
removed or replaced with safe references.

Report publication requires terminal work and complete evidence. This prevents
an agent from using a report to bypass unresolved capture or evidence gates.

## Network and deployment controls

Production traffic terminates at the TLS edge proxy. The API applies a configured
origin allowlist for browser clients. PostgreSQL, Redis, workers, and internal
application ports remain on the private service network.

Secrets and encryption keys are supplied through deployment configuration, not
committed source. Containers run with the minimum filesystem and network access
required for their role. Backup and monitoring systems must preserve the same
secret and workspace boundaries as the primary services.

## Logging and error handling

Logs may contain identifiers, state transitions, timings, and safe error codes.
They must not contain:

- bearer tokens or service secrets;
- protected-input plaintext;
- quarantined response payloads;
- encryption keys, nonces paired with plaintext, or decrypted checkpoints;
- unsanitized browser input; or
- unsanitized report content.

Unexpected client errors return generic text. Detailed database, browser, and
cryptographic failures remain in protected operational telemetry.

## Security limitations

The baseline does not provide independent malware isolation from the host,
hardware-backed key custody, native mobile sandboxing, cross-browser security
comparison, or automatic proof that a Mission was properly authorized. These
are not implied by the existence of browser controls or encrypted evidence.
