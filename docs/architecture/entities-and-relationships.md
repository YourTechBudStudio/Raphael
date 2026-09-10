# Entities and relationships

Areas, projects, and resources are distinct entity types. Their product meanings are described in [Organization and context](../product/organization-and-context.md); this document describes their relationships and ownership.

## Core hierarchy

Areas can contain subareas, projects, and resources. Every project belongs to one area. Every resource has exactly one immediate parent, either an area or a project. Core protects valid parentage and prevents area cycles.

An entity's identity is independent of its title and location. Moving or renaming it does not create a different entity. Including descendant resources in an area's view does not change their immediate parents. [ADR 0004](../adrs/0004-canonical-data-and-addressing.md) defines stable parent references, sibling-unique slugs, computed paths, and the virtual root.

## Separate relationships

| Relationship           | Meaning                                                       | Authority                                                                           |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Parent                 | Where an entity currently lives                               | Core structural model                                                               |
| External binding       | Which external object an entity corresponds to                | Extension mapping policy                                                            |
| Integration provenance | Which integration anchor or rule created or manages an entity | Extension policy; core must understand declarations needed for its own coordination |
| Managed placement      | A declared constraint on where an entity belongs              | Extension chooses the rule; core protects structural correctness                    |

Extension-specific bindings and provenance can live in opaque metadata. Any declaration core must act on, such as search participation or an anchor-following placement rule, needs a core-recognized meaning. Its storage representation is not specified here.

Creating an entity does not imply ownership of every field or of its descendants. For example, GitHub may govern a project's title without governing locally captured voice notes inside it.

## Integration anchors

A user-placed repository resource can act as a configuration anchor, not merely a bookmark. Its repository identity and surrounding area can inform the integration's mappings and monitoring responsibilities.

```text
Area A
├── Repository resource — integration anchor
└── Project — managed to follow the anchor's area
    ├── Local voice note
    └── External issue resource
```

Moving the anchor to Area B moves the project when that placement rule applies. Both resources remain inside the project. Managed roots move; the descendant structure is not flattened.

Managed placement can be reconciled when it drifts. Moving a managed project manually does not implicitly cancel its placement rule. The exact rule vocabulary, detachment behavior, and reconciliation mechanism remain undecided; managed constraints must not be presented as unrestricted placement.

## Identity and mapping changes

External bindings use stable identity rather than matching titles. Losing a classification label can invalidate a mapping without invalidating the external URL or archiving the corresponding Raphael entity. Restoring the mapping can reconnect the existing entity and preserve its locally captured context.

The same repository may have separate anchors in different areas, producing intentionally distinct Raphael entities. This does not justify creating duplicates when the same notification is processed repeatedly for one anchor. Extensions must distinguish independent configurations from repeated processing.

## Representation boundary

Resources have a kind and a stored representation that can contain local content, copied external content, a summary, or a reference. Core owns common identity, hierarchy, and lifecycle information; extensions own their custom metadata and mapping policy.

All entity types use canonical TipTap bodies with core-owned Markdown conversion and search extraction; see [ADR 0005](../adrs/0005-canonical-content-and-search.md). [ADR 0007](../adrs/0007-shared-node-storage.md) defines a shared `nodes` table for common fields and hierarchy, with linked tables for specialized entity-type or extension data when needed. Exact metadata schemas and external-reference formats remain unspecified.
