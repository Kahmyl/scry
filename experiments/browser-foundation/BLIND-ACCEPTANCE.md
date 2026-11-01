# Fresh blind customer acceptance — 31 October 2026

The subsequent [causal investigation and isolated comparisons](./CAUSE-INVESTIGATION.md)
diagnose these findings and recommend a bounded repair. They do not alter the
blind receipts below or lift the activation hold.

## Decision

All ten independent customer journeys finished, signed out and published final
reports. All ten passed the mechanical evidence audit, including full video decode.
**This is not a clean activation pass. Do not activate the candidate on the strength
of recovered business outcomes alone.** Nextcloud exposed an input-compatibility defect: the
default rich-text replacement completed as an interaction but erased the document;
saving produced a zero-byte file. The independent agent detected this and restored
the intended content using the public sequential-typing option. This is a recovered
journey, not a clean text-entry pass. Production code has not been changed in this
verification pass.

The final local audit recorded 671 public tool calls, 557 unique browser commands,
77 distinct gallery screenshots and 62.7325 minutes of native footage. Thirteen
unique commands returned explicit upstream tool errors (stale references, invalid
target, intercepted clicks or navigation waits); agents recovered by inspecting
current state. No durable command lifecycle/owner failure was observed. This does
not turn upstream errors into successes: business readback established the final
outcomes. The zero-byte editor failure did **not** return a tool error and remains
the significant compatibility finding.

## What was actually tested

Ten fresh agents were started without inherited conversation, implementation,
research, source, earlier journey transcripts or other agents' artifacts. Each
received an ordinary business objective, allowed origin, fictional username and
explicitly selected opaque credential reference. Each independently discovered
Scry's public instructions/tool schemas, planned its Mission/Objective/Flow, started
its Run, navigated and acted, checked persisted application state through the UI,
reviewed native screenshots, signed out and published its report. No parent supplied
selectors, app routes, action sequences or recovery instructions. Parent messages
were restricted to resource-slot release and factual progress requests.

The transport was a transparent CLI bridge to the actual HTTP MCP endpoint, not a
mock or browser automation helper. It adds no application logic or hidden assertions;
it saves returned image bytes locally for visual inspection. A customer MCP host
would normally deliver these tools and images directly. The bridge's duplicated
text/structured JSON occasionally exceeded shell display/parsing limits. Agents
recovered existing receipts without repeating dispatched actions. This transport
limitation is not evidence of a failed MCP protocol exchange.

The complete path was public HTTP MCP → existing authenticated API → durable
PostgreSQL commands/Redis queue → actual worker → official Playwright adapter →
live dedicated application → native recorder → Chronicle receipts → authenticated
media/report API → existing dashboard. Business outcomes were checked through the
browser, not app APIs, SQL, fixture scripting or source knowledge.

All targets were preserved, seeded isolated instances of established products,
not their public hosted services. Their data is fictional. New artifacts were
uniquely prefixed `Blind 1031`; pre-existing records were read-only. No purchases,
invoices, real emails, invitations, auth changes or production operations were
authorized. This does not claim every feature or endpoint in each product was tested.

## Candidate and operating bounds

- Branch: `codex/browser-foundation-integration`; production source at `3b71ddc`.
- Immutable application image: `scry-browser-integration:local`,
  `sha256:fef120cf566252d02048281d8e6db6aeb173cefb45b910dd6d56d551cadf19f4`.
- Project: `80df7bcd-5b77-4324-9737-249860c30082`,
  `Fresh blind acceptance 20261031 df65a650`.
- Only the isolated stack selects the candidate. No activation, production source
  edits, image rebuild, push, merge or deployment occurred during these journeys.
- Chromium, native 1280 × 720 / 20 fps recording at original timing; default 1× player.
- Worker memory cap 3 GiB; at most two browser journeys together, heavy Penpot/GitLab
  alone. Fixtures were stopped only after their Runs closed; persistent data retained.
  Observed worker memory during two-browser batches was approximately 1.7–2.1 GiB,
  and approximately 226 MiB after the first pair closed. This is not a leak, soak,
  unbounded-concurrency or production-capacity proof.
- Passwords were supplied through protected references, not agent-visible literal
  secrets. Disposable MCP credentials are revoked after completion. Tokens/private
  inputs are not committed. Masking is optional best effort, not a promise of complete
  privacy coverage or a gate on browser interaction.

## Journey ledger

