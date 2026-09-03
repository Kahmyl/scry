# Q1 executable truth engine

Q1 is an Assurance-only cross-system assertion engine. It consumes the committed Q0 invariant
registry and authoritative production contracts, or translates read-only durable repository facts
into a compact immutable snapshot. It never participates in runtime admission or state changes.

The reference reducer exists only for deterministic tests. It does not define production lifecycle
legality. Production schemas and transition helpers remain authoritative; Q1 asserts relationships
between their facts.

Every result separates executable assertion status from current production proof status. A passing
reference sequence therefore cannot upgrade process-loss, browser, provider, campaign, dashboard,
or independent-oracle proof assigned to later milestones.
