# Protected recovery contract

## Authority chain

Recovery state is refined by a single ordered production chain:

1. `ProtectedOperationRepository.claim()` owns lease expiry, stale-owner fencing, and the provisional durable recovery classification.
2. `ProtectedTransactionKernel.recoverDurable()` owns evidence-based refinement after the new fence is acquired.
3. `ProtectedOutputPersistenceRepository` owns the staged-versus-committed output evidence used by that refinement.
4. The credential repository owns compromise actions for credentials that were actually persisted.
5. Mission owns activation and projection. It does not manufacture a recovery outcome.

`recovery_required` is a non-terminal transitional state. It means the mutation may have happened, redispatch is forbidden, and no recovered evidence yet proves either complete settlement or protected-material compromise.

`compromised` is a durable post-dispatch refinement. It is valid only when protected material was affirmatively observed or persisted and the required output set cannot be trusted as complete. Absence of output is not evidence that a credential was exposed.

## Authoritative decision table

| Mutation semantics | Durable evidence after reclaim                            | Result                        | Redispatch            |
| ------------------ | --------------------------------------------------------- | ----------------------------- | --------------------- |
| one-time mutation  | no recovered outputs                                      | `recovery_required` / unknown | forbidden             |
| one-time mutation  | incomplete set containing protected material              | `compromised` / unknown       | forbidden             |
| one-time mutation  | complete staged set, atomically persisted during recovery | `completed` / applied         | forbidden             |
| one-time mutation  | complete committed reference set                          | `completed` / applied         | forbidden             |
| one-time mutation  | complete public-only staged or committed set              | `completed` / applied         | forbidden             |
| read-only          | no request/result evidence after owner loss               | `failed_not_applied`          | not a mutation replay |

The starting post-dispatch state (`dispatching`, `dispatched`, `acquiring`, `persisting`, `persisted`, or `reconciling`) does not override stronger durable output evidence. Repository reclaim first advances the fence; the kernel then applies this table.

## Executed evidence

The production-shaped 24-cell PostgreSQL truth table is recorded in `docs/runbooks/evidence/protected-certification/recovery-truth-table.json`. It covers post-dispatch starting states, mutation versus read-only semantics, no/partial/complete staged evidence, committed evidence, protected versus public-only outputs, fencing, dispatch deltas, and credential compromise actions.
