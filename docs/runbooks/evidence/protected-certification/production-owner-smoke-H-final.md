# Protected Transaction Certification 83e06fb2-2e49-4a77-afc0-479e714b564b

- Passed: true
- Cells: 7/7
- Iterations: 7/7
- Evidence unavailable: 0
- New defects: 0
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
