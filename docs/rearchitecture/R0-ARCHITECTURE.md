# Scry R0 Target Architecture

## 1. Objective

R0 resets Scry from an internally adjudicative browser automation system into an agent-first execution substrate.

The target loop is:

```text
External agent reasons
        ↓
Scry exposes factual browser state
        ↓
Agent chooses
        ↓
Praxis executes mechanically
        ↓
Chronicle records facts
        ↓
Assurance independently verifies / learns
        ↓
Agent adapts
```

The external agent is the intelligence layer. Scry is the trustworthy browser/runtime layer.

---

## 2. Governing invariants

### 2.1 Reasoning authority

The agent may reason about:

- what the user intends;
- which candidate is semantically appropriate;
- whether ambiguity is acceptable;
- what to try next;
- how to recover from a factual failure.

Scry must not silently substitute a different target because it looks similar, has the same role/name/text, or exceeds a heuristic confidence threshold.

### 2.2 Execution authority

Scry may enforce hard factual/mechanical conditions:

- page/document/frame identity;
- reference belongs to the current browser entity;
- target detached/replaced/moved/covered;
- operation mechanically impossible;
- dispatch definitely did not begin;
- dispatch may have begun and outcome is unknown;
- browser/context/page lifecycle facts;
- trust/privacy boundaries.

### 2.3 Uncertainty

> Uncertainty is exposed, not silently converted into authority.

If mutation may have crossed the browser boundary, Scry must not report `not_applied` unless independently established.

---

# 3. Subsystems

## Praxis — browser substrate

Target package:

```text
packages/praxis/src/
  runtime/
  perception/
  interaction/
  references/
  observation/
```

Praxis owns:

- Playwright browser/context/page/frame/tab/popup lifecycle;
- page/document/frame identity;
- synchronization and revision mechanics;
- DOM/a11y/text/structure/geometry/visibility/occlusion/OCR/visual/canvas observation;
- candidate discovery/ranking as information, not semantic authority;
- browser interaction primitives;
- pinned target references;
- exact mechanical revalidation;
- normalized browser/action observations.

Praxis may expose confidence, ranking, provenance, and incompleteness. Those are information.

Praxis must not block an agent choice merely because an internal semantic confidence threshold was not reached.

### Reference invariant

Once a browser entity is observed and pinned, interaction uses that exact entity.

A replacement element with identical semantics is a different entity.

No selector/name/role/text/candidate re-resolution may silently substitute a replacement after pinning.

---

## Chronicle — factual record and artifact boundary

Package:

```text
packages/chronicle
```

Chronicle owns:

- append-only factual event/evidence contracts;
- artifact persistence contracts;
- provenance;
- artifact references.

`artifact` remains a domain noun and resource scheme:

```text
scry://artifact/...
```

Chronicle root must remain policy-free. Existing legacy proof/admission behavior may remain behind an explicit legacy boundary until migrated deliberately.

Chronicle records truth. It does not decide semantic correctness.

---

## Veil — narrow trust boundary

Veil answers only questions such as:

- may this protected value be disclosed?
- may this protected handle be used?
- must this region be redacted?
- what must not be persisted?
- what capture/recording must be suppressed?

Veil must not:

- choose browser targets;
- rank semantic strategies;
- decide task progression;
- own browser orchestration;
- decide whether an action was semantically correct.

Privacy behavior must not be weakened during migration.

---

## Assurance — independent qualification

Assurance owns:

- observability;
- investigations;
- experiments;
- fixtures;
- campaigns as composition;
- live journeys;
- regression corpus;
- reporting;
- cross-cutting verification.

It must not become a synchronous runtime admission gate.

### Truth model

```text
PASS
  sufficient positive evidence establishes the claim

FAIL
  sufficient evidence establishes the claim does not hold

INCONCLUSIVE
  neither success nor failure is established

SKIPPED
  intentionally not evaluated

NOT_RUN
  planned but not executed
```

Required aggregation:

- any required FAIL => fail;
- any required INCONCLUSIVE/SKIPPED/NOT_RUN => not qualified;
- only all required PASS => qualified.

### Independent oracle

Where practical:

```text
claim
+ evidence
+ independent oracle
```

A Scry success return is not enough when an external fact can be observed.

### False-positive calibration

A verifier should, where practical, have both:

```text
safe implementation → PASS
deliberately broken comparator → FAIL
```

If both pass, the verifier is invalid.

---

## Product domain

Keep:

```text
Project
Mission
Flow
Run
```

Interpretation:

- Project — workspace/domain boundary.
- Mission — larger user objective.
- Flow — authored/repeatable meaningful portion, versioned as needed.
- Run — concrete execution with actions, observations, timing, outcome, evidence.

These organize and record work.

They must not become mandatory browser-access ceremony or internal intelligence.

Authoring is representation, not intelligence.

---

# 4. Dependency direction

Target conceptual dependency:

```text
External Agent
      |
    MCP/API
      |
Product/Application
(Project/Mission/Flow/Run)
      |
 +----+-----------+
 |                |
Praxis         Chronicle
 |                |
Browser           |
 |                |
 +---- Veil ------+
        narrow trust contract

Assurance reads/analyzes runtime facts and Chronicle evidence.
```

Rules:

- Product may use Praxis, Chronicle, Veil.
- Praxis may consult Veil only through a narrow trust contract.
- Praxis may emit Chronicle-compatible facts.
- Assurance may depend on/read runtime and Chronicle evidence.
- Praxis, Chronicle, and Veil must not depend on Assurance.
- Chronicle contains no execution policy.
- No dependency cycles.

---

# 5. Development rule

The reset is experiment-first and vertical-slice driven.

Use:

```text
OBSERVE REAL FAILURE
→ REPRODUCE
→ IDENTIFY CAUSAL CLASS
→ EXPERIMENT
→ MINIMUM GENERAL FIX
→ VERIFY WITH INDEPENDENT ORACLE
→ REGRESSION
→ CHECKPOINT
→ RETURN TO REAL SURFACE
```

Do not replace this with theoretical hardening or giant certification campaigns.

Each slice should migrate one concrete responsibility and prove it before multiplying adjacent behavior.
