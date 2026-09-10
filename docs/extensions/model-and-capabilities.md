# Model and capabilities

An extension adds domain-specific behavior to Raphael's core organizational model. It does not replace areas, projects, resources, or the APIs that retrieve their stored representations.

## Trust boundary

Extensions are trusted backend code installed by the operator in their own backend. This is not a third-party marketplace or an untrusted-code sandbox model.

Extensions participate through a stable interface. Trust does not remove responsibility for validating external input, protecting credentials, or keeping failures understandable. An authenticated installation does not make incoming webhook payloads trustworthy.

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

| Representation and capability            | Search coverage                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Copied content, no search hook           | Searchable stored content                                                   |
| External reference with a search hook    | Stored representation plus external content matches for registered entities |
| External reference without a search hook | Stored representation only; external full content remains unsearchable      |

An extension may combine these approaches. Referenced content remains externally owned even when a copy is stored in Raphael. Locally authored notes are a separate ownership concern.

## Open mechanisms

Extension loading, process boundaries, lifecycle registration, configuration schemas, and route formats remain undecided. These are capability descriptions, not promises about a particular module or endpoint API.

Core records and extension metadata are the baseline representation. Whether extensions can have private schemas or separate databases, and how those are isolated or migrated, remains open; extensions are not being granted unrestricted changes to core storage.

Custom renderers, dynamic blocks, and arbitrary HTML are not settled capabilities. A resource kind can inform future presentation, but these documents do not choose a rendering format or native/web integration mechanism.

Continue with [Responsibilities](./responsibilities.md) and [Hooks](./hooks.md).
