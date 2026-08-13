# Managed Persistent Browser: Future Direction

Yes — but I’d make one important distinction:

**The best default is probably not “attach to whatever Chrome the user already has open.”**
The best default may be a **Scry-managed persistent Chrome profile**.

That gives you most of what you want from the middle ground without requiring an extension.

The reason the pure “attach to the user’s normal Chrome” middle ground cannot be universal by default is mostly Chrome security, not Playwright.

A normal Chrome session does **not** expose a CDP debugging endpoint that another process can simply attach to. Chrome must have been started in a debuggable configuration. And since Chrome 136, Google deliberately stopped honoring remote-debugging switches against the default Chrome data directory; remote debugging now requires a **non-default `--user-data-dir`**. Google made that change specifically to stop programs from attaching to users’ real profiles and extracting authenticated browser state. ([[Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port?hl=en&utm_source=chatgpt.com)][1])

So this dream:

```text
User already has Chrome open
        ↓
Scry silently finds it
        ↓
attaches
        ↓
uses existing tabs/cookies/logins
```

is intentionally difficult.

Chrome does not want arbitrary local software doing that.

There are also two other limitations. Playwright's `connectOverCDP()` is Chromium-only, and Playwright explicitly calls it **significantly lower fidelity** than its normal Playwright protocol connection. It even warns that attaching to a browser launched without Playwright's expected arguments can cause some Playwright functionality to be broken. ([[Playwright](https://playwright.dev/docs/api/class-browsertype)][2])

So I would separate **UX middle ground** from **technical CDP attachment**.

### What I think should be the default

Something like:

```text
              FIRST RUN
                 │
                 ▼
      Scry launches normal Chrome
       with dedicated Scry profile
                 │
                 ▼
      user signs into sites normally
                 │
                 ▼
       profile retained on disk
                 │
                 ▼

           ALL LATER RUNS

        Scry launches/reuses
        same persistent profile
                 │
        ┌────────┴────────┐
        │                 │
     Playwright          CDP
     full control     rich sensing
        │                 │
        └────────┬────────┘
                 ▼
        Interaction Runtime
```

Playwright directly supports persistent contexts backed by a `userDataDir`; cookies, local storage and other browser state survive between runs. ([[Playwright](https://playwright.dev/docs/api/class-browsertype)][2])

And notably, Playwright itself now warns **not to automate Chrome's ordinary default profile** and recommends a separate automation profile. ([[Playwright](https://playwright.dev/docs/api/class-browsertype)][2])

That almost exactly describes what I think your default should become.

Call it conceptually:

```text
Scry Browser Profile
```

Not a fake browser. Not an embedded webview.

It's still real Chrome.

The user gets a normal Chrome window and can interact with it whenever needed. But Scry owns a dedicated browser profile that it can safely reopen.

That gives you:

* persistent authentication;
* warm browser caches;
* cookies/local storage;
* site preferences;
* full native Playwright connection;
* CDP instrumentation;
* normal visual Chrome;
* no extension installation;
* no remote-debugging setup by the user;
* no requirement to modify their everyday Chrome profile.

And our Vitract experiment already showed one immediate advantage: the first cold navigation was ~5.5s, while subsequent navigations in the persistent context were around **600ms**. Persistence should not be the correctness fix, but it's a very useful operational property.

### Why not simply use the user's actual Chrome profile?

There are several hard problems.

Chrome won't allow two browser instances to use the same user-data directory simultaneously. ([[Playwright](https://playwright.dev/docs/api/class-browsertype)][2]) So if their normal Chrome is already running, you can't safely spin up another automation Chrome against that same profile.

And if you try to attach to the already-running instance instead, you hit the remote-debugging restriction above.

Meaning you end up asking the user to:

```text
quit Chrome
→ restart Chrome with special flags
→ point it to some debugging profile
→ let Scry attach
```

At that point it is **worse UX than Scry just managing the profile itself**.

---

So I would actually define four modes eventually:

| Mode                   |        User setup | Persistent login | Uses normal daily browser |       Fidelity | Role                  |
| ---------------------- | ----------------: | ---------------: | ------------------------: | -------------: | --------------------- |
| **Managed Persistent** |              None |              Yes |          Separate profile |        Highest | **Default**           |
| Isolated               |              None |               No |                        No |        Highest | Clean/CI/privacy mode |
| Attached CDP           |              Some |              Yes |               Potentially |          Lower | Advanced              |
| Extension Companion    | Install extension |              Yes |                   **Yes** | Different/rich | Opt-in companion      |

The **Managed Persistent** mode is the sweet spot.

It's effectively:

> “Your agent gets its own Chrome profile.”

That is a very understandable product concept.

The user can open it, log into Gmail, GitHub, Jira, LinkedIn, whatever they need, then those sessions stay there. When the agent needs a human action:

```text
Agent: "I need you to complete this CAPTCHA."

Browser comes forward.

User completes it.

User: "Continue."

Agent resumes.
```

You don't need an extension to build that experience.

### Then what is Attached CDP useful for?

Still valuable, just not default.

For example a technical user could deliberately start a debuggable Chrome profile and say:

```text
Use this browser
```

Then Playwright can attach with `connectOverCDP()`. Playwright even recently added a `noDefaults` option specifically useful when attaching to a user's daily-driver browser, to avoid some Playwright overrides interfering with existing browser state. ([[Playwright](https://playwright.dev/docs/api/class-browsertype)][2])

That's a strong signal that this is a real supported use case.

But because of Chrome's security model and Playwright's lower-fidelity warning, I'd classify it as:

> **Bring Your Own Browser / Advanced Attach**

rather than the universal execution substrate.

### And then the extension gets a very specific job

The extension becomes valuable when the requirement changes from:

> “Give the agent a persistent real browser.”

to:

> **“Let the agent operate inside the browser I'm already using right now.”**

That's where the extension wins.

Chrome's extension debugger API can attach to tabs and expose CDP domains such as Accessibility, DOM, Network, Page, Runtime, Input and Target. ([[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger?utm_source=chatgpt.com)][3])

But it requires the powerful `debugger` permission, and Chrome specifically treats that permission as sensitive. ([[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/permissions?hl=en&utm_source=chatgpt.com)][4])

So again, perfect as an explicit user choice:

```text
Enable Companion Mode
```

not something every customer must install before Scry works.

---

I think the overall target should therefore be:

```text
                Scry Browser Runtime
                         │
           ┌─────────────┼─────────────┐
           │             │             │
           ▼             ▼             ▼
       Managed        Isolated      Existing
      Persistent       Session       Browser
        Chrome                        │
           │                          ├─ CDP attach
           │                          │
           │                          └─ Extension
           │
     DEFAULT LOCAL MODE
```

And this is where I slightly change what I said before: **I would aim for the middle ground as the main product experience, yes.**

Just not the literal `connectOverCDP(existingDailyChrome)` implementation of the middle ground.

I'd aim for:

> **Real Chrome + dedicated persistent user profile + full Playwright control + CDP sensing + visible human takeover.**

That can plausibly be zero-setup for a normal user while retaining the technical control you need.

Then attached-browser and extension modes become increasingly integrated levels that users can opt into rather than prerequisites for the product to work.

And importantly, **we don't need to build any of this yet**. After the current correctness work is closed, I'd make this a separate architecture investigation and experimentally compare persistent-profile execution against today's fresh-context runtime before deciding how much of the browser subsystem should change.

[1]: https://developer.chrome.com/blog/remote-debugging-port?hl=en&utm_source=chatgpt.com "Changes to remote debugging switches to improve security  |  Blog  |  Chrome for Developers"
[2]: https://playwright.dev/docs/api/class-browsertype "BrowserType | Playwright"
[3]: https://developer.chrome.com/docs/extensions/reference/api/debugger?utm_source=chatgpt.com "chrome.debugger  |  API  |  Chrome for Developers"
[4]: https://developer.chrome.com/docs/extensions/reference/api/permissions?hl=en&utm_source=chatgpt.com "chrome.permissions  |  API  |  Chrome for Developers"

