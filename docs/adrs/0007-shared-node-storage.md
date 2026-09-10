# ADR 0007: Shared node storage with specialized data tables

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Areas, projects, and resources share identity, hierarchy, addressing, lifecycle, and common content, but their specialized data may evolve independently. Fully independent entity tables would complicate parent foreign keys, cross-type sibling slug uniqueness, recursive browsing, and references that can target any entity. Conversely, placing every future type-specific or extension-specific field in one table would couple unrelated schemas and accumulate conditional fields.

## Decision

Use a central `nodes` table for all entity types. It owns immutable identity, entity type, parent references, slug, revision, and common authored fields: title, description, canonical body, tags, and metadata. Shared hierarchy and addressing constraints operate on this common identity space, following [ADR 0004](./0004-canonical-data-and-addressing.md).

Store specialized entity-type or extension-specific data in additional tables linked to `nodes` by stable foreign keys when that data warrants dedicated storage. These tables supplement a node; they do not create a second identity, parent hierarchy, or sibling slug namespace. Add them when concrete fields or relationships require them, rather than creating empty per-type tables in anticipation of future needs. Opaque extension metadata remains an option when a dedicated schema is unnecessary.

Areas, projects, and resources remain distinct domain concepts regardless of their shared storage. Core enforces their parentage rules: only areas can be root children, areas can contain areas/projects/resources, projects can contain resources, and resources cannot contain children. Separate tables are not a substitute for this validation. Use database constraints for referential integrity and sibling uniqueness; the exact additional database enforcement for type-dependent rules remains implementation design.

This storage direction does not grant extensions direct database access or define extension migration ownership, schema registration, or lifecycle APIs. Core mutation and lifecycle authority remain unchanged.

## Consequences

- Hierarchy queries, selectors, and cross-entity references use one canonical node identity and parent relationship.
- Specialized schemas can evolve without adding every field to the common record, at the cost of joins and consistency checks where those tables are used.
- Writes spanning common and specialized data must preserve their invariants atomically; specialized storage must not bypass core validation or revision semantics.
- A shared table is not assumed to be a performance bottleneck merely because it contains all entity types. Indexes and query projections should serve actual access patterns; further physical separation should follow workload evidence rather than entity labels alone.
- This resolves the shared-versus-separate table choice left open by ADR 0004 without freezing exact columns, specialized table cardinalities, or migration SQL.

See [Entities and relationships](../architecture/entities-and-relationships.md) for the domain model, [ADR 0002](./0002-mutation-authority.md) for mutation authority, and [ADR 0005](./0005-canonical-content-and-search.md) for common content ownership.
