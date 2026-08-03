# ADR 0006: Veil is the sole privacy authority

## Status

Accepted for implementation. The cutoff gate remains closed until the Veil
readiness ledger is `READY`.

## Context

ADR 0005 correctly requires one privacy authority, but the current authority is
only a run-local `PrivacyGate`. Capture decisions are inferred from its mutable
state, passive collectors acknowledge transitions without changing or proving
collector state, and artifact creation, storage admission, retrieval, Praxis
evidence collection, and visual grounding remain independently callable.

This is a systemic ownership defect rather than a missing redaction rule:

> Because privacy authority is distributed between the executor gate, capture
> call sites, redaction, worker storage admission, and artifact consumers, an
> available artifact can be created and admitted without one unforgeable proof
> that the governing policy authorized that exact operation and context. The
> missing invariant is that every privacy-affecting operation and every durable
> evidence byte must be authorized by Veil and admitted through Veil exactly
> once.

Post-capture string replacement and later deletion are defense in depth. They
cannot establish that protected pixels or values never became evidence.

## Decision

Veil is an in-process privacy control plane and the sole owner of:

- immutable, versioned policy compilation and restrictive preference merging;
- decisions and opaque, expiring capability leases;
- collector lifecycle transitions and uncertainty sealing;
- classification, pre-capture masking, omission, sanitation, quarantine, and
  evidence admission;
- safe privacy findings, timelines, dispositions, retention, and destruction.

Every lease is bound to policy digest, principal/environment, transaction,
origin, browser context, page/frame, document epoch, operation, evidence
channel, classification, scope, and expiry. A lease is neither serializable into
public contracts nor transferable between those bindings. Policy, origin,
document, context, cancellation, expiry, or collector uncertainty invalidates
it.

`VeilRuntimeSession` owns serialized and idempotent transitions. A collector
acknowledgement is accepted only when it reports observable state matching a
declared manifest. Required acknowledgement failure seals the session.

`VeilEvidenceAdmission` is the only boundary allowed to make bytes durable or
user-visible. It validates a current lease, provenance, collector state,
classification, sanitation/masking proof, and policy/decision digests before
atomically storing bytes and safe metadata. Quarantine destroys bytes and
retains only non-sensitive disposition metadata. API, MCP, UI, reporting, and
Praxis consume admitted manifests; none may reinterpret privacy.

Praxis declares required and optional evidence channels. It receives scoped
capabilities or typed refusal/degradation, never protected values or authority
to weaken policy. A privacy failure cannot be represented as action, evidence,
or interaction success.

## Cutoff

The compatibility adapter from the current execution policy may only tighten a
Veil policy. It is removed at Milestone 9. The cutoff verifier must reject:

- imports or construction of the legacy `PrivacyGate`;
- low-level capture or artifact writes outside Veil-owned modules;
- available artifacts without a Veil admission record and current provenance;
- no-op/passive collector acknowledgements;
- Praxis providers or consumers that collect evidence without a scoped lease;
- retrieval of quarantined, destroyed, expired, or unadmitted bytes.

The previous complete release is the rollback unit. Rollback must never compose
Veil with a partially restored legacy privacy path.

## Consequences

This is a foundational subsystem correction. Contracts, executor, collectors,
Praxis, storage, API/MCP/UI, migrations, campaigns, and CI advance through gated
increments but cut over as one compatible release. Completion requires all Veil
and Praxis campaigns, production-shaped topology proof, and independent privacy
and verification reviews with no unresolved blocker or high finding.

