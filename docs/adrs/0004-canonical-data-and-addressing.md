# ADR 0004: Canonical data and addressing

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Human-readable addresses must coexist with stable references. Persisting ancestry paths would duplicate hierarchy state and require descendant rewrites after moves or renames.

## Decision

Immutable entity IDs, stable parent references, and mutable slugs define the hierarchy. Slugs share one unique namespace across all sibling entity types, including archived entities. Core rejects collisions rather than silently choosing another slug; title changes do not implicitly change slugs.

Accept paths and IDs as selectors for the same core operations. Full paths are computed only on explicit request, never persisted or automatically included in ordinary responses. Recursive hierarchy queries supply descendant scope. `/` is a virtual root containing only top-level areas, not a stored or mutable entity.

## Consequences

- Moves and slug changes preserve identity and descendant parent references, but change addresses; callers needing durable references use IDs.
- [ADR 0007](./0007-shared-node-storage.md) resolves the storage layout: a shared node table with linked specialized data tables when needed.
- These identity and hierarchy guarantees are independent of the selected database and ORM; see [Runtime and access](../architecture/runtime-and-access.md) for the initial backend.

See [Entities and relationships](../architecture/entities-and-relationships.md) for parentage and [ADR 0003](./0003-archive-and-restore-authority.md) for archived movement restrictions.
