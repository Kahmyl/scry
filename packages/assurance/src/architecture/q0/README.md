# Q0 system-correctness manifest

This directory is the versioned Milestone-1 architecture and Assurance reference model.

It describes production authorities and checks them for drift. It is not a runtime state machine,
is not exported from `@scry/assurance`, and must never be imported by production services for
lifecycle admission or transition decisions.

Production contracts, transition helpers, repositories, and schemas remain authoritative. Q0
imports or reads those sources from Assurance and reports disagreement. Declared cross-system
invariants describe relationships no single production component currently owns; Milestone 2 will
make those sequence checks executable.

Ownership entries distinguish semantic truth, transition policy, command/orchestration,
transaction/persistence, projection, and independent qualification. Multiple components in
different layers are not duplicate semantic authority; only genuine same-role authority or an
unresolved classification blocks stabilization readiness.

Run `pnpm --filter @scry/assurance q0` to validate the manifest, exercise deterministic negative
controls, and write machine-readable and human-readable reports under
`artifacts/system-correctness/q0/`.
