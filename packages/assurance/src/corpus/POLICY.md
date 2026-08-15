# Corpus Promotion Policy

The corpus is curated, not accumulated.

A failure does not enter the permanent corpus merely because it happened.

A case is promoted when we can state:

- the general phenomenon;
- the original failure provenance;
- a controlled or minimal reproduction;
- the invariant that must hold;
- the oracle used to determine the result;
- the evidence required for PASS;
- how the verifier detects the broken condition.

## Application failures

Prefer:

    allowed-popup-origin-differs-from-agent-expected-origin

over:

    vitract-popup-bug

The application may remain recorded as provenance.

## Duplicate cases

Do not add a new corpus entry when an existing case already represents the
underlying phenomenon.

## Removal

Corpus cases may be retired when:

- the represented capability no longer exists;
- the case duplicates a stronger case;
- the oracle cannot reliably distinguish correct and broken behavior;
- the test protects implementation structure rather than behavior.
