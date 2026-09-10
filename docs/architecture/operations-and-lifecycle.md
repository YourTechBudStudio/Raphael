# Operations and lifecycle

Core owns Raphael's records and structural guarantees. Extensions participate only at the declared boundaries below; this is a behavioral model, not an endpoint or SDK specification.

## Operation boundaries

| Operation              | Core behavior                                                  | Extension participation                                                       |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Get / List             | Return stored entities within the requested selection or scope | None                                                                          |
| Search                 | Search scoped registered context and merge matches             | Optional relevant search hooks                                                |
| Create / Update / Move | Validate and commit accepted local changes                     | Pre-mutation checks may reject; durable post-commit reactions may synchronize |
| Archive / Restore      | Apply or withdraw archive causes and their cascades            | Post-commit reactions only; no veto                                           |

## Retrieval and search

Get and List never fetch through extensions. List and Search exclude effectively archived entities by default; Get remains available and reports computed archive status and causes. An agent can follow an external reference separately when stored content is insufficient.

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

Update, move, archive, and restore require the target revision and atomic validation of current constraints. Creation supports idempotent retries. Core commits applicable durable post-commit work alongside mutations; delivery can repeat and does not imply exactly-once external effects. Extensions choosing two-way synchronization own the external conflict policy.

See [ADR 0002](../adrs/0002-mutation-authority.md) for fail-closed behavior and the lifecycle exception.

## Archive and restoration

Archive retains entities and relationships. Core stores explicit causes and derives inherited archiving through current ancestry. Ordinary restore removes the target's direct user cause; extensions withdraw their own causes. Independent reasons remain intact.

Archived entities cannot be updated. An inherited-only archived entity may move to an active parent, optionally changing its slug; any direct cause blocks that move. Creates and moves require active destination containers.

Archive and restore do not consult extension veto hooks. Extension reactions occur after the core change and cannot undo its success merely by failing. A reaction may request a separate lifecycle change when the extension has an independent reason.

See [ADR 0003](../adrs/0003-archive-and-restore-authority.md) for the overlapping-cause example.

## Contract boundary

API schemas, query syntax, and operational settings belong in implementation contracts, not this overview. [Extension hooks](../extensions/hooks.md) describe participation and failure behavior from the extension author's perspective.
