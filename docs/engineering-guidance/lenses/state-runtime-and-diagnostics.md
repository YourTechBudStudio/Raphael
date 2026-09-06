# State, runtime, and diagnostics

Use this lens for state transitions, operational work, Effect primitive use, failure handling, and runtime visibility. Raphael's code should be Effect-native: the question is whether the right primitives serve the job, not whether the code has reached a prescribed adoption tier.

## Questions

- What action causes each state transition? Are its scope and cost proportionate, or does an apparently local operation trigger hidden mutations or broad work?
- Who owns in-flight work and resources? What happens on interruption, cancellation, repeated requests, concurrent updates, or shutdown where those situations apply?
- Are we recreating behavior that Effect primitives would implement better? Look especially at expected failures, retry, timeout, resource management, cancellation, concurrency, and dependency handling.
- Are expected failures distinguishable with appropriate tagged errors and typed error channels, or have custom error conventions and generic exceptions weakened caller handling?
- Do Promise-style bridges, detached work, or exception-based paths lose Effect's failure or lifecycle guarantees? Are framework and third-party boundaries handled deliberately?
- Would an appropriate Effect primitive clarify dependencies, lifecycle, or composition? Conversely, is machinery being introduced without a problem to solve? Organize around capabilities rather than allowing a global collection of services to become the architecture.
- What happens after partial completion or a failed retry? Can recovery duplicate an operation, overwrite newer state, or turn uncertainty into apparent success?
- Can a failure be understood from available errors, state, and targeted diagnostics? Is enough context retained to identify the failing operation and cause without indiscriminate logging?
- Do logs and diagnostics avoid exposing note contents, credentials, or other sensitive information? Does a dependency's failure or degraded availability leave behavior bounded and understandable?

Do not mandate services for every helper, logging for every function, or a particular concurrency mechanism regardless of need. Do not hesitate to introduce Effect primitives when they replace weaker custom machinery with the guarantees the problem requires.

## Severity calibration

- **Blocker** — an operational gap materially threatens data, security, or lifecycle correctness; for example, retries can duplicate destructive effects, unmanaged work can corrupt state after cancellation, or diagnostics expose credentials or private note content.
- **Concern** — a concrete failure-handling, maintenance, or diagnosis gap; for example, generic errors prevent intended recovery, custom retry machinery loses required semantics, a small action causes unjustified broad work, or failures lack the context needed to identify their cause.
- **Nit** — an optional local improvement in primitive use or diagnostic clarity where existing behavior and guarantees are sound. Missing an Effect primitive is not a Blocker by itself.

Use the [review-consumption rules](../how-to-use.md#consuming-severity-findings) for next steps. User-visible outcomes and recovery affordances belong primarily in [product behavior and UX](./product-behavior-and-ux.md).
