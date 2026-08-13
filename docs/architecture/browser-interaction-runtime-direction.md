# Browser Interaction Runtime: Future Direction

Yes. I think you’re pointing at a **larger architectural opportunity than any of the individual fixes we’ve been making**.

The future direction I’d investigate is not “replace Playwright” and not simply “build a Chrome extension.” It is to put a **Browser Interaction Fabric** underneath the rest of the system, with Playwright becoming one execution provider rather than the browser architecture itself.

Something roughly like:

```text
                    Semantic Intent
                          │
                          ▼
               ┌─────────────────────┐
               │  Interaction Fabric │
               │                     │
               │ Observation Graph   │
               │ Readiness Engine    │
               │ Target Resolution   │
               │ Interaction Arbiter │
               │ Capability Model    │
               └──────────┬──────────┘
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
        ▼                 ▼                  ▼
 Managed Playwright   Attached Chrome    Extension Companion
        │                 │                  │
   fresh context       existing Chrome      user's tab
 persistent profile      via CDP           + extension/CDP
```

### The important idea: stop treating Playwright's `Page` as the worldview

Playwright is very good at **performing browser actions**. Its locator system already gives automatic retrying and user-facing semantic locators such as roles, labels and placeholders. ([[Playwright](https://playwright.dev/docs/locators?utm_source=chatgpt.com)][1])

But there is a layer underneath it that we could exploit much more aggressively: **Chrome DevTools Protocol**.

Playwright itself exposes `CDPSession`, which lets a Playwright-controlled page talk directly to raw CDP while still keeping Playwright for execution. ([[Playwright](https://playwright.dev/docs/api/class-cdpsession?utm_source=chatgpt.com)][2])

And CDP exposes things that are extremely useful for the kind of system you're building:

```text
DOM
Accessibility
Page lifecycle
Network
Runtime
Target/frame topology
DOMSnapshot
Performance
Storage
Input
```

Chrome describes CDP specifically as its instrumentation/debugging protocol, divided into domains such as DOM and Network. ([[chromedevtools.github.io](https://chromedevtools.github.io/devtools-protocol/?utm_source=chatgpt.com)][3])

So instead of:

```text
intent
  ↓
ask Playwright locator
  ↓
didn't find it
  ↓
try another grounding system
```

you could eventually have:

```text
Browser emits evidence continuously
              ↓
       Semantic Surface Graph
              ↓
 "what controls currently exist?"
 "what changed?"
 "what is still loading?"
 "what belongs to what record?"
 "which frame owns this?"
 "what control became actionable?"
              ↓
     resolver chooses target
              ↓
 Playwright performs deterministic action
```

That would be a major improvement.

---

## In particular, I think an **Observation Graph** could become very powerful

CDP's Accessibility domain can expose the browser's accessibility tree, including role, accessible name, frame association and the corresponding backend DOM node. Chrome can also keep accessibility node IDs consistent while the accessibility domain remains enabled. ([[chromedevtools.github.io](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/?utm_source=chatgpt.com)][4])

The DOM domain can provide backend DOM nodes, attributes, box geometry, frame relationships and traversal information around iframes/shadow roots. ([[chromedevtools.github.io](https://chromedevtools.github.io/devtools-protocol/tot/DOM/?utm_source=chatgpt.com)][5])

So internally, you could construct something like:

```text
SemanticNode
─────────────────────────
documentEpoch
frame
backendNodeId        ← internal only
axNodeId             ← internal only

role
accessibleName
text
label
placeholder

visible
enabled
editable
focusable
pointerActivatable

geometry
container
parent record
nearby labels
semantic boundary

evidence:
  playwright
  accessibility
  dom
  geometry
```

The agent still **never sees or authors these IDs**.

It still says:

```text
"activate the Revoke button for credential X"
```

But internally the browser layer has a much richer representation of what the page actually looks like.

That could make the current Native/Praxis split evolve into something considerably more cohesive.

---

### And readiness becomes much smarter

The issue we just diagnosed is a perfect example.

Today there is effectively:

```text
document surface visible
→ begin searching
→ timeout
```

A richer observation layer could know:

```text
document loaded
+
React/Vue/etc. surface still changing
+
Loading... disappeared
+
AX tree changed
+
new editable control appeared
```

Not by guessing “React is done,” and not with an LLM.

Just by observing browser state transitions.

Then the resolver can distinguish:

```text
TARGET_ABSENT_STABLE

from

TARGET_NOT_PRESENT_YET_PAGE_STILL_EVOLVING
```

Those are completely different states.

And that would help far beyond Vitract.

---

## The Chrome extension idea actually fits very nicely — as a provider

I **wouldn't make the extension mandatory**.

I'd make it another browser provider:

```text
BrowserProvider
    │
    ├── IsolatedBrowserProvider
    │     fresh Playwright context
    │
    ├── PersistentBrowserProvider
    │     managed persistent Chrome profile
    │
    ├── AttachedBrowserProvider
    │     existing Chrome through CDP
    │
    └── CompanionBrowserProvider
          Chrome extension
```

That gives users choices.

### Extension/Companion mode

This one could be extremely good for the interactive mode you've talked about.

Chrome content scripts execute in an isolated world by default, separate from the site's JavaScript environment. ([[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?utm_source=chatgpt.com)][6])

And an extension can use `chrome.debugger` as an alternate transport to CDP. It can access domains including DOM, Accessibility, Network, Page, Runtime, Target, Input and others. ([[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger?utm_source=chatgpt.com)][7])

So imagine:

```text
User opens normal Chrome
       │
       ├── logged into GitHub
       ├── logged into LinkedIn
       ├── warm caches
       ├── cookies/session already there
       │
       ▼
Companion extension attaches to selected tab
       │
       ▼
Interaction Fabric
       │
       ├── observes
       ├── reasons about semantic page state
       └── optionally acts
```

The user could have:

```text
Observe only
Assist
Agent control
Pause agent
Take over
Return control
```

That is much closer to an actual **browser companion** than traditional browser automation.

And the extension can communicate with a desktop/native application through Chrome Native Messaging if you eventually need a local bridge; Chrome explicitly supports extension ↔ native-app messaging. ([[Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging?hl=en&utm_source=chatgpt.com)][8])

There is a tradeoff, though: `chrome.debugger` requires the extension's `debugger` permission, which Chrome surfaces as a powerful permission. ([[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger?utm_source=chatgpt.com)][7]) So I would make that mode explicit and user-controlled rather than silently requiring it.

---

## There is also a middle ground without an extension

You can attach Playwright to an already-running Chromium browser over CDP with `connectOverCDP()`. ([[Playwright](https://playwright.dev/docs/api/class-browsertype?utm_source=chatgpt.com)][9])

That could enable something like:

```text
Scry-managed browser
        OR
user-managed Chrome launched with debugging enabled
        ↓
same Interaction Fabric
```

There is a caveat: Playwright explicitly describes `connectOverCDP()` as **lower fidelity** than its native Playwright protocol connection, so I wouldn't make “attach over CDP” the only execution mechanism. ([[Playwright](https://playwright.dev/docs/api/class-browsertype?utm_source=chatgpt.com)][9])

That's another reason the provider architecture makes sense.

Different modes can advertise capabilities:

```text
                       Observe   Act   Existing Login   Warm Profile   Full PW
Fresh Playwright          ✓       ✓         —               —           ✓
Persistent Playwright     ✓       ✓         ✓               ✓           ✓
Attached Chrome/CDP       ✓       ✓         ✓               ✓         partial
Extension Companion       ✓       ✓         ✓               ✓        different
```

And the rest of the system doesn't need to pretend they're identical.

---

## I think the biggest long-term improvement is actually **sensor fusion**

Rather than asking:

> “Should we use Playwright or CDP or an extension?”

I think the answer is:

> **Use each for what it is best at.**

For example:

```text
Playwright
→ resilient actions
→ role/label/placeholder semantics
→ actionability
→ frames
→ deterministic browser interaction

CDP
→ event stream
→ document epochs
→ DOM topology
→ AX topology
→ network lifecycle
→ frame/worker topology
→ backend-node correlation
→ geometry
→ diagnostics

Extension
→ user-owned browser
→ existing authentication/profile
→ warm session
→ interactive human/agent handoff

Praxis
→ deterministic semantic reconciliation
→ ambiguity handling
→ difficult application semantics
```

That would mean Praxis itself might eventually become **one strategy inside the Interaction Fabric**, rather than a completely separate second browser worldview.

That, to me, is where it starts getting really cohesive.

---

And there's one subtle benefit I think matters a lot: **the browser runtime becomes independently testable**.

You could build a certification suite purely around:

```text
Browser Runtime Contract

observe this page
→ these semantic nodes must appear

delay this node
→ readiness must remain evolving

move this control
→ identity must survive

rerender this row
→ stale identity must die

add duplicate control
→ ambiguity must appear

move into iframe
→ semantic identity remains

replace document
→ epoch changes

human takes control
→ autonomous dispatch freezes

return control
→ observation re-synchronizes
```

Then higher-level workflow logic doesn't have to repeatedly rediscover browser-engine bugs.

So yes, I think there's a **real separate future project here**. I wouldn't call it “build a Chrome extension.” The extension is just one endpoint.

I would frame the future work as:

> **Design a unified Browser Interaction Runtime that provides semantic observation, deterministic interaction and human/agent control across isolated, persistent, attached and extension-backed Chrome sessions.**

That is broad enough to solve the underlying fragmentation rather than merely adding another browser integration.

[1]: https://playwright.dev/docs/locators?utm_source=chatgpt.com "Locators | Playwright"
[2]: https://playwright.dev/docs/api/class-cdpsession?utm_source=chatgpt.com "CDPSession | Playwright"
[3]: https://chromedevtools.github.io/devtools-protocol/?utm_source=chatgpt.com "Chrome DevTools Protocol"
[4]: https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/?utm_source=chatgpt.com "Chrome DevTools Protocol - Accessibility domain"
[5]: https://chromedevtools.github.io/devtools-protocol/tot/DOM/?utm_source=chatgpt.com "Chrome DevTools Protocol - DOM domain"
[6]: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?utm_source=chatgpt.com "Manifest - content scripts  |  Chrome Extensions  |  Chrome for Developers"
[7]: https://developer.chrome.com/docs/extensions/reference/api/debugger?utm_source=chatgpt.com "chrome.debugger  |  API  |  Chrome for Developers"
[8]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging?hl=en&utm_source=chatgpt.com "Native messaging  |  Chrome for Developers"
[9]: https://playwright.dev/docs/api/class-browsertype?utm_source=chatgpt.com "BrowserType | Playwright"

