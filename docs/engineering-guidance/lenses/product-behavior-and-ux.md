# Product behavior and UX

Use this lens when a change affects what people see, understand, trust, or can do. Review product meaning and interaction behavior here; use the [design-system skill](../../../.agents/skills/design-system/SKILL.md) as the canonical source for presentation, accessibility, and voice details.

## Questions

- Does the surface distinguish completed, pending, partial, failed, and uncertain outcomes where those differences matter? Does a claim such as saved or completed reflect the actual guarantee?
- Can the user understand what happened and choose a useful next action? Are failures and degraded behavior surfaced where they affect the task, rather than hidden behind generic success or indefinite activity?
- When work is interrupted or fails, is user input preserved where appropriate? Are retry, cancellation, and destructive actions understandable and consistent with their actual consequences?
- Does the interaction remain responsive and usable under relevant loading, empty, error, and unavailable states? Does it avoid making users wait through decorative behavior?
- Can people perceive and operate essential actions with the relevant platform accessibility settings and input methods? Does presentation follow the design-system skill without sacrificing usability?
- Do mobile and web express the same product rules and outcome meanings where intended, while allowing platform-appropriate interaction? Would shared logic or components prevent actual drift without forcing identical implementations?
- Is copy accurate about limitations and recovery? Can users distinguish their own actions from automated or agent-driven changes when that distinction affects trust?

These questions do not prescribe screens, workflows, offline support, or synchronization architecture. Apply them to behavior the change actually introduces or affects.

## Severity calibration

- **Blocker** — materially misleading or unusable behavior threatens user work or prevents an essential task; for example, failed persistence is presented as saved, a destructive action conceals its consequence, or an essential action has no accessible means of operation.
- **Concern** — a concrete interaction or trust gap; for example, a recoverable failure offers no useful next step, a retry unexpectedly discards input, or equivalent client actions communicate conflicting outcomes.
- **Nit** — an optional wording or presentation improvement where meaning, accessibility, and task completion are already sound. Personal aesthetic preference alone is not a finding.

Use the [review-consumption rules](../how-to-use.md#consuming-severity-findings) for next steps. Report underlying lifecycle or failure-handling defects under [state, runtime, and diagnostics](./state-runtime-and-diagnostics.md) rather than duplicating them here.
