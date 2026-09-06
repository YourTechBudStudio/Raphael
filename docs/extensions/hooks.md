# Hooks

Hooks contribute behavior at explicit core boundaries. This document defines conceptual contracts, not function names, payload schemas, or execution ordering among multiple hooks.

## Participation

| Operation         | Participation                  | If the participating extension is unavailable |
| ----------------- | ------------------------------ | --------------------------------------------- |
| Get / List        | None                           | Stored retrieval remains available            |
| Search            | Optional relevant search hooks | Report incomplete source coverage             |
| Create / Update   | Applicable pre-mutation checks | Required checks fail closed; no mutation      |
| Committed changes | Optional post-commit reactions | Do not undo the local commit                  |
| Archive / Restore | Post-commit reactions only     | Do not block or undo the lifecycle operation  |

## Search

Core resolves the requested scope and invokes only relevant registered search capabilities. The extension must search external content associated with those scoped entities, not broaden a project query to its entire repository.

Matches identify existing Raphael entities. Hooks do not discover unregistered external objects or create entities as a side effect of search. Match context should include enough attribution and excerpt information to explain an external-content match even when that text is absent from the stored body.

Core merges matches by Raphael identity. A source failure is not a successful search with zero results. An extension without a search hook simply contributes whatever searchable representation it has already stored; there is no implied external-content coverage. See [ADR 0001](../adrs/0001-retrieval-and-search-authority.md).

## Pre-mutation checks and post-commit reactions

```text
Create or update
  Core validation + applicable extension checks
    Reject or required extension unavailable → error; no mutation
    Accept → core commit
      Notify interested extensions → optional external synchronization

Archive or restore
  Core lifecycle validation → core change
    Notify interested extensions → no veto
```

Pre-mutation checks can reject controlled changes and identify the canonical source the caller should edit instead. Errors should communicate the extension, affected operation or fields, and useful recovery guidance without requiring an agent to infer authority from prose alone. The error schema remains open.

Checks must not perform external writes before a local commit that could still fail. Post-commit reactions are the boundary for propagating accepted changes. Local success does not imply external synchronization has completed.

Registered restrictions remain enforceable when code fails to load. Core cannot interpret an unavailable required extension as an absent hook. Unrelated operations remain unaffected. See [ADR 0002](../adrs/0002-mutation-authority.md).

## Archive and restore reactions

Extensions cannot veto archive or restore, including cascades affecting entities they manage. Notifications follow the core operation; notification failure does not reverse it.

A reaction may request a separate lifecycle change when there is an independent reason. The extension adds or withdraws its own archive cause rather than manually changing every descendant. Withdrawing that cause does not force an entity active if another cause remains. See [ADR 0003](../adrs/0003-archive-and-restore-authority.md).

## Unresolved guarantees

Hook registration formats, timeouts, cancellation, multi-hook ordering, delivery durability, replay, and retry guarantees remain unspecified. No exactly-once notification or automatic retry contract is implied.

Mutation origin, recursion safeguards, concurrency preconditions, search pagination, and authorization details also require later design. The settled distinction is between a failed precondition, incomplete search, and a failed reaction to an already committed operation.
