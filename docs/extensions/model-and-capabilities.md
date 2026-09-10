# Model and capabilities

An extension adds domain-specific behavior to Raphael's core organizational model. Resource kinds, including the built-in note kind, are extensions; areas and projects remain core concepts. Extensions do not replace the entity model or universal retrieval APIs.

## Trust boundary

Extensions are trusted backend code installed by the operator in their own backend. This is not a third-party marketplace or an untrusted-code sandbox model.

Extensions use the same core operations and validation as clients through Raphael's internal SDK. Hooks grant bounded participation, not arbitrary writes to core records. Extensions do not change CLI behavior. Trust does not remove responsibility for validating external input, protecting credentials, or keeping failures understandable. An authenticated installation does not make incoming webhook payloads trustworthy.

## Optional contributions

| Capability            | Purpose                                                             | Boundary                                                                                          |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Resource kinds        | Represent domain-specific content or references                     | Areas and projects remain distinct core entity types                                              |
| Settings              | Declare integration configuration for Raphael's settings experience | Settings schemas and registration mechanisms are not yet specified                                |
| Webhook/API handlers  | Receive integration-specific requests through Raphael               | Does not replace core Get/List APIs                                                               |
| Search hooks          | Search external content associated with registered entities         | Must respect the scope supplied by core                                                           |
| Mutation checks       | Reject controlled changes or direct callers to the canonical source | Cannot veto archive or restore                                                                    |
| Post-commit reactions | Synchronize accepted changes or react to lifecycle events           | Durable, retryable delivery; repeated execution must be safe; failure does not reverse the commit |
| Reconciliation        | Maintain external mappings and declared placement                   | Core protects hierarchy and lifecycle correctness                                                 |

An extension need not implement every capability. A kind that stores only an external reference is still useful to people and agents without live search or custom rendering.

## Stored representations

Extensions create ordinary core entities and supply their domain-specific metadata. Resource bodies can contain copied external content, summaries, or references; they must not depend on a Get/List hook to become readable.

Copied content and external references can coexist. Referenced content remains externally owned even when a copy is stored in Raphael; locally authored notes are a separate ownership concern. [ADR 0001](../adrs/0001-retrieval-and-search-authority.md) defines stored versus extension-assisted search coverage.

## Open mechanisms

[System boundaries](../architecture/system-boundaries.md#deliberately-unspecified) lists unresolved extension mechanisms. Capture intent may be extension-owned metadata; it does not introduce a core capture entity.

Core records and extension metadata are the baseline representation. Whether extensions can have private schemas or separate databases, and how those are isolated or migrated, remains open; extensions are not being granted unrestricted changes to core storage.

Bodies follow the core document schema in [ADR 0005](../adrs/0005-canonical-content-and-search.md); custom renderers and arbitrary extension-defined blocks are not settled capabilities. Shared AI operations follow [ADR 0006](../adrs/0006-ai-capability-ownership.md), without exposing Pi or provider credentials to extensions.

Continue with [Responsibilities](./responsibilities.md) and [Hooks](./hooks.md).