| App         | Actual saved/reopened outcome                                                                                                                                                     | Important qualification result                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grafana     | New folder and text-panel dashboard; saved rename; existing populated dashboard; discarded unsaved title change; logout                                                           | Completed. Monaco initially retained starter content; agent inspected and explicitly selected/replaced it.                                                               |
| Metabase    | New collection and saved GUI question; Gadget filter, 53 rows; persisted rename; canceled Widget change; existing tables; logout                                                  | Completed. Some EAN/product identifiers were overmasked as payment-card-like text.                                                                                       |
| Odoo        | New customer and draft S00001, quantity 3, total 431.25; saved note; reopened; discarded quantity 9; logout                                                                       | Completed. Typing while a note was inactive returned completed without changing it; agent caught and corrected before claiming success.                                  |
| Nextcloud   | New folder/text file; edited/renamed/moved file; canceled move; positive/negative search; reopened exact final content; logout                                                    | Recovered, not clean. Default replacement erased content and a save produced 0 KB; sequential typing restored and persisted it.                                          |
| Mattermost  | New channel; edited parent post and thread reply; reopened; search; abandoned unsent draft and verified no result; logout                                                         | Completed. No failed browser actions.                                                                                                                                    |
| Discourse   | New formatted topic and reply; edited title/body; search/reopen; canceled later replacement and reloaded persisted values; logout                                                 | Completed. Broken avatar images visible; cause unresolved. Stale reference and CLI display truncation recovered independently.                                           |
| OpenProject | New task #129; saved description, In progress status, Low priority and comment; filter/reopen; abandoned subject change; logout                                                   | Completed. Two navigation waits timed out after click dispatch; agent observed resulting state without replaying clicks.                                                 |
| ERPNext     | New linked customer/contact and draft SAL-QTN-2026-00001, quantity 3, total USD318; note persisted; abandoned unsaved note using Reload; logout                                   | Completed. App's permanent whole-quotation Discard was correctly canceled; it was not used to abandon field edits.                                                       |
| Penpot      | New design; board 500×410, rectangle 320×180 at (50,70), #2F80ED, edited Source Sans Pro 18 label; layer selection; width change/undo; preview; close/reopen; logout              | Completed. Actual canvas and inspector matched saved values. Explicit tab selection and drag-to-create recovered ordinary editor interactions.                           |
| GitLab      | New Customer Platform issue #34; revised title/description, unique label and comment; one search result; reopened saved values; canceled later changes; read-only profile; logout | Completed. Two post-click navigation waits expired; toast intercepted another click before dispatch. Broken avatars and stale sidebar count observed; causes unresolved. |

### Mission, Run and report references

| App         | Mission                              | Run                                  | Published report                     |
| ----------- | ------------------------------------ | ------------------------------------ | ------------------------------------ |
| Grafana     | 4c2f1b93-5fb3-4b0a-8bdb-9561d55c4893 | a47ad123-6437-4e1f-b10b-4b77ef3c91aa | 9cbf4a2e-a2fe-4e71-8ea6-097d69398baf |
| Metabase    | 57945cc1-648d-4406-b7bd-8260e9df1eb3 | 686406e8-5684-4865-82c5-b5f6ac332706 | 0b7a08d0-fec5-4705-a9dd-c1909782c900 |
| Odoo        | 3ff85dde-af18-435e-8a27-213e31c92f3b | dfdb6d0f-b491-4d8a-8dea-24e024efb09f | e7901209-9246-42d6-a5e1-93e5ccf0a81a |
| Nextcloud   | f859d4f7-50b7-4b8d-8e52-2a95feb28c89 | ab052fd4-6492-45c8-b5f0-4570e227dec6 | cafed639-98b8-4427-a3c9-2e1b345cbfe5 |
| Mattermost  | 7a8a22ce-bad7-410e-9c38-22ee199da431 | d5912af3-cdc3-4884-bec5-f7b104e995cc | 5e6b4548-52a4-447d-99f7-2e78bb88bcbf |
| Discourse   | 3b6c9ebc-b2b3-4125-a790-e4a3476950e2 | 37497217-6cb3-4f65-897e-5430a090de77 | ade98175-0c7e-4122-ab18-2a492f79369f |
| OpenProject | 6228e068-50e5-452c-a5c8-43fde4a5b987 | d9ef693a-0b4a-4fea-b791-52f62c90e19a | 802761be-2803-406b-810d-9288809de03c |
| ERPNext     | 3d361a31-c3f2-4295-bb4e-d58379619b69 | c3cf8f92-b55f-4d32-8d27-4a3fbac2c863 | 23f9793f-36fc-4ac9-ae89-209f3d240f9b |
| Penpot      | 15d033ed-6e2e-4757-b5ee-465bf8967bc7 | e119d6ef-9e14-4ea9-9f8d-0016af1c36a0 | 9a2e022d-ce0c-4eec-8a1f-b0a4bb3179c6 |
| GitLab      | 13af7124-1c18-4f2b-866b-4b5fa8f9c331 | f33a6168-df8b-447c-8ba9-e966065561ed | bc397c46-7af3-431c-b1d1-d454d0cde82a |

## Evidence audit and dashboard review

