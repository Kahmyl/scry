# Scry Assurance: Future Direction

Yes. There are a few things I think are important enough that we should deliberately discuss them before Scry grows much further. Some came out of the recent protected-transaction work, but they are broader than protected transactions.

The biggest one is that **Scry now has two systems, even if only one is formally named**:

```text
Scry Runtime
    does the actual work

Scry Assurance
    proves that the runtime can be trusted
```

We have mostly been thinking about the first one. The last several days have shown that the second one is becoming almost as important.

I think there are six subjects we should get into soon.

1. **What does “supported by Scry” actually mean?**

Right now we talk informally about something “working.” But this certification exercise showed that there are several levels:

```text
implemented
tested
qualified
certified
observed in real applications
```

Those are not the same.

Eventually Scry should be able to say something like:

```text
Native button activation
    CERTIFIED

Custom role-based controls
    CERTIFIED

Protected network acquisition
    CERTIFIED

Visual/OCR protected acquisition
    EXPERIMENTAL

WebSocket protected acquisition
    UNSUPPORTED
```

And the status shouldn't be manually decided. Assurance should derive it from evidence.

That becomes enormously useful for the agent too. Scry can know when it is operating inside a well-proven capability versus an experimental one and behave more conservatively accordingly.

---

2. **We need to decide what the unit of compatibility is.**

This is something I think we haven't explicitly discussed enough.

It's tempting to say:

> “Scry supports 98% of websites.”

But websites aren't really the useful unit.

A website can contain:

- normal buttons;
- custom React controls;
- strange dropdowns;
- shadow DOM;
- iframes;
- long SPA state transitions;
- downloads;
- protected values;
- redirects;
- unusual authentication;
- virtualized lists.

Scry might handle nine of those perfectly and fail one.

So Assurance probably needs to build a **capability × environment corpus**, rather than just a list of websites.

Something more like:

```text
Control type
Framework behavior
Page lifecycle
Navigation behavior
Auth/session style
Acquisition method
Mutation semantics
Journey depth
Failure/recovery class
```

Then real applications provide combinations of those dimensions.

That gives us a much more defensible picture of where Scry is actually robust.

---

3. **Long journeys need to become first-class tests.**

I think this is probably the most important lesson from Vitract.

Our synthetic tests have historically been very local:

```text
open page
→ find control
→ click
→ assert
```

But the real problem appears when Scry has already gone through:

```text
login
→ navigation
→ another navigation
→ mode change
→ application selection
→ credential flow
→ protected transaction
→ docs
→ more protected input
→ API operation
→ continue
```

The individual capabilities may all work independently, while the **composition breaks after 15 steps**.

So Assurance needs a concept like a **journey**, not merely scenarios.

I would eventually want categories such as:

```text
micro scenario
    one capability

flow
    several related operations

journey
    long-lived end-to-end session

stress journey
    long journey + faults + retries + state changes
```

Vitract is effectively teaching us that composition itself is a capability that must be tested.

---

4. **We should separate evidence collection from test execution.**

This connects directly to what you were saying earlier about ordinary Scry runs feeding the system.

Assurance shouldn't only know what happens when Assurance itself runs a campaign.

Every normal Scry execution could safely contribute useful observations:

```text
native resolution succeeded
Praxis fallback required
target ambiguity encountered
number of semantic turns
number of continuation rounds
operation latency
readiness latency
unexpected document epoch
recovery required
browser cleanup escalation
```

Then Assurance becomes partly a testing system and partly an **experience database for Scry**.

That opens a much more interesting future capability:

> “Show me the failure classes we've seen over the last 1,000 real executions that our synthetic corpus does not reproduce.”

That is how the lab stops drifting away from reality.

And it gives us an automatic way of discovering what campaign/fixture needs to be added next.

---

5. **We need to put a boundary on verification time.**

You were right about the verification loop becoming enormous.

The answer isn't “test less.” It's to have **different verification tiers**.

Something like:

```text
Developer gate
    seconds/minutes
    targeted tests for changed subsystem

PR/release gate
    several minutes
    boundaries + relevant Assurance scenarios

Certification
    expensive
    hundreds/thousands of fault executions
    only when capability/runtime semantics change

Soak
    very expensive
    periodic / nightly / before major releases
```

Right now we're sometimes using certification-level thinking for every change, which will eventually make development unbearable.

Assurance should eventually know what changed and answer:

> “This change touched response-envelope behavior, so B/C/N certification families are affected. D/E/H/I/O do not need complete reruns.”

And then perhaps a smaller global invariant smoke afterward.

That is a major future productivity improvement.

---

6. **After the current protected work lands, I think we need a deliberate consolidation phase.**

Not immediately.

First get the current work stable, tested, committed and pushed.

But after that, I would do an inventory of everything Scry accumulated while we were solving these problems:

```text
campaign fixtures
qualification scripts
certification scripts
architecture verification
one-off experimental probes
fault injection helpers
old boundary checks
duplicate browser harnesses
old protected transaction assumptions
temporary migration helpers
```

Then classify every item:

```text
KEEP
MOVE INTO ASSURANCE
REPLACE
DELETE
```

This should be a separate branch of work exactly as you suggested.

And I would strongly resist simply moving everything old into `packages/assurance`. That would create a new package containing all of Scry's historical mess.

We should create Assurance cleanly and migrate only things that still make architectural sense.

---

There is one additional longer-term idea I think is worth keeping in mind.

**Assurance could eventually become Scry's mechanism for making architectural decisions.**

Imagine we are considering a new locator algorithm.

Instead of:

> “This seems cleaner.”

we could run:

```text
current locator
candidate A
candidate B
candidate C
```

against:

```text
500 known scenarios
100 long journeys
historical failure corpus
real-world captured structures
fault variants
```

and get:

```text
success rate
ambiguity rate
fallback frequency
latency
false-positive rate
journey failure rate
```

Then the architecture decision becomes evidence-based.

That's very close to what you were describing earlier with experimentation: **experiments generate evidence; they don't dictate the final implementation.**

The architect—or Codex/agent acting as architect—then looks at the evidence and decides whether the professional production solution is a small fix, a new primitive, or a cohesive refactor.

That is probably where Scry becomes substantially easier to evolve.

So if I reduce all of this to what I think our next major conversations should be after protected certification, I'd focus on:

**Assurance architecture**, **journey testing**, **support/capability classification**, **evidence from ordinary runs**, **verification tiers**, and finally **legacy consolidation**.

Those feel like the pieces that will prevent us from repeating the kind of cycle we've just gone through every time Scry encounters a substantially different real application.
