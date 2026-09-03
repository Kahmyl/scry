# Assurance engineering lab

This surface runs downstream source-level qualification experiments. It is not
the black-box MCP consumer in `apps/agent-lab`, and production runtime must not
depend on it.

The lab captures a pinned Git revision plus an explicit, bounded representation
of relevant dirty state. It then creates a detached worktree, assigns unique
local database, queue, browser, fixture, artifact, Compose, and port identities,
and runs a pinned reproduction command before considering candidate patches.

Engineering-agent adapters may propose patches. They do not choose the
verification oracle, apply patches to the source worktree, push, merge, deploy,
or authorize production changes. Candidate verification is run by the lab in
the isolated worktree with a scrubbed environment. The initial approved adapter
is deterministic and performs no network or provider operation.

The output is an immutable manifest and artifact set plus an append-only,
hash-linked JSONL ledger. Failed attempts remain evidence. Teardown and source
fingerprint comparison are part of the report, and every candidate remains a
human-reviewed artifact only.
