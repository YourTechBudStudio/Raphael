# ui

Shared presentation primitives and layouts. Capability modules compose these without putting product data access or state ownership into shared UI.

## Barrels

- `ui/index.ts` exposes the shared presentation interface to modules.
- `ui/core` — press feedback, surfaces, decorative emblems, headings, controls, search inputs, and empty states.
- `ui/chrome` — generic screen and sheet frames: `Screen`, `Sheet`, and `SheetHeader`.
- Product-aware cards and grids live in `modules/resources` and `modules/collections`; playback visuals live in `modules/playback`; navigation top bars and capture controls live in their respective modules.
- `ui/theme.ts` — token values mirrored from `global.css` for SVG props, icon colors, and shadows. `global.css` stays the source of truth; `useThemeColor(name)` is the call-site helper.

## Rules

- Screens compose primitives; they do not restyle them. If a screen needs a different look, the primitive gains a prop or a variant, so the change lands everywhere at once.
- Colors, fonts, and radii come from tokens: a Tailwind class where one exists, `colors`/`radii`/`fonts` from `ui/theme.ts` where a class cannot reach (SVG, lucide `color`, shadows). No hex literals in screens.
- Motion lives in the primitives: `PressableFeedback` uses soft compression and a tiny spring rebound, strongest on capture buttons, quieter on icon controls, and barely perceptible on cards/other surfaces. Text buttons counter-scale their content to keep labels steady. Resting corners and hit areas stay fixed; normal presses have no tonal overlay. Content-colored state layers retain hover/focus cues and provide a subtle reduced-motion press fallback. `BloomIcon` retains the approved 250 ms Active/Favorite choreography, exclusively owning bursts and animated fills. Reduced motion keeps geometry still and changes state immediately. See [press motion](./core/motion.md) for tuning and cross-platform behavior.
- Every interactive primitive takes an accessibility label or derives one, reports its state, and keeps a hit area of at least 44.
- `className` on an animated surface needs `AnimatedSurface` (`withUniwind(Animated.View)`); plain `Animated.View` ignores it.
- Export each shared name from one place. `ui/index.ts` combines the core, chrome, and theme exports; do not re-export capability modules through UI.
