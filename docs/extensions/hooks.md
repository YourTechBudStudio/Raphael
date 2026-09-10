# Hooks

Hooks grant specific participation, not arbitrary access to core state. The ADRs own behavioral guarantees; this document explains obligations for extension authors, not SDK signatures or scheduling.

## Search

Return matches only for existing entities within the supplied scope, with enough attribution and context to explain external-content matches. Do not create entities or discover unregistered objects during search. Report failure rather than returning an empty successful result. Get and List never invoke extensions. See [ADR 0001](../adrs/0001-retrieval-and-search-authority.md).

## Pre-mutation participation

Checks can reject controlled changes and identify the canonical source to edit instead. Transformations return a candidate that remains subject to core validation. Registered restrictions must remain identifiable when extension code is unavailable, so required checks fail closed.

Do not perform external writes before a local commit that may still fail. Archive and restore cannot be vetoed. See [ADR 0002](../adrs/0002-mutation-authority.md).

## Post-commit reactions

Use post-commit hooks for external effects. Delivery is durable and retryable; use stable invocation identity to tolerate replay rather than assuming exactly-once execution. A failed reaction cannot reverse committed data. This delivery model does not apply to pre-mutation or search hooks.

Lifecycle reactions may request a separate change only for an independent reason owned by the extension. Do not convert notifications into self-sustaining archive loops or clear unrelated causes; see [ADR 0003](../adrs/0003-archive-and-restore-authority.md).

Registration, ordering, timeouts, retry policy, mutation origin, and recursion safeguards require implementation contracts.
