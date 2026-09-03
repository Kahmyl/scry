# Assurance legacy consolidation

The pre-reset Assurance compatibility surface has been retired.

## Final disposition

Reusable mechanisms were promoted narrowly into the clean Assurance system:

- campaign metrics -> `src/observability/campaign-metrics.ts`
- report retention/readback -> `src/reporting/campaign-report.ts`
- report sanitization -> `src/reporting/campaign-sanitization.ts`
- deterministic adaptive fixture -> `src/fixtures/adaptive-fixture.ts`

Milestone-specific adaptive campaign evaluation remains beside the historical
API campaign scripts. It is not a generic Assurance truth or runtime-admission
API.

The still-active Praxis and Veil browser campaigns are now ordinary Assurance
qualification infrastructure under:

`packages/assurance/scripts/campaigns`

The package no longer exposes `@scry/assurance/legacy`, contains no
`src/legacy` implementation, and contains no `scripts/legacy-campaigns`
directory.

Campaigns previously named `certification` were renamed `qualification` to
avoid confusion with the retired production certification/admission model.

This does not rename historical persisted evidence or documentation merely for
terminology consistency. Historical records remain historical facts.

Assurance remains downstream-only: it verifies, qualifies, observes,
experiments, synthesizes evidence, and reports support. It does not authorize
or progress production execution.

## Change-sensitive verification ownership

The retired `verify-praxis-change-gate.mjs` and
`verify-veil-change-gate.mjs` scripts belonged to the former model where
dedicated GitHub workflows ran the entire Praxis/Veil campaign matrix for
every relevant change and Docker release.

Those dedicated workflows no longer exist, and restoring them would conflict
with Scry's impact-aware verification model.

Change-sensitive test selection is owned by the repository verification
registry/driver. Assurance owns the qualification campaigns themselves and
their evidence, while the verification layer decides which affected
qualification surfaces need to run for a given change.

Expensive full qualification remains available explicitly and for appropriate
release/soak use; it is not silently restored as a universal synchronous gate.
