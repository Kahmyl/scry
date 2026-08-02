---
name: refactor-safely
description: Improve the internal structure, clarity, modularity, ownership, or maintainability of existing software while preserving observable behavior. Use for extraction, decomposition, renaming, dependency inversion, deduplication, boundary cleanup, and behavior-preserving architectural restructuring. Establish characterization coverage, keep transformations reviewable and green, distinguish refactoring from feature changes or rewrites, and invoke architectural-diagnosis when the current abstraction cannot preserve required invariants.
---

# Refactor Safely

Treat observable behavior as fixed unless the user separately authorizes a feature or compatibility change.

## Workflow

1. Define the behavior and public interfaces that must remain unchanged.
2. Establish green tests or characterization evidence before restructuring.
3. Map callers, data ownership, side effects, reflection, configuration, and published interfaces.
4. Identify the target structure and the design pressure it resolves.
5. Use `architectural-diagnosis` if the request actually requires replacing an unsound model or changing system invariants.
6. Apply small coherent transformations and return to green after each meaningful stage.
7. Avoid mixing behavior additions with structural movement; use `implement-feature` for changed behavior.
8. Use `verify-change` for equivalence, compatibility, performance, and operational checks proportional to risk.

## Completion

Report the preserved behavior, structural improvement, compatibility checks, and any intentional non-refactoring changes separated from the refactor.
