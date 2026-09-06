# Operations and lifecycle

Core owns Raphael's records and structural guarantees. Extensions participate only at the declared boundaries below; this is a behavioral model, not an endpoint or SDK specification.

## Operation boundaries

| Operation         | Core behavior                                                  | Extension participation                                               |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Get / List        | Return stored entities within the requested selection or scope | None                                                                  |
| Search            | Search scoped registered context and merge matches             | Optional relevant search hooks                                        |
| Create / Update   | Validate and commit accepted local changes                     | Pre-mutation checks may reject; post-commit reactions may synchronize |
| Archive / Restore | Apply or withdraw archive causes and their cascades            | Post-commit reactions only; no veto                                   |

## Retrieval and search

Get and List never fetch through extensions. An agent can follow an external reference separately when the stored content is insufficient.

Search implicitly includes relevant extensions, but only for entities already registered within the requested scope. A repository anchor does not make every unregistered issue in that repository searchable. Core resolves scope, identifies relevant extension participation, and merges matches for the same Raphael identity.

External search can match content absent from the stored body. Results should preserve that context, including useful excerpts and source attribution. Source failures must be distinguishable from an exhaustive search with no matches.

See [ADR 0001](../adrs/0001-retrieval-and-search-authority.md) for rationale and search coverage choices.

## Mutation authority

Ordinary mutations target Raphael's stored records. An extension can reject controlled changes with guidance to edit the canonical external source, or accept local changes and synchronize them afterward. Accepted local storage does not imply completed external synchronization.

```text
Mutation request
  Core validation and applicable pre-mutation checks
    Rejected or required extension unavailable → error; no mutation
    Accepted → commit Raphael change
      Post-commit reactions → optional external synchronization
```

The flow distinguishes authority boundaries, not a transaction or hook ordering implementation. Core versions can identify local revisions; they do not resolve ordering conflicts with external systems. Extensions choosing two-way synchronization own the external conflict policy.

See [ADR 0002](../adrs/0002-mutation-authority.md) for fail-closed behavior and the lifecycle exception.

## Archive and restoration

Raphael has no delete operation. Archive retains entities and relationships. An entity remains archived while any archive cause applies: direct action, an ancestor's cascade, or an independent extension-owned reason.

Archiving an area or project applies a corresponding cascade to its descendants. Restoration withdraws a particular cause and its cascade, leaving independent reasons intact. Extensions request lifecycle changes according to their policy; core handles descendant correctness.

Archive and restore do not consult extension veto hooks. Extension reactions occur after the core change and cannot undo its success merely by failing. A reaction may request a separate lifecycle change when the extension has an independent reason.

See [ADR 0003](../adrs/0003-archive-and-restore-authority.md) for the overlapping-cause example.

## Open contracts

Exact API paths, payloads, concurrency preconditions, search ranking and pagination, authorization policy, hook delivery and retries, and behavior when moving archived subtrees remain unspecified. The architecture defines ownership without treating these mechanisms as settled. [Extension hooks](../extensions/hooks.md) describe participation and failure behavior from the extension author's perspective.
