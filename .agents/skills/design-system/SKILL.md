---
name: design-system
description: Use when designing, implementing, or reviewing Raphael UI, mockups, user-facing copy, README, or marketing surfaces. Defines Catppuccin Macchiato colors, Sora and Source Sans 3 typography, restrained liquid-glass motion, quiet content surfaces, dry developer humour, and accessible presentation for mobile and web. Apply voice guidance to prose and visual guidance to rendered interfaces; this skill does not prescribe features or user journeys.
---

# Raphael Design System

## What this skill is

Raphael's design language, adapted from Isagi's house style. The palette, typography, and dry developer voice belong to the same family. Raphael's presentation is quieter: readable content, recognizable actions, and little ceremony. Most interaction is brief; decoration must not demand time or attention.

This skill is the canonical visual and voice guide. It defines principles and anchor examples, not screens, navigation architecture, features, data models, or workflows. Examples illustrate treatments, not requirements to implement their subjects. Apply voice guidance to README and marketing prose without imposing interface rules on engineering documents.

## Voice — made by a dev, for devs

- **Deadpan over enthusiastic.** State what is true; do not perform delight. Personality belongs in wording and typography, not novelty controls or bouncy motion.
- **Self-aware over polished.** Acknowledge ordinary things without dressing them up. A quiet aside such as `// future you says thanks` is enough; it does not need an accompanying animation.
- **Conversational, never marketing-speak.** Write real sentences. Prefer `No matches. Try a different phrase.` over a stock label or a congratulatory speech.
- **Respect the person.** Never shame unfinished work, accumulated notes, or time away. Dry humour is not a productivity guilt trip.
- **Plain actions, plain status.** Buttons say what they do. Status text states what is happening. Accuracy and recovery guidance always take priority over personality.

### Copy and humour patterns

- **The mono whisper.** A visually subordinate monospace aside in a footer or occasional tip. Keep it readable; low emphasis does not mean inaccessible opacity.
- **The self-aware aside.** Name the thing plainly, then add a short deadpan footnote where it is harmless. Example: `Settings — The usual knobs.`
- **The conversational empty state.** Full sentences with restrained warmth, not stock labels or congratulations for arriving.
- **Code-as-decoration.** A short comment-shaped signature, used sparingly on marketing or edge surfaces. It must not masquerade as interactive code.
- **Plain-language microcopy.** `Save`, `Cancel`, and `Delete note` are labels, not opportunities for a joke.

Humour may live in empty states, 404s, occasional onboarding asides, footers, tips, marketing asides, and user-fixable edge cases where the joke cannot obscure the problem or its remedy. It is forbidden in primary CTAs, working chrome, agent status lines, destructive confirmations, validation errors, and text seen on every interaction. Do not make waiting cute. Rare and deadpan ages better than constant and trying.

## Palette — Catppuccin Macchiato

Deep neutrals carry the interface. Pastels are sparse accents, not a color-coded taxonomy. These values inherit Isagi's palette; their inclusion does not require a corresponding component or feature.

| Role | Name | Value |
| --- | --- | --- |
| Surface | Canvas | `#24273a` |
| Surface | Subtle | `#2e3244` |
| Surface | Elevated | `#363a4f` |
| Surface | Code/terminal surface | `#2d3145` |
| Surface | Overlay | `#3a3f57` |
| Surface | Line | `#5b6078` |
| Surface | Scrim | `#141622` |
| Foreground | Primary | `#cad3f5` |
| Foreground | Muted | `#a5adcb` |
| Foreground | Subtle | `#6e738d` |
| Accent | Blue | `#8aadf4` |
| Accent | Violet | `#c6a0f6` |
| Accent | Amber | `#f5a97f` |
| Accent | Green | `#a6da95` |
| Accent | Red | `#ed8796` |
| Accent | Cyan | `#91d7e3` |

- **Accents earn their use.** One or two accents can lead a surface. Do not spread six accents evenly across it or assign every category a rainbow chip.
- **Reserve red.** Use it for genuine errors and destruction, not routine prompts, incomplete fields, or minor warnings. Those can use amber or readable neutral text.
- **Meaning before pigment.** Where color communicates state, pair it with words, shape, or an icon. Product-specific semantic assignments are outside this skill's scope.
- **Check actual contrast.** The subtle foreground is not a universal text color. Promote to muted or primary wherever the chosen background, size, or weight makes it insufficiently legible.

## Typography

- **Display: Sora.** Use it for distinctive headings, not every line of working text.
- **Body: Source Sans 3.** A quiet humanist face for labels and prose. Start sustained reading around 16 logical pixels, with comfortable line spacing; support platform text scaling rather than enforcing a fixed size.
- **Code and asides: Fira Code.** Mono is both a code face and a restrained signature. Do not turn the whole interface into terminal cosplay.
- **Decisive hierarchy.** Use clear size and weight steps. Small overlines may use slight letter spacing, but must remain legible and must not become all-caps shouting.
- **Readable measure.** On wider surfaces, keep prose at a comfortable line length, roughly 60–75 characters where practical. On phones, prioritize available width and sensible margins over reproducing desktop measurements.

