# Experiments

Experiments compare controlled alternatives against the same factual oracle.

The intended flow is:

```text
observed problem
      ↓
hypothesis
      ↓
baseline + candidate variants
      ↓
same verification / same scenario
      ↓
evidence + measurements
      ↓
comparison
      ↓
architectural synthesis
```

A failed candidate is valid experimental evidence. It does not mean the
experiment infrastructure failed.

Likewise, a passing candidate does not automatically become production code.

Assurance reports the comparative facts and keeps the production decision
explicitly `undetermined`. An architect or external engineering agent uses the
evidence to decide whether the professional production solution is a small
fix, a new primitive, or a cohesive refactor.

Experiments therefore have no execution-authority role in Scry runtime.
