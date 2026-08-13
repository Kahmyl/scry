# Protected Transaction Certification 946342c1-c3e0-4631-9fe5-51456e037b6e

- Passed: false
- Cells: 7/7
- Iterations: 175/175
- Evidence unavailable: 0
- New defects: 1
- Harness errors: 0
- Watchdog timeouts: 0
- Unexplained hangs: 0

## Invariants

```json
{
  "unexplained_hangs": 0,
  "one_time_dispatch_count_lte_one": true,
  "post_dispatch_redispatch_count_zero": true,
  "terminal_or_recovery_state_eventually": true,
  "plaintext_leaks": 0,
  "partial_reference_commits": 0,
  "stale_fence_advancement": 0,
  "active_lease_after_terminal": 0,
  "active_browser_owner_after_session_close": 0,
  "safe_evidence_resume_without_confirmed_boundary": 0,
  "late_result_state_advancement": 0
}
```
