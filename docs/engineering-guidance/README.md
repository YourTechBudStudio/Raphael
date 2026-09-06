# Engineering guidance

Use this guidance during coding and review to keep changes localized, boundaries clear, and behavior dependable. It is a question set for humans and agents, not a style manual or a prescription for one architecture.

## Reading order

1. [Principles](./principles.md) — durable engineering goals.
2. [How to use](./how-to-use.md) — applying the lenses and consuming review output.
3. The lenses relevant to the change:
   - [Architecture and evolution](./lenses/architecture-and-evolution.md) — vertical modules, deep interfaces, ownership, contracts, reuse, and compatibility.
   - [State, runtime, and diagnostics](./lenses/state-runtime-and-diagnostics.md) — state transitions, Effect primitives, lifecycle, failures, and diagnosability.
   - [Product behavior and UX](./lenses/product-behavior-and-ux.md) — honest outcomes, recovery, accessibility, and cross-client consistency.

Relevant lenses have equal standing. Each defines its own Blocker, Concern, and Nit calibration; [how-to-use.md](./how-to-use.md) defines what to do with those findings and the separate Architectural Reflection channel.

## Raphael context

Raphael is a second brain for agents, combining PARA and CODE to organize actionable notes. The repository is currently a monorepo foundation. The planned Expo mobile app is the primary phone interface, the backend owns persistence and canonical stored data, and the web app provides access outside mobile clients.

Implementation is intended to be Effect-native. Review whether appropriate Effect primitives solve the actual problem better than custom machinery; this guidance does not define adoption tiers or a mandatory service hierarchy.

Favor clean internal evolution while the product is unlaunched. This does not erase obligations at real user, data, integration, public API, or deployment boundaries. Consult the [ADR index](../adrs/README.md) for relevant architectural decisions as they emerge.

## Scope limits

This system does not cover verification or reviewability. Repository workflow commands remain in `AGENTS.md`.

Do not expand these docs into formatting rules, arbitrary file-size limits, naming preferences, framework tutorials, exhaustive security checklists, or speculative product architecture. Trust and dependency questions belong only where they affect concrete boundaries or runtime behavior. Do not require logging in every function or abstraction for its own sake.

The [design-system skill](../../.agents/skills/design-system/SKILL.md) owns visual and voice guidance; reference it rather than repeating it. Add guidance when recurring problems expose a missing question, not merely because another topic could have its own document.
