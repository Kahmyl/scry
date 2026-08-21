# GPT-5.6 Sol Long-Run Execution Protocol

This file is the operating handoff for a long-running autonomous R0 session.

## Mission

Continue the Scry R0 re-architecture from the exact current repository state toward approximately complete agent-first architecture.

Do not stop after one small subtask if the repository is green and the next ordered slice is clear.

Continue through the roadmap until:

1. the roadmap is substantially complete;
2. a genuine architectural ambiguity requires owner input;
3. a real environment/external-service blocker prevents safe progress;
4. remaining context/time is too low to complete the next coherent slice safely.

When stopping, leave a clean checkpoint or a precisely documented coherent dirty state.

---

# 1. Read first

Read only:

```text
docs/rearchitecture/README.md
docs/rearchitecture/R0-ARCHITECTURE.md
docs/rearchitecture/R0-STATE.md
docs/rearchitecture/R0-ROADMAP.md
docs/rearchitecture/R0-SOL-RUNBOOK.md
```

Then inspect:

```bash
git branch --show-current
git status --short
git log -8 --oneline --decorate
```

The repository state is authoritative.

If another agent left dirty work:

> understand it before changing or discarding anything.

Never reset unknown work.

---

# 2. Time discipline

This is a fast re-architecture run.

Do not spend the session remapping the whole repository.

For each slice:

```text
read relevant files
→ identify ownership gap
→ implement
→ prove
→ checkpoint
→ continue
```

If more than ~10 minutes pass without implementation or a concrete causal finding, reduce the reading scope.

Use broad repository searches only to answer a specific dependency/call-site question.

---

# 3. Authority discipline

Always preserve:

> External agent owns reasoning authority. Scry owns execution authority.

Never introduce:

- heuristic semantic admission;
- confidence thresholds as execution authority;
- silent semantic target substitution;
- internal planner authority;
- a new synchronous Assurance gate;
- Chronicle execution policy;
- Veil browser-strategy authority.

---

# 4. Slice protocol

For each ordered roadmap slice:

## A. Establish current path

Find only:

- caller;
- current owner;
- desired owner;
- dispatch/mutation boundary;
- directly relevant tests.

## B. State the invariant

Examples:

```text
exact observed entity is mutated
replacement is never silently substituted
protected plaintext does not cross forbidden boundary
possible dispatch is represented as unknown
```

## C. Implement minimum general migration

Prefer reuse of established primitives over new parallel machinery.

## D. Qualification

Run targeted tests first.

Use independent Assurance evidence for the high-risk facts where practical.

Use negative control when it materially tests the verifier.

## E. Re-review

After green tests, inspect the changed path for:

- bypasses;
- duplicate ownership;
- TOCTOU lies;
- semantic re-resolution;
- privacy weakening;
- unnecessary complexity.

Remediate concrete findings.

## F. Wider regression

Run relevant package typechecks/tests and subsystem boundaries.

Do not run every historical campaign after every tiny change.

## G. Checkpoint

Create a coherent commit and push to:

```text
origin/rearchitecture/agent-first-scry
```

Never force-push.

Update `docs/rearchitecture/R0-STATE.md` with:

- completed slice;
- commit hash;
- evidence;
- next active slice.

Then continue without waiting for user approval if the next step is already defined by `R0-ROADMAP.md`.

---

# 5. Git safety

Active branch:

```text
rearchitecture/agent-first-scry
```

Never modify `main`.

Never:

```text
git reset --hard
git clean -fd
git restore unknown dirty work
git checkout -- unknown dirty work
force-push
rewrite existing R0 history
```

Before each commit:

```bash
git diff --check
git status --short
git diff --stat
```

After each push:

```bash
git rev-parse HEAD
git rev-parse origin/rearchitecture/agent-first-scry
git status --short
```

---

# 6. Test philosophy

PASS requires positive proof.

Do not infer success from absence of an exception.

For high-risk browser mutation behavior, prefer:

```text
fixture/server/browser truth
```

over:

```text
SUT returned success
```

For negative controls, deliberately unsafe behavior may exist only in test code.

Never weaken a verifier to make production pass.

---

# 7. Browser interaction rule

The established reference/click model is the template:

```text
observe
→ pin actual ElementHandle
→ mechanical revalidate
→ exact-handle interaction
→ never semantic retry
→ conservative uncertainty after possible dispatch
```

Use this model for subsequent interaction migrations.

Do not copy the click implementation blindly when another action has different browser semantics.

Analyze the irreversible boundary for that action.

---

# 8. Privacy rule

Protected data paths must remain at least as safe as the current implementation.

During R0.3:

- migrate browser mechanics into Praxis;
- keep Veil authority limited to trust/privacy;
- do not collapse protected and public paths until the trust boundary remains explicit.

During R0.4:

- remove orchestration/semantic authority from Veil;
- retain redaction/disclosure/persistence/capture restrictions.

No protected plaintext may be added to logs, diagnostics, evidence, artifacts, or serialized references.

---

# 9. Executor retirement rule

Do not delete Executor early.

Retire it only after each browser/runtime responsibility has a proven new owner.

For each removal:

```text
old owner
→ new Praxis owner
→ call sites cut over
→ regression
→ delete duplicate path
```

The target is not "rename Executor."

The target is:

> no second authoritative browser substrate remains.

---

# 10. Product simplification rule

Do not remove Project/Mission/Flow/Run.

Remove their role as execution admission/intelligence where legacy code still gives them that authority.

Keep them as durable representation and evidence context.

Do not introduce a replacement planner.

---

# 11. When blocked

If a test failure appears:

1. determine whether introduced by current slice;
2. reproduce narrowly;
3. fix if causal;
4. if demonstrably pre-existing, record it and continue only if it does not compromise the slice's truth.

If environment prevents browser/integration execution:

- do not claim PASS;
- leave exact local command;
- continue only with work whose correctness does not depend on that missing proof.

If genuinely blocked, write/update:

```text
docs/rearchitecture/R0-STATE.md
```

with:

```text
BLOCKED
cause
evidence
last green commit
dirty files
exact next command
```

Then stop rather than speculative editing.

---

# 12. Fast-track priority

If there is insufficient time for all remaining work, prioritize:

```text
1. finish Praxis/Executor ownership consolidation
2. narrow Veil
3. remove product/runtime semantic admission authority
4. cut over application/MCP/API
5. controlled qualification
6. live qualification
7. cosmetic cleanup last
```

The goal is coherent architecture, not maximum cleanup.

---

# 13. Final run report

When the session ends, report:

```text
START HEAD

SLICES COMPLETED
- slice
- commit
- proof

CURRENT ARCHITECTURE
Praxis:
Chronicle:
Veil:
Assurance:
Product/Application:
Executor:

REMOVED LEGACY AUTHORITY
...

REMAINING LEGACY AUTHORITY
...

TEST / QUALIFICATION STATUS
...

LIVE QUALIFICATION STATUS
...

COMMITS PUSHED
...

CURRENT HEAD
...

WORKTREE
...

R0 COMPLETION ESTIMATE
...

EXACT NEXT ACTION
...
```

Do not describe a phase as complete unless its closure condition in `R0-ROADMAP.md` is established.
