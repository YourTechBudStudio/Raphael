# Responsibilities

Extensions own integration policy; core owns organizational guarantees. [System boundaries](../architecture/system-boundaries.md) assigns ownership, and [Hooks](./hooks.md) defines participation.

## External mappings and placement

Use stable external identity, not titles, to bind objects to Raphael entities. Distinguish repeated delivery for one configuration from intentional registration through separate configurations. Losing a label or mapping need not archive an entity or discard locally captured context.

Extensions decide which external classifications create projects or resource kinds and which entities follow configuration anchors. Express managed placement through core operations; never flatten descendants or treat locally authored notes as provider-owned. [Entities and relationships](../architecture/entities-and-relationships.md) defines anchors and separate relationships.

## Synchronization and lifecycle policy

Choose which fields are externally authoritative and whether local edits are rejected or synchronized. Own provider-side conflict resolution, replay-safe effects, and loop prevention; core revisions do not order changes across external systems.

Decide when external events justify adding or withdrawing an independent archive cause. Provider event correlation must distinguish such reasons from reactions to Raphael's own notifications. A remote object continuing to exist is not permission to revive archived work.

## Configuration and external requests

Distinguish usable configuration from incomplete settings. Validate external requests and provider signatures even though extension code itself is trusted.

Keep credentials and private content out of ordinary settings, searchable metadata, and diagnostics. Integration-specific credential storage remains open; shared AI authentication belongs to core under [ADR 0006](../adrs/0006-ai-capability-ownership.md). Failures should identify the affected integration and operation without leaking secrets.
