# Scry Chronicle

Chronicle owns factual evidence contracts and artifact persistence.

It does not decide what Scry should do.

## Responsibilities

Chronicle provides:

- factual event contracts;
- event sinks;
- artifact persistence contracts;
- artifact integrity metadata;
- artifact storage-key safety;
- artifact storage implementations as they are migrated;
- policy-neutral Mission evidence composition and deterministic integrity digests.

## Evidence

Chronicle records facts.

Examples:

- an action was requested;
- a browser dispatch occurred;
- a document changed;
- an artifact was attached;
- an operation completed or failed.

Chronicle does not infer semantic correctness from those facts.

## Artifact

An artifact is a stored object such as:

- screenshot;
- video;
- trace;
- network capture;
- DOM snapshot;
- download;
- report.

The owning subsystem is Chronicle.

The domain object remains named `artifact`.

Resource identifiers such as `scry://artifact/<id>` therefore remain valid.

## Veil

Veil owns protection/trust decisions.

Chronicle MUST NOT:

- classify secrets;
- select protection strategy;
- issue capture permits;
- decide evidence admission;
- decide execution policy.

A caller may consult Veil before giving bytes to Chronicle.

Chronicle persists the already-authorized result.

## Legacy compatibility

`@scry/chronicle/legacy` contains the old Artifact package semantics.

Those semantics require Veil admission proofs inside storage operations.

This is temporary compatibility code.

New code must use the clean Chronicle root API.

## Event ontology

Chronicle intentionally does not begin with a large closed event enumeration.

The event vocabulary will grow from demonstrated runtime needs during the
Praxis and product-domain migrations.

## Mission evidence composition

Chronicle may compose facts that a caller has already admitted as Mission evidence.

This composition is deliberately policy-neutral:

- the caller decides which Run or Artifact is admitted;
- Chronicle verifies factual provenance consistency;
- Chronicle orders accepted facts deterministically;
- Chronicle records canonical Run / Attempt / Artifact provenance;
- Chronicle computes a deterministic evidence digest;
- Chronicle does not infer that accepted evidence proves the user's objective.

Agent conclusions and journey narration remain outside the factual evidence digest.

## Mission recording composition

Chronicle may compose browser recording facts for Runs that a caller has explicitly selected and ordered as part of a Mission journey.

The recording composer is policy-neutral:

- the caller supplies the selected Runs and explicit Run order;
- Chronicle never infers cross-Run authority from `created_at`;
- each selected Run names its canonical Attempt;
- canonical timeline ordering comes from the persisted Attempt-local timeline sequence, not producer-local artifact metadata;
- independently persisted video and trace artifacts remain independent immutable objects;
- intentional gaps and checkpoint/capture boundaries remain first-class manifest entries;
- Chronicle validates Run / Attempt / Artifact / context / capture-epoch consistency;
- Chronicle computes a deterministic recording digest;
- Chronicle does not concatenate or rewrite media bytes;
- Chronicle does not decide whether the selected journey proves the Mission objective.

Checkpoint restoration is a Praxis/runtime continuity fact. A caller may attach verified successor-checkpoint continuity to adjacent selected Runs, but Chronicle does not invent that relationship.

Which Runs belong to the user-facing Mission journey remains outside Chronicle.
