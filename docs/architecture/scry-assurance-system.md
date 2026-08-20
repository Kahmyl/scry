# Scry Assurance System

Yes. I get the direction now, and I think there’s a much cleaner way to describe what you’re proposing.

The core idea is **not “build a better certification harness.”** It is bigger than that:

> Scry needs its own internal **assurance system** whose job is to continuously prove, diagnose, experiment on, and improve Scry itself.

That system should be treated almost like a product inside the repo.

### The distinction I think you’re making

Right now we have pieces scattered everywhere:

```text
Campaigns
Unit/integration tests
Boundary verification
Qualification scripts
Certification harness
Fault injection
Experimental scratch scripts
Runtime evidence
Diagnostics from real runs
Privacy checks
Stress tests
```

And because they evolved one problem at a time, they don't form one coherent methodology.

Your proposal is essentially:

```text
                     Scry
                      │
             actual executions/runs
                      │
                      ▼
               Scry Assurance
                      │
      ┌───────────────┼────────────────┐
      │               │                │
   Observe         Experiment        Verify
      │               │                │
 evidence      compare approaches    scenarios
 anomalies      outside mainline     regressions
 latency          fault injection     capabilities
      │               │                │
      └───────────────┼────────────────┘
                      │
                      ▼
                 Synthesize
                      │
       “What is the correct production
              change based on evidence?”
                      │
                      ▼
                  Scry code
                      │
                      ▼
              certify the result
```

That is very different from what we've been doing.

And I think **“Assurance”** may actually be a better umbrella name than `Lab`.

`Lab` describes one thing it does: experimentation.

`Assurance` describes the actual purpose:

> Build evidence that Scry behaves correctly, robustly, safely and broadly.

You could still colloquially call it the Scry Lab.

For example:

```text
packages/assurance
```

or eventually:

```text
packages/assurance/
    experiment/
    verification/
    certification/
    evidence/
    scenarios/
    analysis/
```

But **not now** at that size.

---

## Experimentation is especially important to define correctly

I understand what you mean here.

What we previously called experimentation sometimes looked like:

```text
change production code
→ run
→ doesn't work
→ patch somewhere else
→ run again
```

That's debugging.

What you're describing as **experimentation** is more like:

```text
Observed problem
      ↓
Hypothesis A
Hypothesis B
Hypothesis C
      ↓
Create controlled variants
      ↓
Run identical scenarios against them
      ↓
Compare evidence
      ↓
Determine which mechanism actually solves the class of problem
```

And importantly:

> **Those experiments do not automatically become the production implementation.**

Suppose experimentation proves:

```text
Patch A fixes timeout problem
Patch B fixes ownership problem
Patch C fixes late completion
Patch D fixes cleanup
```

The conclusion shouldn't necessarily be:

```text
Production = A + B + C + D
```

Instead the synthesis step asks:

> Why did all four fixes work?

Maybe they reveal:

```text
All four failures exist because
async lifecycle ownership is fragmented.
```

Then the proper production solution might be one cohesive lifecycle abstraction rather than four patches.

Or the evidence may show that four small independent fixes actually **are** the cleanest professional solution.

That decision comes **after evidence**, not before.

That distinction is extremely important.

---

## And yes, this fixes another problem we've repeatedly hit

We've been testing Scry against fairly simple synthetic pages and then eventually encountering something like Vitract:

```text
navigate
→ authenticate
→ portal
→ developer section
→ mode
→ application
→ credentials
→ protected creation
→ documentation
→ protected inputs
→ request
→ response acquisition
→ continuation
→ ...
```

And suddenly assumptions that seemed valid under a three-step fixture collapse.

A proper assurance system should therefore have **journey depth** as a dimension.

Not just:

```text
Does click work?
Does protected output work?
```

But:

```text
Can this capability still work at step 17
after:
    navigation
    auth
    dynamic rendering
    state transitions
    several semantic resolutions
    protected operations
    session retention
    previous failures
    multiple document epochs?
```

That is much closer to the confidence Scry actually needs.

