# Protected execution capsules

Unknown generated secrets execute through one `ProtectedTransactionCoordinator`. The evidence-producing Chromium process is parked before mutation. A separate Chromium process is created from encrypted pre-secret safe state, receives no evidence or artifact capabilities, performs the calibrated mutation once, extracts directly into the vault, and is then destroyed. No browser state is copied back.

Evidence may resume only on the parked safe process or an independently restored safe process after approved re-entry and assertions. Mutation, extraction, persistence, capsule destruction, reconciliation, continuation, evidence, and credential-security outcomes are persisted independently. One-time mutation dispatch is fenced and is never replayed after dispatch begins.

Element and surface masking are not privacy authorities for unknown generated values. Known-value scanning detects regressions but cannot authorize resumption. Public values use ordinary capture; known secret fills register redaction before browser use and create a bounded evidence gap.
