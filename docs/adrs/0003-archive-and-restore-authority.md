# ADR 0003: Archive and restore authority

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Raphael needs recoverable removal without destroying context. A single archived flag cannot explain whether a descendant was independently archived or merely followed its ancestor. Restoring an ancestor must not revive unrelated archived work.

Extensions may also identify independent external reasons for archiving while an entity is already archived. Those reasons must coexist rather than overwrite one another.

## Decision

Raphael has no delete operation. It archives entities while retaining their data and relationships. Archiving an area or project also archives its descendants.

Archive causes are additive: direct action, a cascade from an ancestor's archive operation, or an independent extension-owned reason. An entity remains archived while any applicable cause remains.

Restoration removes a particular archive cause and the descendant cascade attributable to it. It does not remove independent causes, including those added after the original cascade. Independently archiving an area or project introduces its own descendant cascade even when that entity is already archived for another reason.

Core owns cascade correctness. Extensions decide when their own reasons apply or cease to apply, then request their addition or withdrawal; they do not manually restore all descendants. This ADR does not prescribe whether reopening a GitHub issue should trigger restoration.

Extensions cannot veto archive or restore. They may register post-commit reactions, but extension unavailability or notification failure does not block or undo the core lifecycle operation.

## Example

| Action                                   | Area           | Project inside area           | Note inside project   |
| ---------------------------------------- | -------------- | ----------------------------- | --------------------- |
| Archive area                             | Direct cause A | Cascade A                     | Cascade A             |
| Extension independently archives project | Direct cause A | Cascade A + extension cause B | Cascade A + cascade B |
| Restore area by removing A               | Active         | Extension cause B             | Cascade B             |
| Extension withdraws B                    | Active         | Active                        | Active                |

A note with an additional independent cause would remain archived after the final step. Withdrawing a cause is not the same as forcing an entity active.

## Consequences

- Cause identity and cascade attribution are part of the core lifecycle model, regardless of how they are stored.
- Ordinary external reconciliation must not revive an archived entity simply because the external object still exists.
- An archive notification alone is not an independent reason to permanently archive the same entity. Extensions must avoid converting reactions into self-sustaining archive loops.
- Archive and restore remain subject to core correctness and authorization even though extensions have no veto.
- Cause storage, lifecycle concurrency, and how moves interact with existing causes remain unspecified.

See [Operations and lifecycle](../architecture/operations-and-lifecycle.md) for how this exception fits the mutation model.