The parent independently retrieves Run state, media publication, exact admitted
bytes and public reports. Every native video was checked against its receipt's
SHA-256 digest, probed for H.264, 1280 × 720, 20 fps and positive duration, and fully
decoded with ffmpeg (`-xerror`) without errors. Media MIME checks also passed.
Screenshot digests are checked and exact duplicates counted. Exact fixture
passwords are searched in returned tool text; absence is not proof that every
video frame or conceivable secret was masked. No pixel-level completeness claim
is made. Distinct business screenshots were visually inspected by agents; parent
spot checks include saved designs, edited dashboards, quotations and final notes.

The actual dashboard was signed into via its ordinary email/password flow and
the fresh Project selected. Final overview showed ten Missions, zero active Runs
and ten final reports. Mission status, report counts and evidence controls
were inspected. ERPNext's 465.45-second native recording loaded as 1280 × 720,
readyState 4, no player error and playbackRate 1; playback advanced and seeking to
the persisted record worked. Selecting a screenshot displayed the original UI.

An initial review failure was isolated to the test fixture's 8 MiB buffered
response limit: the 24,372,317-byte ERPNext recording returned HTTP502 through
port45491, despite authenticated direct API delivery and digest validation.
The test-only localhost streaming bridge on45492 reuses the running fixture
issuer and unmodified web/API, avoiding a fixture restart during blind tests.
It delivered HTTP200 and the original digest; unauthenticated media remained
HTTP401. No production media or authentication code changed. This is lab
transport accommodation, not a product fix or customer rollout proof.

Local evidence root (not committed):
`/Users/habib/Documents/monorepo/scry/artifacts/assurance/browser-blind-20261031`.
Each app has calls/results logs, returned screenshots, authenticated audited
media and `audit.json`. Dashboard proof images are `dashboard-video-review.png`
and `dashboard-screenshot-review.png`; `dashboard-final-overview.png` records
the ten completed Missions/reports. These remain local test evidence and must
not be published indiscriminately: redaction is best effort.

The aggregate audit completed at 09:03 UTC / 10:03 Africa/Lagos. All ten evidence
streams were complete/admitted, all reports final, all media hashes correct, no
exact duplicate gallery images and no known fixture password in returned tool text.
`summary.json` records the counts; the aggregate `audit-grafana-nextcloud-odoo-metabase-openproject-discourse-mattermost-erpnext-penpot-gitlab.json`
retains the detailed audit. All ten disposable test tokens were revoked and checked
against both API access (HTTP401) and an actual public MCP tool call (denied).
MCP initialization can still return public protocol metadata; it does not authorize
application access. `token-revocations.json` records only safe revocation metadata.

## Findings and next gate

1. **Nextcloud rich-editor replacement: activation hold.** Command
   `297ab35c-b735-491f-87aa-b7cdb54f5016` returned completed but blanked the editor;
   save `89187e70-ef0e-49a7-8013-4adba493d472` produced a zero-byte file. Public
   sequential typing `510a2532-e962-47bc-9351-5d9cd0851ef2` restored it, then saved,
   reopened and moved content remained correct. Preserve these receipts as the
   failing characterization. Static inspection shows default upstream typing
   calls `locator.fill`; `slowly:true` calls `pressSequentially` and also changes
   completion waiting. Input-event semantics and completion timing are competing
   causes; this run does not isolate them. Recommend focused text-entry
   investigation, the smallest proven correction, then a fresh Nextcloud rerun
   and sibling editor checks. It does not justify another runtime rewrite.
2. **Action completion is not business success.** Grafana/Odoo/Nextcloud required
   inspection after typing. Durable completed state describes command lifecycle;
   upstream tool failures remain `execution: tool_error`, and business effects
   remain unverified until actual UI readback. Do not count receipts alone as
   assertion passes. Agents did not falsely accept these outcomes.
3. **Navigation timeout ambiguity.** OpenProject commands
   `ae947cdc-5e51-415c-b383-3cad9cf2cc5e` and
   `f7dc15a1-12bd-4f05-94be-b1244bb88038` logged completed clicks followed by a
   4000ms navigation wait expiry. Agents inspected state rather than replaying.
   GitLab's sign-in/project-navigation waits behaved similarly. Characterize
   wait/result ergonomics separately; do not infer unexecuted clicks.
4. **Non-blocking presentation/privacy limits.** Metabase identifier false positives,
   generic gallery labels (`page` plus timestamp), visible Discourse/GitLab broken
   avatars and GitLab's stale sidebar count warrant follow-up. Avatar cause remains
   unproven; no claim that Scry's
   masking caused it. Best-effort masking warnings are honest, not pending-release
   promises. Full privacy, visual consistency and UX redesign are not proven here.

The qualification intentionally preserves failures and reports. Business recovery
does not erase defects or authorize activation. No historical evidence is rewritten.

These are fresh compatibility/customer-use tests, not a repeat of the migration,
cross-workspace authorization, worker interruption, unknown-action/no-replay and
legacy-regression checks recorded in [INTEGRATION.md](./INTEGRATION.md). Uploads,
downloads, every tool variation, Safari, mobile/desktop targets and production
deployment were not included in these ten business assignments. Those earlier
integration results and these new findings must be considered together.
