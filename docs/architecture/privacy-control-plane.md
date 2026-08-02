# Privacy control plane

The Privacy Gate is the sole authority for evidence admission. Recording and
trace coordinators, screenshots, DOM/accessibility, diagnostics, network, events,
reports, clipboard, and downloads all receive an explicit decision from the
gate. Overlay visibility is not an acknowledgement and is not a security proof.

Collector acknowledgements are concurrent and share a bounded transition
window. A reveal cannot begin until recording and trace have stopped and every
passive collector has acknowledged suppression. Evidence remains closed through
safe-boundary establishment and reopens only after every collector resumes.

Any failed acknowledgement, cancellation, timeout, page loss, or uncertain
finalization seals the gate. Quarantined artifact bytes are destroyed; only
non-sensitive reason metadata remains, and artifact APIs refuse access.

Phase 2 validates this lifecycle with synthetic values only. Existing protected
handlers use the gate for containment but seal after capture because they cannot
prove the atomic safe boundary introduced in Phase 3.
