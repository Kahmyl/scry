# Scry Assurance

Assurance exists to make false confidence difficult.

## Fundamental rule

PASS requires positive proof.

Absence of observed failure is not proof of success.

## Result semantics

### PASS

The claim was established with sufficient evidence.

### FAIL

The claim was disproven with sufficient evidence.

### INCONCLUSIVE

Assurance could not establish the claim either way.

Examples:

- missing evidence
- oracle failure
- mixed retry outcomes
- incomplete required work

### SKIPPED

The verification was intentionally not evaluated.

A required skipped verification cannot qualify a campaign.

### NOT_RUN

Planned work did not execute.

A required not-run verification cannot qualify a campaign.

## Verification

Every verification identifies:

- claim
- oracle
- supporting evidence

Where practical, the subsystem under test must not be its own sole oracle.

## Fixtures

Fixtures should expose independent ground truth.

## Campaigns

Campaigns compose qualification work.

Required cases gate qualification.

Observational cases remain visible but do not silently become gates.

## Journeys

Journeys test task outcomes, not merely action health.

Every journey has a final task-level completion oracle.

## Attempts

Attempts are preserved.

Mixed outcomes are inconclusive rather than silently reporting the final retry
as success.

## Metrics

Metrics are observational by default.

A metric becomes a qualification criterion only through an explicit
verification claim.

## Corpus

Cases are promoted after the underlying general phenomenon is understood.

Application provenance may remain without application-specific behavior
becoming runtime architecture.

## Relationship to ordinary tests

Unit and focused integration tests remain close to implementation.

Assurance owns cross-cutting:

- capability qualification
- regression qualification
- fixtures
- campaigns
- journeys
- experiments
- system/release qualification
