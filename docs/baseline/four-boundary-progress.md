# Scry four-boundary reset progress

Status: Veil cutover implemented and locally qualified

The current baseline remains the authority for behavior, public contracts, and
durable data. This record tracks implementation of the
[four-boundary plan](four-boundary-implementation-plan.md).

## Completed and remaining work

| Workstream                              | State                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Baseline research                       | Complete; reachability, state, failure, verification, and disposition recorded                                  |
| Initial contracts and composition seams | Complete; the worker uses the Praxis execution port and report persistence uses the Veil report-protection port |
| Veil protection ownership               | Complete; active baseline consumers use the extracted Veil implementation                                       |
| Chronicle evidence ownership            | Next                                                                                                            |
| Praxis browser ownership                | Pending Chronicle's evidence interface                                                                          |
| Assurance diagnostics and qualification | Pending production-boundary cutover                                                                             |
| Final cleanup and completion proof      | Pending                                                                                                         |

## Veil ownership

The production API and consolidated browser runtime now depend on
`@scry/veil`. Veil owns:

- sensitive-value classification, exact and encoded matching, and lineage;
- observation, replay, and report sanitization;
- error representations used for public replies, finalization, and stored
  command failures;
- protected command masking and safe DOM semantic hints;
- protected capture quarantine, publication, discard, expiry, and recovery;
- validation of publication decision completeness, captured paths, values,
  allowed sinks, and trusted disclosure;
- recording input masks, blocked surfaces, and privacy options;
- protected key selection, key derivation, and historical configuration reads;
- protected-value encryption and decryption; and
- evidence encryption and authenticated historical reads.

The API retains product admission, scope validation, database locking,
transactions, and lifecycle coordination. Its cipher and report-protection
adapters delegate to Veil. Browser execution and recording lifecycle remain in
the existing runtime until their respective moves.

Evidence ordering, compression for storage, manifests, chain validation,
retention, and replay rendering remain outside Veil. The evidence cipher
protects the existing compressed payload format while the evidence store
continues to own the chain and filesystem manifest.

No schema migration or data reset is required. Existing key identifiers,
derivation contexts, authenticated metadata, encrypted-value records, capture
envelopes, and evidence records keep their existing representations. Historical
read compatibility remains covered by tests.

## Removed implementations

The ten dormant Veil modules have been replaced by the active baseline's
protection implementation. The classifier, sanitizer, protection authority,
capture vault, and keyring no longer have implementations in their former
runtime or API locations. An unused browser-sanitizer source generator was also
removed after confirming it had no callers. These removals are recoverable
from Git history.

Dormant consumers of the retired Veil API are outside the production baseline.
They remain excluded from deployment and are scheduled for the later
reachability-led cleanup; compatibility facades were not added for them.

## Verification

The relocated tests retain the baseline's privacy and capture cases. Additional
checks cover publication admission and authenticated value context.

| Check                                        | Result                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Complete repository verification             | Pass: formatting, types, 82 ordinary tests, build, topology, workflows, publication policy, and deployment-controller behavior |
| Veil suite                                   | 43 tests pass, including quarantine, failed publication, discard, tampering, expiry, and historical-key reads                  |
| Ownership-rule negative tests                | Pass: cryptographic implementations outside Veil, internal imports, and production Assurance dependencies are rejected         |
| Database lifecycle and failure integration   | 13 tests pass on a fresh isolated database                                                                                     |
| Real-browser recording and replay            | 2 tests pass                                                                                                                   |
| Durable worker journey                       | 1 test passes through the production composition seam                                                                          |
| Failure finalization                         | 1 test passes while preserving uncertain mutation outcomes                                                                     |
| Worker process recovery                      | 3 tests pass                                                                                                                   |
| Long browser journey                         | 1 test passes through evidence closure and replay                                                                              |
| Production dependency image and import smoke | Pass: Veil, API adapters, and the evidence store load without development tools or Assurance                                   |

The API typecheck now enumerates the active authentication files. Its previous
glob pulled in a dormant authentication module and the old observability
implementation on a fresh dependency installation. The active authentication
path and its scope tests remain covered.

Container definitions now install and copy Veil in the production image, and
development sync includes Veil changes. Browser qualification explicitly enables
the real-browser recording cases. `pnpm verify:veil-runtime` repeats the
production dependency build and import smoke and is required by fast
qualification. This proves production package availability; it is not a
deployment to a running environment. The known fresh-production activation gap
and inactive relational evidence tables recorded by baseline research remain
separate from this relocation.

## Protection correction found during the consumer audit

The structural relocation was committed separately from one confirmed
confidentiality correction. Browser observations previously sanitized the URL
and page text but returned the page title directly. A real-browser regression
put a known protected credential in the title and reproduced its disclosure
through a completed durable command.

The observation now passes the title through the same Veil policy used for
other observation text. The regression verifies that ordinary title text
remains readable while the credential is removed. The database qualification
lane runs this durable-worker journey with Chromium, Redis, and its own fresh
database. This is an intentional correction to the previous observable
behavior, with no new protection policy or data format.

## Next implementation slice

Chronicle will receive the current evidence store, accepted execution history,
manifest and integrity management, recording closure, and replay construction.
Its interfaces will accept Veil-protected material and preserve the baseline's
existing filesystem evidence plus PostgreSQL stream-summary behavior.
