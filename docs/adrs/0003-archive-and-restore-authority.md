# ADR 0003: Archive and restore authority

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Raphael needs recoverable removal without destroying context. A single archived flag cannot explain whether a descendant was independently archived or merely followed its ancestor. Restoring an ancestor must not revive unrelated archived work.

Extensions may also identify independent external reasons for archiving while an entity is already archived. Those reasons must coexist rather than overwrite one another.

## Decision

Raphael archives areas, projects, and resources rather than deleting them, retaining their data, relationships, and reserved sibling slugs.

Core stores explicit user or extension-owned causes on their originating entities. Effective archive status is derived from causes on the entity and its current ancestors; inherited causes are not duplicated onto descendants. Any applicable cause keeps the entity archived.

Ordinary restore removes the target's direct user cause, not inherited or extension-owned causes. Repeated user archive requests do not accumulate duplicate direct causes. Extensions add or withdraw their own independent causes. Removing an ancestor's cause restores descendants only where no other cause remains.

Core owns cascade correctness. Extensions decide when their own reasons apply or cease to apply, then request their addition or withdrawal; they do not manually restore all descendants. This ADR does not prescribe whether reopening a GitHub issue should trigger restoration.

Extensions cannot veto archive or restore. They may register post-commit reactions, but extension unavailability or notification failure does not block or undo the core lifecycle operation.

Updates to effectively archived entities are blocked. Moves are blocked when the target has any direct cause, but an entity archived only through ancestors may move to an active parent, optionally changing its slug in the same operation. Its subtree moves intact; independent descendant causes remain. Creating children in or moving entities into archived containers is forbidden. Archive and restore remain available under core lifecycle rules.

## Example

| Action                                   | Area           | Project inside area           | Note inside project   |
| ---------------------------------------- | -------------- | ----------------------------- | --------------------- |
| Archive area                             | Direct cause A | Cascade A                     | Cascade A             |
| Extension independently archives project | Direct cause A | Cascade A + extension cause B | Cascade A + cascade B |
| Restore area by removing A               | Active         | Extension cause B             | Cascade B             |
| Extension withdraws B                    | Active         | Active                        | Active                |

A note with an additional independent cause would remain archived after the final step. Withdrawing a cause is not the same as forcing an entity active.

## Consequences

- Cause identity and ownership explain archive status without maintaining descendant cause copies.
- Ordinary external reconciliation must not revive an archived entity simply because the external object still exists.
- An archive notification alone is not an independent reason to permanently archive the same entity. Extensions must avoid converting reactions into self-sustaining archive loops.
- Archive and restore remain subject to core correctness and authorization even though extensions have no veto.
- Moving out of archived ancestry removes inherited archiving without restoring the former parent. Revision checks and current-state validation follow [ADR 0002](./0002-mutation-authority.md).

See [Operations and lifecycle](../architecture/operations-and-lifecycle.md) for how this exception fits the mutation model.
