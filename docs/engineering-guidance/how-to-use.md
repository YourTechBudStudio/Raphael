# How to use this guidance

Start with the [entry point](./README.md) and [principles](./principles.md). Use the relevant lens questions while designing, coding, and reviewing; do not mechanically apply every question to every change.

## Applying the lenses

Use architecture and evolution for ownership, module shape, contracts, and interface changes. Use state, runtime, and diagnostics for transitions, Effect primitive use, lifecycle, failures, and operational visibility. Use product behavior and UX when a change affects what a user sees, understands, trusts, or can do. Load the design-system skill for user-facing presentation and copy.

Keep durable guidance distinct from current repository decisions. Consult relevant ADRs rather than inferring architectural commitments from lens examples. In particular, questions about interrupted work or persisted state do not require an offline mode or a particular synchronization design.

A finding should identify a concrete consequence, not merely a different preferred implementation. Use the lens-specific severity calibration. When severity is uncertain, choose the lower tier unless the consequence is concrete and material. If multiple lenses describe the same problem, report it once under the primary failure.

## Consuming severity findings

Severity findings describe defects. Handle them consistently whether the consumer is a person or an agent:

- **Blocker** — material divergence from guidance; must fix and re-review after the fix.
- **Concern** — a design, runtime, or product gap with real consequence; fix directly when the resolution is clear, or surface it to the user when a decision is needed. Re-review only if the fix is substantial.
- **Nit** — a marginal, optional improvement; terminal and never a reason for re-review on its own.

Do not silently discard a Blocker or Concern. Surface disagreements or conflicts with the intended direction rather than hiding them in implementation choices. Lens examples calibrate consequences; they are not automatic severity assignments based on a missing pattern or primitive.

## Consuming Architectural Reflection (Step-Back)

Architectural Reflection is a separate channel outside the severity ladder: a proposal that a simpler mental model or different solution shape would better serve the goal. It is not a defect to patch and never triggers a re-review.

Weigh the proposal against the original plan. If it is in scope and clearly aligned, adopt it only as a deliberate decision. If it exceeds the change's scope or conflicts with the plan, the consuming agent stops and surfaces it to the user, offering the choice of restructuring now or deferring it. Do not silently turn a reflection into a scope-expanding refactor.
