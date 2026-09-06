# Architecture and evolution

Use this lens for capability boundaries, module structure, shared behavior, contracts, and interface changes. The goal is to localize change without hiding ownership or coupling unrelated concerns.

## Questions

- Is code organized vertically around coherent capabilities, or does a product change require editing unrelated global layers? Within a capability, is the internal structure easy to navigate?
- Does each module expose a narrow, meaningful interface that hides complexity, or does it merely forward calls and force callers to coordinate its internals?
- Can the behavior be understood locally? Are dependencies and control flow legible without chasing a chain of shallow wrappers, generic registries, or unrelated helpers?
- Is there a clear owner for canonical data and business decisions? Do client projections and caches remain distinguishable from authoritative state?
- Are request, response, failure, and persisted-data contracts explicit at real boundaries? Are implementation details leaking into callers or serialized interfaces?
- Would sharing a component, function, or module prevent meaningful behavioral, visual, or logic drift? Would the proposed sharing instead couple different capabilities or platform needs?
- Can an internal interface be replaced and its callers migrated cleanly, rather than retaining shims, obsolete paths, or dual systems? At real external or data boundaries, what compatibility obligation actually exists?
- Does a boundary crossing validate untrusted input and preserve authorization responsibility? Does a new dependency introduce unnecessary privilege, coupling, or public-surface exposure?

Vertical organization does not mean placing mobile, backend, and web implementations into one undifferentiated module. Deep modules do not mean giant files. Shared code should have a coherent responsibility, not become a miscellaneous destination for anything used twice.

## Severity calibration

- **Blocker** — a boundary or contract failure materially threatens correctness, data integrity, or access control; for example, a client bypasses authoritative authorization or an incompatible stored-data change makes existing data unreadable without a deliberate migration path.
- **Concern** — structure has a concrete change cost or drift risk; for example, one capability is scattered across global layers, callers orchestrate private module details, duplicated business rules already differ, or unnecessary compatibility paths maintain two internal behaviors.
- **Nit** — a small optional improvement to grouping or surface clarity with no meaningful ownership, coupling, or drift consequence. A preference for another folder layout alone is not a finding.

Use the [review-consumption rules](../how-to-use.md#consuming-severity-findings) for next steps. Transition and lifecycle problems belong primarily in [state, runtime, and diagnostics](./state-runtime-and-diagnostics.md).
