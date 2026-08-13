# Protected Transaction Certification d5946da9-045f-46aa-afc3-1c7d457d54a2

- Passed: false
- Cells: 108/109
- Iterations: 2215/2215
- Evidence unavailable: 0
- New defects: 63
- Harness errors: 1
- Watchdog timeouts: 0
- Unexplained hangs: 0

## Invariants

```json
{
  "unexplained_hangs": 0,
  "one_time_dispatch_count_lte_one": false,
  "post_dispatch_redispatch_count_zero": true,
  "terminal_or_recovery_state_eventually": true,
  "plaintext_leaks": 0,
  "partial_reference_commits": 0,
  "stale_fence_advancement": 0,
  "active_lease_after_terminal": 8,
  "active_browser_owner_after_session_close": 0,
  "safe_evidence_resume_without_confirmed_boundary": 0,
  "late_result_state_advancement": 0
}
```
