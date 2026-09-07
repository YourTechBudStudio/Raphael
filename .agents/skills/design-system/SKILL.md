---
name: design-system
description: Design and review Raphael interfaces and mockups using Material Design 3 Expressive with Raphael's lilac styling. Apply its restrained developer voice to user-facing copy, README, and marketing content.
---

# Raphael design system

## Foundation

- **Base:** [Material Design 3 Expressive](https://m3.material.io/) for components, interaction states, shape, and motion.
- **Raphael identity:** light lilac, deep purple ink, rounded cards, subtle waves, playful spring feedback.
- **Defaults:** use the base system where this guide has no specific treatment; apply the overrides below consistently.
- **Scope:** visual presentation and voice. Screen contents and navigation flows remain product decisions; prose outside interfaces uses only voice guidance.

## Palette

Approximate anchors from the selected mockups.

| Role | Color |
| --- | --- |
| Canvas | `#f8f6fc` |
| Lilac card / sheet | `#f1ecfa` |
| Warm card | `#faf5f2` |
| Wave / selected surface | `#e9e1f5` |
| Subtle border | `#ded5ef` |
| Primary text / icons | `#24134f` |
| Secondary text | `#635580` |
| Primary action / active accent | `#5b3fc8` |
| Decorative lilac | `#a18ade` |
| Peach playback accent | `#ffd0b8` |
| Text on primary action | `#ffffff` |

- **Violet:** primary actions, selection, favorites.
- **Peach:** occasional warmth, especially playback.
- **Categories:** stay within the narrow palette; give errors and destruction distinct semantic treatment.

## Surfaces and layout

- **Cards:** pale, mostly opaque, fine lilac borders; minimal elevation.
- **Waves:** broad, shallow, low-contrast curves clipped inside cards, usually at the bottom.
- **Images:** curved photo-to-caption boundaries; photography supplies richer color and texture.
- **Reading / editing:** quiet surfaces; keep decoration clear of content.
- **Depth:** soft shadows on floating controls and sheets; subtle tonal gradients instead of prominent blur or halos.
- **Composition:** left alignment, generous section gaps, consistent gutters; mix full-width and paired cards sized to content.
- **Responsive layout:** collapse columns when needed; preserve reading and focus order.
- **Shape:** soft card corners, pill text actions, circular icon actions, larger sheet corners. Starting radii: cards 14–20 logical pixels, sheets 28.
- **Capture controls:** violet fill, white labels, soft shadow; reserve clearance for content, safe areas, and keyboard.
- **Sheets:** pale surface, dimmed backdrop, clear title, visible dismissal.
- **Hierarchy:** indentation, fine connectors, disclosure controls, labeled current selection.

## Typography and icons

| Use | Treatment |
| --- | --- |
| Headings | Sora; strong size and weight hierarchy |
| Body / controls | Source Sans 3; body starts around 16 logical pixels |
| Code / rare asides | Fira Code |
| Wordmark | Lowercase `raphael` |
| Labels | Sentence case; readable metadata |
| Icons | Simple outlines, consistent strokes; content-type icons paired with labels |
| Collection emblems | Small lilac geometric forms: petals, arches |

## Motion

**Playful on touch. Calm at rest.** Use Material Design 3 Expressive springs for soft, bubbly feedback with small travel and quick settling.

Here are some examples:

| Interaction | Treatment |
| --- | --- |
| Button / card press | Small squish, rounded rebound; stable label and hit area |
| Selection / favorite | Gentle pop or brief icon wiggle, then rest |
| Capture / voice / Browse sheet | Slide with one light spring settle and scrim fade; trigger stays separate |
| Note opening | Card press feedback, then a short directional transition; preserve scroll position for return |

- **Scale:** small controls carry the playfulness; large surfaces move gently. Allow local squishes and corner softening, while keeping sheet geometry and reading text stable.
- **Starting points:** roughly 2–4% press compression and a few logical pixels of sheet overshoot; tune in a working interaction, not to make static keyframes more dramatic.
- **Limits:** one brief response per action, with no input delay or repeated bouncing. Use simple spring transitions instead of liquid stretching, folding, teardrops, or button-to-sheet morphs.
- **At rest:** decorative waves stay still or have very slow, hard to notice, non distracting perpetual motion.. Activity animation reflects actual recording, playback, or work status.
- **Reduced motion:** tonal feedback with an immediate change or short fade.
- **Review:** verify at normal speed that touch feels softly responsive and slightly bouncy, then settles quickly enough to leave attention on the content.

## Voice

- Plain language, restrained warmth, occasional dry developer humour.
- Example: “Keep the idea. Decide where it belongs later.”
- Humour belongs in occasional empty states, tips, and footers.
- Actions, status, errors, and destructive confirmations stay literal.
- Avoid promotional hype, sparkle decoration, and guilt about unfinished work.

## Accessibility

- WCAG AA contrast on actual backgrounds; decorative lilac and pale borders cannot carry essential meaning alone.
- Scalable text, keyboard access, visible focus, labeled icon buttons, non-color state cues.
- Hit targets: at least 44pt on iOS and 48dp on Android.
- Visible access to essential actions beyond gestures or hover.
- Opaque surfaces for reduced transparency.
