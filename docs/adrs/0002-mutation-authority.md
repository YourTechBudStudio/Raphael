# ADR 0002: Mutation authority

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Raphael stores entities whose fields may be locally authored or governed by an external system. Mandatory two-way synchronization would force every integration to solve external races and conflicts, even when editing the canonical source is the safer policy.

An extension outage must not silently remove the restrictions it registered. Concurrent edits must not silently overwrite newer state, and committed changes must not lose their reactions.

## Decision

Mutations target Raphael's stored records and remain subject to core validation. Extensions can register pre-mutation hooks that reject controlled changes before storage is modified. Rejections should explain the affected operation and identify the canonical source when the caller should edit it instead.

If a required hook cannot be reached or executed because its extension is unavailable, the mutation fails without changing the stored entity. Get and List remain available, and operations not covered by the restriction remain unaffected.

Alternatively, extensions may allow local changes and synchronize them through post-commit reactions. A successful local mutation does not claim that the external system has accepted the same change. Extensions choosing synchronization own provider-specific conflict resolution and loop prevention.

Update, move, archive, and restore require the target's current revision. Core validates that revision and current lifecycle, hierarchy, and uniqueness constraints atomically with the mutation. Conflicts reject the entire operation; callers reconcile rather than blindly retry, for example by overwriting against the current revision after review. Descendant effects are core-owned and do not require caller-supplied descendant revisions.

Callers supply the title and slug on creation. A retry after a lost response resubmits the same slug, so a committed first attempt surfaces as a sibling slug collision ([ADR 0004](./0004-canonical-data-and-addressing.md)) that the client can recognize as its own.

Post-commit hooks are durable and retryable, with possible repeated execution. Core supplies stable invocation identity; extensions must tolerate replay. Exhausted retries remain diagnosable and do not undo the commit. This durability guarantee does not apply to pre-mutation or search hooks.

Archive and restore are explicit exceptions: extensions cannot veto them. Their authority is defined in [ADR 0003](./0003-archive-and-restore-authority.md).

## Consequences

- Core must know applicable registrations independently of whether extension code loaded successfully. Failure to load cannot be treated as absence of a restriction.
- Authority can differ by field or operation; controlling a project title does not confer ownership of locally authored descendant notes.
- Pre-mutation approval and post-commit external effects are distinct boundaries. Pre-mutation hooks are not the place to perform external writes whose success could precede a failed local commit.
- Target revisions do not capture ancestor lifecycle changes or establish ordering with external systems; current core validation and extension conflict policy remain necessary.
- Incoming integration updates need identifiable origin so an extension can apply its own policy without creating synchronization loops. Exact origin and authorization contracts remain unspecified.
- Durable delivery does not guarantee exactly-once external effects. Hook ordering and retry policy require separate contracts.
- Clients derive titles and slugs with shared code; direct API callers supply their own.

See [System boundaries](../architecture/system-boundaries.md) for the distinction between core storage ownership and external field authority.
