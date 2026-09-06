# Principles

These goals are durable. Raphael-specific context lives in the [entry point](./README.md); concrete questions and severity calibration live in the lenses.

## Optimize for future change

Does the design make the next likely change easier without building for hypothetical requirements? Prefer clean internal interfaces and migrate callers when safe. Preserve compatibility deliberately where users, stored data, integrations, public APIs, or deployments actually depend on it.

## Localize change around capabilities

Can a coherent product change stay within a coherent module? Prefer vertical organization around capabilities over global technical-layer directories that scatter related behavior. Keep code that changes together close without crossing ownership, trust, or deployment boundaries merely to colocate it.

## Prefer deep modules with legible surfaces

Does a small, understandable interface hide meaningful complexity? Concentrate complexity intentionally rather than spreading it across shallow wrappers. A deep module may contain multiple focused files; its internal flow should remain easy to navigate and reason about locally.

## Make ownership and contracts explicit

Who owns each fact, decision, and effect? Make real boundaries explicit enough that callers can understand guarantees and failures without knowing implementation details. Avoid interface ceremony where no meaningful boundary exists.

## Reuse to prevent meaningful drift

Are similar components, functions, or modules expressing the same behavior or rule? Actively look for shared implementations that prevent behavioral, visual, or logic drift. Do not trade away readable code, clear boundaries, or local reasoning merely to remove similar-looking lines.

## Keep state and operational behavior explicit

What causes a transition, what can fail, and how long can work live? Make state changes causal, effects bounded, and resource ownership clear. Prefer established primitives that capture the required guarantees over weaker custom implementations.

## Keep outcomes honest and failures diagnosable

Can users and operators distinguish success, uncertainty, partial completion, and failure? Make degradation and recovery understandable, and retain useful diagnostic context without exposing private content or credentials.

## Treat user experience as engineering behavior

Can people understand and complete the intended action, including when something goes wrong? Accessibility, responsive interaction, truthful status, and consistent product meaning are engineering concerns, not optional decoration.
