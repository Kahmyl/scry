# Scry R0 Re-architecture — Start Here

This directory is the durable operating context for the active Scry re-architecture.

Read in this order:

1. `R0-ARCHITECTURE.md` — target architecture and non-negotiable invariants.
2. `R0-STATE.md` — current checkpoint, completed work, evidence, and active slice.
3. `R0-ROADMAP.md` — remaining phases and closure conditions.
4. `R0-SOL-RUNBOOK.md` — execution protocol for a long-running GPT-5.6 Sol session.

The repository, tests, and current git state remain authoritative when any prose is stale.

## Governing sentence

> Scry does not compete with the intelligence of its agent. It provides the agent with a trustworthy browser substrate, durable work model, explicit trust boundaries, authoritative evidence, and a system for learning from failures.

## Authority split

> External intelligent agent owns reasoning authority. Scry owns execution authority.

Scry may enforce mechanical facts and trust boundaries. It must not silently convert heuristic confidence or semantic similarity into authority.
