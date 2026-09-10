# Architecture decision records

ADRs preserve consequential architectural decisions, their context, and their consequences. Accepted records describe agreed direction, not implementation status. Records justify durable boundaries and consequential choices, not release defaults or integration checklists; initial backend choices live in [Runtime and access](../architecture/runtime-and-access.md).

| ADR                                              | Decision                                               | Status   |
| ------------------------------------------------ | ------------------------------------------------------ | -------- |
| [0001](./0001-retrieval-and-search-authority.md) | Core retrieval and scoped extension-assisted search    | Accepted |
| [0002](./0002-mutation-authority.md)             | Core mutations with fail-closed extension restrictions | Accepted |
| [0003](./0003-archive-and-restore-authority.md)  | Core-owned archive causes and recoverable cascades     | Accepted |
| [0004](./0004-canonical-data-and-addressing.md)  | Stable identity, parent references, and computed paths | Accepted |
| [0005](./0005-canonical-content-and-search.md)   | Canonical TipTap bodies and core multi-field search    | Accepted |
| [0006](./0006-ai-capability-ownership.md)        | Pi-backed AI capabilities and central provider routing | Accepted |
| [0007](./0007-shared-node-storage.md)           | Shared node storage for areas, projects and resources with specialized data tables       | Accepted |

Read the [architecture overview](../architecture/README.md) for the connected model, or return to the [documentation guide](../README.md).
