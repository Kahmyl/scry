# Legacy Assurance Audit

The pre-reset campaign implementation is temporarily preserved under
`src/legacy`.

It is compatibility code, not the new Assurance architecture.

## contracts.ts

Disposition: ARCHIVE / TRANSITION

Old milestone-specific campaign contracts must not define the new Assurance
truth model.

## gates.ts

Disposition: REWRITE OR DELETE

Generic gates are dangerous when observational concerns silently become
qualification authority.

A retained gate must correspond to an explicit verification claim and oracle.

## metrics.ts

Disposition: RETAIN CANDIDATE -> OBSERVABILITY

Measurement collection may be useful.

Metrics remain observational unless a real requirement is represented as an
explicit verification.

## redaction.ts

Disposition: RELOCATE / REASSESS

Assurance may sanitize its own output, but general privacy authority does not
belong here.

## report.ts

Disposition: RETAIN CANDIDATE -> REPORTING

Useful report serialization may survive.

Reports present qualification; they do not establish execution truth.

## verification.ts

Disposition: REWRITE

The new model requires:

- explicit claim
- oracle
- evidence
- honest inconclusive state

## fixtures/adaptive-fixture.ts

Disposition: RETAIN AS REGRESSION CANDIDATE

Potentially useful deterministic infrastructure.

It must not define the foundational fixture abstraction.

## legacy-campaigns.test.ts

Disposition: TEMPORARY COMPATIBILITY REGRESSION

It verifies only the retained legacy surface.

It does not qualify the new Assurance truth model.
