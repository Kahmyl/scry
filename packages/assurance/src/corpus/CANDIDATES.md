# Corpus Candidates

These are candidate phenomena discovered in pre-reset qualification work.

They are NOT members of the permanent Assurance corpus.

Promotion requires satisfying `POLICY.md` and `../../ADMISSION.md`.

## Praxis / browser candidates

### Reference identity

- target replaced before interaction
- target detached before interaction
- document changed after reference creation
- frame detached after observation
- frame navigated after observation
- page/popup identity changes

### Browser topology

- nested frame observation
- delayed frame appearance
- cross-origin frame observation
- popup creation and page identity
- multiple frames containing plausible targets

### Interaction mechanics

- exactly one dispatch
- no dispatch against stale target
- no dispatch against wrong replacement
- operation cancellation before dispatch
- dispatch occurred but requested effect not observed

### Perception

- hidden target
- occluded target
- canvas target
- visual/icon target
- internationalized text/input
- multiple plausible candidates

Ambiguity cases must test accurate observation/candidate exposure rather than
internal semantic adjudication.

## Veil candidates

### Disclosure

- seeded secret absent from DOM evidence
- seeded secret absent from screenshot bytes
- seeded secret absent from decoded video
- seeded secret absent from trace archive
- seeded secret absent from network evidence
- seeded secret absent from report/metadata
- protected clipboard disclosure refused
- protected download disclosure refused

### Visual protection

- protected cross-origin frame is not observable through capture
- protected closed-shadow content is not observable through capture
- protected canvas content is not observable through capture
- protected WebGL content is not observable through capture
- unknown video protection fails safely

### Loss of protection

- capture mask removed before capture
- protected browser context disappears
- browser disappears during protected operation

### Recovery

- protected operation crash does not replay mutation
- crash recovery does not leak protected value
- recovery does not duplicate mutation
- protected execution state is destroyed before ordinary evidence resumes

## Promotion requirement

Before a candidate is promoted:

- implement controlled ground truth;
- define explicit claim;
- define independent oracle;
- identify required evidence;
- demonstrate the correct condition passes;
- demonstrate a deliberately broken condition fails;
- eliminate duplicate candidates representing the same phenomenon.

---

## Candidate readiness

### Target replaced before interaction

Status:

FIXTURE READY — NOT CORPUS ADMITTED.

Current evidence:

- controlled local page exists;
- replacement is independently recorded by the fixture server;
- original dispatch count is independently recorded;
- replacement dispatch count is independently recorded;
- verifier refuses to pass unless replacement occurred;
- verifier passes when replacement occurred with zero dispatch;
- negative control proves replacement dispatch is detected;
- negative control proves stale-original dispatch is detected.

Still required before corpus promotion:

- exercise the fixture through the rebuilt Praxis reference/interaction path;
- demonstrate the intended mechanical behavior through that real integration;
- deliberately substitute a broken Praxis behavior and confirm the same
  Assurance verifier fails.
