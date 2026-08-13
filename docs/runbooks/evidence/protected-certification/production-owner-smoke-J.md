# Protected Transaction Certification 281460be-1545-472a-a48a-cde1d633283c

- Passed: false
- Cells: 4/6
- Iterations: 6/6
- Evidence unavailable: 0
- New defects: 2
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
