# Responsibilities

Extensions own integration policy. Raphael core owns the organizational guarantees that apply regardless of which integration created an entity.

## Ownership boundary

| Concern           | Extension responsibility                                           | Core responsibility                                   |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Representation    | Supply kind, useful stored context, and provider metadata          | Maintain core records and universal retrieval         |
| External identity | Bind stable external objects to the intended configuration         | Preserve Raphael identity across renames and moves    |
| Placement         | Declare which managed entities follow which anchor                 | Protect valid parents and hierarchy integrity         |
| Synchronization   | Choose authoritative fields, conflict policy, and external effects | Enforce applicable mutation restrictions              |
| Search            | Return scoped matches for registered entities                      | Resolve scope, route participation, and merge results |
| Lifecycle         | Add or withdraw the extension's independent archive causes         | Maintain causes and descendant cascades               |

Creating a project does not grant ownership of all its fields or the notes beneath it. Extension metadata may be opaque, but declarations core must interpret cannot rely on an undocumented provider-specific convention. See [Entities and relationships](../architecture/entities-and-relationships.md).

## Configuration anchors and mappings

A user-placed resource can configure an integration. For example, a GitHub repository resource can identify the repository to monitor and the area where mapped projects belong. The extension decides which external classifications map to projects or resource kinds.

When managed placement follows that anchor, moving the anchor relocates managed roots while preserving their descendants' immediate parents. Extensions must not flatten the tree or treat locally created descendants as provider-owned content.

The same external repository can have multiple independent anchors. Repeated delivery of an event for one anchor must not create duplicate entities within that mapping; intentional duplication across configurations is different.

Stable external identity permits reconnection without relying on titles. A mapping that no longer matches, a deleted external object, and a temporarily unreachable provider are different conditions. Losing a mapping does not itself justify archiving the local entity and its notes.

## Synchronization and lifecycle policy

An extension can block a controlled change and direct the caller to its canonical source, or allow local updates and synchronize them afterward. It owns external conflict resolution, replay-safe effects, and loop prevention; core provides durable post-commit delivery. Core revisions alone cannot order concurrent changes across systems.

Extensions decide whether external events independently warrant archive or restoration. They request addition or withdrawal of their own cause; core applies the corresponding descendant cascade. They must not clear unrelated causes or restore archived work merely because the external object still exists.

An archive notification is not itself a new independent cause. For example, receiving Raphael's notification and closing a GitHub issue must not accidentally produce a self-sustaining archive loop. Provider event correlation and lifecycle policy remain extension responsibilities. See [ADR 0003](../adrs/0003-archive-and-restore-authority.md).

## Settings and external requests

An extension must distinguish usable configuration from an incomplete or invalid configuration before acting on it. Trusted installation does not exempt webhook handlers from provider-specific signature verification or appropriate request validation.

Credentials must not leak through resource bodies, searchable metadata, errors, or ordinary settings output. The credential storage and settings integration mechanisms remain unspecified.

Failures should identify the affected integration and operation without exposing private content. Background work must have a bounded lifecycle; these responsibilities do not prescribe a scheduler, queue, or transport.

For operation-specific participation and failure boundaries, see [Hooks](./hooks.md).
