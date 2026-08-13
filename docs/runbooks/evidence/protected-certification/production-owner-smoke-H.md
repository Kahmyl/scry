# Protected Transaction Certification 5f20048f-167a-4d5a-a838-98eab35c3506

- Passed: false
- Cells: 1/7
- Iterations: 7/7
- Evidence unavailable: 0
- New defects: 1
- Harness errors: 0
- Watchdog timeouts: 5
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
  "active_lease_after_terminal": 0,
  "active_browser_owner_after_session_close": 0,
  "safe_evidence_resume_without_confirmed_boundary": 0,
  "late_result_state_advancement": 0
}
```
