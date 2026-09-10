# ADR 0001: Retrieval and search authority

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Raphael must provide a consistent way to find registered work and its surrounding context. External content may be copied into Raphael, represented only by a reference, or searchable through an integration. Requiring users to choose provider-specific search operations would fragment that experience.

Universal retrieval must also remain dependable when extensions are absent or unavailable. Finding external content and fetching it are different responsibilities.

## Decision

Core exclusively owns Get and List. They return stored Raphael entities and never invoke extensions to enrich or retrieve them. Callers can use stored references to fetch external content separately.

List and Search exclude effectively archived entities by default, including those archived through ancestors. Get remains available and reports computed archive status and its causes.

Search is always scoped, for example to an area or project with the requested descendant inclusion. Core owns full-text indexing of titles, descriptions, and text derived from stored bodies, and implicitly invokes optional search hooks for relevant extensions present within that scope.

Extension matches must correspond to existing Raphael entities in scope. Search does not discover unregistered external objects. Core merges matches using Raphael identity, not merely a shared external URL.

An extension may copy searchable content into core records instead of implementing a search hook. It may also store references without either copying full content or providing external search; in that case only the stored representation is searchable.

## Consequences

- Get and List remain independent of external availability, but their bodies may not contain the content that caused an external search match.
- Search results need sufficient match context and source attribution to explain that distinction.
- Search failures from participating sources must be reported as incomplete coverage, independently of pagination or whether any matches were found.
- Core needs a recognizable declaration of extension presence and scoped entity association; entirely opaque metadata cannot support routing by itself.
- A repository anchor does not imply that every issue in its repository is registered or searchable.
- Query syntax, ranking, pagination mechanics, and payloads belong in API contracts rather than this authority decision.

See [Operations and lifecycle](../architecture/operations-and-lifecycle.md) for the surrounding API model.
