# ADR 0002: Mutation authority

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Raphael stores entities whose fields may be locally authored or governed by an external system. Mandatory two-way synchronization would force every integration to solve external races and conflicts, even when editing the canonical source is the safer policy.

An extension outage must not silently remove the restrictions it registered.

## Decision

Mutations target Raphael's stored records and remain subject to core validation. Extensions can register pre-mutation hooks that reject controlled changes before storage is modified. Rejections should explain the affected operation and identify the canonical source when the caller should edit it instead.

If a required hook cannot be reached or executed because its extension is unavailable, the mutation fails without changing the stored entity. Get and List remain available, and operations not covered by the restriction remain unaffected.

Alternatively, extensions may allow local changes and synchronize them through post-commit reactions. A successful local mutation does not claim that the external system has accepted the same change. Extensions choosing synchronization own provider-specific conflict resolution and loop prevention.

Archive and restore are explicit exceptions: extensions cannot veto them. Their authority is defined in [ADR 0003](./0003-archive-and-restore-authority.md).

## Consequences

- Core must know applicable registrations independently of whether extension code loaded successfully. Failure to load cannot be treated as absence of a restriction.
- Authority can differ by field or operation; controlling a project title does not confer ownership of locally authored descendant notes.
- Pre-mutation approval and post-commit external effects are distinct boundaries. Pre-mutation hooks are not the place to perform external writes whose success could precede a failed local commit.
- Core revision tracking can help detect stale local updates, but does not establish ordering across Raphael and an external system.
- Incoming integration updates need identifiable origin so an extension can apply its own policy without creating synchronization loops. Exact origin and authorization contracts remain unspecified.
- Hook registration formats, concurrency enforcement, notification delivery, and retry guarantees require later design.

See [System boundaries](../architecture/system-boundaries.md) for the distinction between core storage ownership and external field authority.