Campaigns are useful here, but they're only one input into Assurance.

---

## Another part of your idea I strongly agree with: learn from ordinary runs

The assurance system shouldn't only exist when we explicitly execute:

```bash
pnpm certification:...
```

Normal Scry runs should produce **safe evidence that can feed it**.

For example, Assurance could eventually notice:

```text
Semantic target resolved successfully
but required 3 attempts.

Praxis fallback was necessary.

Native resolution confidence was unusually low.

Protected response took 4.8s.

Agent required 2 continuation turns.

Control succeeded only after readiness retry.

New DOM/control shape observed.

A supposedly supported capability repeatedly
lands near its timeout.
```

None of those necessarily means the run failed.

But they are **signals**.

Then you build up something closer to a real Scry experience corpus:

```text
scenario
application characteristics
control characteristics
resolution path
fallback path
latency
success/failure
failure classification
browser/runtime conditions
recovery behavior
```

Over time that tells you much more than:

> “Our tests pass.”

It starts telling you:

> “We've seen 1,500 distinct control situations across X application styles, and this capability succeeds in these classes while these other classes remain experimental.”

That's the route toward evidence-backed claims about broad web compatibility.

I would avoid literally promising “98% of websites” until the corpus actually supports a statistically meaningful number, but **the system you're describing is how you eventually get to making claims like that based on evidence instead of intuition.**

---

## Certification then becomes one mode, not the whole system

This also clears up our terminology.

I would define the concepts like this:

```text
Experiment
    Discover what mechanism/approach works and why.

Verification
    Check that a specific invariant or behavior is true.

Qualification
    Prove a real end-to-end capability/journey works.

Certification
    Apply a defined evidence threshold before declaring
    a capability/release/support class trustworthy.

Campaign
    A repeatable scenario or journey used by any of the above.

Evidence
    Safe observations produced by tests, campaigns,
    experiments, certification and ordinary Scry runs.
```

So certification is **not protected-transaction-specific**.

We're currently doing:

> Protected Transaction Certification

Eventually you could have:

```text
Locator Certification
Praxis Certification
Session Continuity Certification
Protected Transaction Certification
Adaptive Authoring Certification
Full Journey Certification
```

All using the same assurance infrastructure.

---

## And then there's the cleanup issue you mentioned

I agree with your ordering.

**Do not clean the existing repo now.**

First:

```text
finish current work
→ prove it works
→ establish stable baseline
→ commit/push
```

Then separately:

```text
assurance architecture work
+
legacy verification/testing inventory
```

At that point identify:

```text
keep
migrate
replace
delete
```

There are almost certainly temporary scripts, duplicated test harnesses, obsolete qualification code, old assumptions and one-off infrastructure that made sense during earlier stages of Scry but shouldn't survive indefinitely.

But you don't want to delete them while we're still relying on them to establish the current baseline.

---

## I also would keep the first Assurance iteration very small

This is important because I don't think your idea implies:

> “Stop everything and spend three weeks building an enormous testing framework.”

Quite the opposite.

The first iteration can be very lean:

```text
packages/assurance
```

with perhaps only four real concepts internally:

```text
Scenario
Experiment
Evidence
Verdict
```

And enough orchestration to say:

```text
Run this scenario
under these variants/faults
N times
collect these authoritative facts
compare them against this contract
save the evidence
```

Then protected certification becomes its **first serious consumer**.

We can migrate reusable pieces into it gradually instead of dumping every old test system into the package on day one.

That's how we avoid carrying the existing inconsistencies into the new design.

---

And the most important principle I heard from everything you said is this:

> **The final production architecture should be synthesized from proven experimental evidence, not assembled from the sequence of patches that happened to make individual experiments pass.**

That's probably the strongest design principle for this whole thing.

Sometimes the evidence will justify a foundational refactor.

Sometimes it will justify one new abstraction.

Sometimes it will say the existing architecture is fine and three small fixes are the professional solution.

**Sophistication is not the goal. Evidence-backed cohesion is.**

That, I think, is the system you're describing.
