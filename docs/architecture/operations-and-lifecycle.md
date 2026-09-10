# Operations and lifecycle

Core owns stored records and structural guarantees. This overview connects the authority decisions; API schemas and operational settings belong in implementation contracts.

| Operation              | Core behavior                                      | Extension participation                               |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Get / List             | Return stored entities                             | None                                                  |
| Search                 | Search scoped registered context and merge matches | Optional scoped search hooks                          |
| Create / Update / Move | Validate and atomically commit changes             | Pre-mutation checks and durable post-commit reactions |
| Archive / Restore      | Add or withdraw archive causes                     | Post-commit reactions only; no veto                   |

## Retrieval

Get remains available for archived entities; List and Search exclude them by default. Search can match external content absent from stored bodies, so results distinguish incomplete coverage from no matches. [ADR 0001](../adrs/0001-retrieval-and-search-authority.md) owns retrieval authority; [ADR 0005](../adrs/0005-canonical-content-and-search.md) owns canonical content and indexing.

## Mutations

Single-target mutations share core validation across clients and extensions. Revision checks protect existing entities; idempotent creation protects retries. Successful storage does not promise completed external effects. [ADR 0002](../adrs/0002-mutation-authority.md) defines these guarantees; [Hooks](../extensions/hooks.md) explains extension participation.

## Recovery

Archive retains entities and relationships. Restoration removes a cause, not every reason an entity might be archived. Archived editing is blocked, with a narrow exception for moving inherited-only archived entities into active parents. [ADR 0003](../adrs/0003-archive-and-restore-authority.md) owns the cause model and lifecycle restrictions.
