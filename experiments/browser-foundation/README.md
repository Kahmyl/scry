# Isolated browser foundation candidate

Not imported by production entrypoints. No production activation or migration.

The parent owns private MCP transport, workspace/environment permission, serial action admission, encrypted credentials, durable SQLite receipts, cancellation, child lifecycle and evidence. One private child per Run embeds upstream Playwright MCP in an externally owned BrowserContext. Xvfb/ffmpeg independently captures continuous native pixels to one fragmented MP4; no DOM reconstruction or screenshot slideshow. A per-Run HTTP(S)/WebSocket proxy enforces explicit origins independently of HTTP methods or request counts. Existing Veil classifier/masks are reused without observation-wide quarantine.

This is an isolated vertical candidate, not a second production platform. SQLite is the local experiment's action-repository implementation; production activation must integrate the proven action contract into Scry's existing authorized API/durable worker and persistent repository. No customer tenancy or deployment switch is included.

Invariants: serialized actions; stable IDs return durable receipts and conflicting reuse is rejected; action/observation/evidence remain independent; no automatic retry of uncertain changes; ordinary tool errors keep a healthy browser; hard cancellation fences/kills only the Run's browser; coverage is complete/partial/unavailable; secrets are referred to by ID; raw evaluation, filesystem, storage/network-dump and WebMCP tools are not exposed. Native recording has independent quotas and survives browser-worker loss. Browser proxy enforcement is not a claim of container-wide isolation.

Public lifecycle: start test, use ordinary browser tools with runId/actionId, log findings, inspect status, finish/cancel. Caller identity is the private stdio launcher configured with one workspace and approved environments. There is no unauthenticated HTTP listener.

Dependency pair is pinned to upstream MCP's exact Playwright dependency and downloaded matching Chromium. The production Playwright/browser dependency remains unchanged.

Qualification includes fifteen controlled journeys, richer controls, frames/tabs/dialogs, retries/concurrency, ordinary errors, cancellation/renderer/parent death, native video prefix/real timing/quotas, scope and secret-safe output, then established-app journeys through public MCP. Synthetic success must never be labelled release readiness.

## Ownership and deliberate simplifications

| Responsibility                                         | Owner in this experiment                                 | What it must not decide                                               |
| ------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------- |
| Control, locators, actionability, browser observations | Official Playwright MCP in a private per-Run worker      | Whether an HTTP method means a business change                        |
| Authorization and action lifecycle                     | Scry coordinator and durable action repository           | Whether a successful click proves a successful business result        |
| Targeted protection                                    | Existing Veil classifier and native black overlays       | Whether a browser action may proceed or an ordinary page may be shown |
| Native evidence                                        | Independent Xvfb/ffmpeg recorder and screenshot receipts | Whether the action succeeded                                          |
| Qualification and diagnosis                            | Test harnesses and retained artifacts                    | Whether this isolated candidate is production-activated               |

Owner approval is at the **environment testing scope**, not a guess about the first POST in a browser action. An authorized environment may receive normal reads, repeated writes, autosaves, GET logout, assets and WebSocket traffic. This intentionally replaces the old per-request business-commit promise for this candidate; it does not silently claim to preserve it. Out-of-scope destinations remain denied, including redirects. The proxy is not a container firewall or a TLS inspection system.

Action receipts distinguish execution, observation, business outcome and evidence. A native timeout is a failed tool with an unknown application outcome; a hard deadline or transport loss after dispatch is unknown. A known pre-dispatch rejection is failed/not-dispatched. A successful action remains successful if its subsequent observation fails. No uncertain action is automatically repeated. An action ID deduplicates dispatch, not arbitrary business effects initiated independently by an application.

Protection is best effort for access secrets and payment/bank details. Ordinary names, email addresses, phone numbers, business content, icons and images are not broadly hidden. Optional mask maintenance has a bounded wait and one outstanding task per page; it cannot suspend interaction indefinitely. Evidence carries a warning when masking cannot be confirmed. There is no encrypted raw-frame quarantine, reconstruction, segmentation, delayed disclosure or perfect-redaction release gate in this candidate.

The recorder captures the actual display continuously at 20 fps and native elapsed time. It does not insert artificial delays between browser actions or promise that arbitrarily fast automation is readable without pause/scrub. A fixed qualified Linux/Chromium profile captures all 1280×720 page pixels and excludes browser chrome. `test/viewport-geometry.mjs` checks the four recorded edges; rerun it for any browser/image/window-layout change. Browser crashes and recorder capacity are reported independently of test success. A complete video can document a failed application test.

## Run the isolated checks

The Dockerfile currently depends on the existing local `scry-ten-current:918b22d` image. It is a reproducible candidate within this lab, not a standalone published distribution. Build from this worktree's repository root:

```sh
docker build -f experiments/browser-foundation/Dockerfile -t scry-browser-foundation:qualified-20261030 .
```

Run `npm test` inside that image for the unit/contract suite. For the integration harnesses, mount a private writable results directory at `/results`. `test/qualify.mjs`, `test/recovery.mjs` and `test/lifecycle.mjs` need the controlled fixture reachable as `diagnosis:8080` and `diagnosis-assets:8080`. The fixture is `node test/fixture.mjs` with a writable `/lab` directory. `test/viewport-geometry.mjs` and `test/mask-liveness.mjs` need no external target. `test/transport-comparison.mjs` starts its own local target.

`test/live-console.mjs` uses only the public MCP contract for application actions. Mount dedicated fictional fixture credentials read-only at `/inputs/private-inputs.json`, results at `/results`, and connect to the dedicated ten-app network. Its JSON-line commands are `start`, ordinary browser tools, `screenshot`, `status`, `finish`, and `quit`. It preserves sanitized transcripts, screenshots, durable receipts and native video. It is an operator-driven experiment harness, not a claim of independent blind-agent acceptance.

Private config files and browser recordings can contain sensitive data despite best-effort masking. Keep artifact directories private; do not commit fixture credentials, local keys, profiles or raw artifacts.

## Known boundaries before platform integration

- Local SQLite/stdio identity is an experimental adapter for the existing platform's repository/authenticated API, not a replacement for production tenancy or distributed ownership.
- Artifact IDs/local files prove capture; Chronicle authorization, object storage, dashboard/player delivery and compatibility with historical evidence still require a separate integration qualification.
- The pinned upstream MCP package uses its exact alpha Playwright dependency. Do not substitute browser revisions casually or imply a production-stability guarantee from these lab passes.
- Accessibility snapshots can omit rich-editor/canvas values. Use native screenshots and observable application read-back; do not infer missing input from an absent accessibility value. Upstream text waits can select an earlier hidden text match; focused discovery and semantic targets remain available.
- Multiple heavy editor tabs need an explicit resource budget. A crash is reported and recovery is usable; memory is not unlimited and no memory-leak absence is claimed.
- Upload/download flows, cross-browser/mobile/desktop support, custom viewport changes, cloud deployment, production network isolation and independent blind-customer acceptance are not qualified by this experiment.

See [QUALIFICATION.md](QUALIFICATION.md) for the evidence, failures and integration recommendation.

## Established foundations

The implementation reuses [Playwright MCP](https://github.com/microsoft/playwright-mcp), Playwright's [actionability](https://playwright.dev/docs/actionability) and [locators](https://playwright.dev/docs/locators), [Apify proxy-chain](https://github.com/apify/proxy-chain), and FFmpeg's [X11 capture](https://ffmpeg.org/ffmpeg-devices.html#x11grab). The measured transport, lifecycle and native-pixel results—not tool popularity—are the basis for recommending this composition for Scry.
