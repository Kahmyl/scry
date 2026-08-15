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
- artifact storage implementations as they are migrated.

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