Use these families consistently across clients, with platform-appropriate loading and fallbacks. System fonts are acceptable temporary or accessibility fallbacks, not the intended primary identity. Do not clip content or controls when fonts or text sizes change.

## Surfaces, atmosphere, and depth

- **Content stays quiet.** Reading and editing surfaces can be opaque and flat. Do not place halos, grain, or blur behind every paragraph.
- **Atmosphere belongs around the content.** Restrained blue, violet, and cyan halos can give the outer shell, occasional empty states, and marketing heroes depth. Isagi's approximately 10–14% accent opacity is an anchor, not a minimum.
- **Glass is selective.** Translucency and blur may suit sheets and overlays, but never at the expense of contrast, performance, or platform accessibility preferences. Provide opaque alternatives.
- **Texture is optional.** Faint grain may soften a decorative surface; remove it if it interferes with content.
- **Shadows are soft, never crisp defaults.** Web anchors are `0 16px 48px rgb(0 0 0 / 0.4)` and `0 24px 64px rgb(0 0 0 / 0.45)`. Native implementations should match the perceived depth rather than pretend CSS shadow strings are portable.
- **Shape is consistent.** Radius anchors are 10, 14, 20, and 28 logical pixels. Use them deliberately rather than rounding every nested surface equally.

## Spatial composition

Commit to generous space around content or controlled density in structured views. Do not give everything the same medium padding and visual weight. Compact presentation must not mean undersized touch targets.

The content and immediate action should be recognizable; chrome and decoration recede. Use negative space structurally instead of filling every gap. Asymmetry and overlap may help expressive surfaces, but should never obscure text, controls, focus outlines, or hit areas.

## Motion — fast start, soft landing

The primary easing curve is `cubic-bezier(0.16, 1, 0.3, 1)`. Use its native equivalent where needed. The liquid feel comes from soft landings and selective depth, not springs or overshoot.

| Interaction | Anchor duration |
| --- | --- |
| Press, hover, focus | `110ms` |
| Tooltip or menu | `190ms` |
| Panel, sheet, modal | `320ms` |
| Rare, deliberate transition | `600ms` |

These are anchors, not mandatory delays. Frequent interactions should respond immediately; do not gate input on an entrance animation. Rare transitions may have more time, but must earn it.

Prefer a continuous surface transition over unnecessary remount-like flashes. Do not animate content while someone is reading it or add ambient movement to idle interfaces. No bouncy modals, theatrical scaling, or gratuitous page choreography.

Long-running activity should use calm status or restrained ambient indication rather than an indefinite spinning ring. Never imply measured progress when only activity is known. Continuous loops may deliberately use linear timing. Reduced-motion alternatives must preserve the meaning without movement.

## Accessible interaction and presentation

- **Touch-first, keyboard-capable.** Aim for at least 44-point targets on iOS and 48-dp targets on Android. Small visible icons can have larger hit areas. On web, provide keyboard access and visible focus without requiring shortcuts.
- **No hidden-only actions.** Essential controls cannot depend solely on hover, gestures, or memorized shortcuts. This is an accessibility constraint, not a navigation prescription.
- **Contrast is functional.** Meet WCAG AA contrast for text and meaningful controls on actual rendered backgrounds. Decorative opacity is never an exemption for useful information.
- **Text scales.** Honor platform font settings and web zoom. Let layouts reflow rather than clipping labels or shrinking text to fit.
- **State has more than color.** Use readable labels and appropriate accessibility semantics. Focus, selection, disabled, and error treatments must remain distinguishable.
- **Respect preferences.** Reduced motion and reduced transparency take precedence over the house effect. Keep quiet alternatives visually intentional.

## Anti-patterns — hard bans

- Generic primary typography in place of the house families, except necessary fallbacks or user accessibility overrides.
- Stock landing-page gradients and rainbow category or tag palettes.
- Decorative glass, grain, or halos that compete with readable content.
- Symmetric centered card grids used automatically for every composition.
- Spring-bouncy modals, overshoot, or animation that delays interaction.
- Indefinite spinners for work taking real time, or motion that distracts during reading.
- Sparkle emoji on AI surfaces, emoji-decorated CTAs, and shouty buttons.
- Congratulatory `Welcome to Raphael!` empty states.
- Humour in primary actions, validation, destructive confirmations, status, or constantly seen chrome.
- “Empower,” “unlock,” “supercharge,” “seamless,” and “delightful” as promotional language.
- Shame about unfinished work or time away.
- Hard framework-default drop shadows.
- Low-contrast essential text, tiny touch targets, hidden-only controls, or inaccessible effects defended as brand fidelity.

## Intentionality bar

Restraint is a feature. Every decoration earns its place. Repeat a coherent pattern before inventing a new treatment. Match implementation complexity to the result; a refined surface with a few deliberate elements beats a maximalist one.

When in doubt, do less and execute it precisely. Raphael should feel related to Isagi without requiring the user to spend time admiring the interface.
