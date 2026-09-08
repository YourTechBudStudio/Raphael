# Press motion

`PressableFeedback` implements Raphael's soft press and tiny rebound. Material 3 content-colored state layers remain the tonal indication; spatial feedback is Raphael-specific tuning, not a claim to reproduce native Android motion. `BloomIcon` remains the separately approved Active/Favorite animation with its 250 ms pop, burst, and animated fill.

## Hierarchy

- Capture/text buttons (`button`): compress to 97% while pressed, then gently rebound.
- Other icon controls (`icon`), including playback: compress to 98%, then gently rebound as a unit.
- Cards, chips, and navigation rows (`surface`): compress to 99.5%, keeping reading movement minimal.

Resting appearance and corner radii never change. The outer pressable retains its layout and hit area; only its inner surface transforms. Text buttons use the children render function's inverse-scale style on an `AnimatedSurface` around their content, keeping the label and its accompanying icon steady without changing the surrounding layout. Icon-only controls move as a unit. There are no bursts, animated fills, wiggles, or decorative release pulses outside Active/Favorite.

## Springs and interaction state

Press compression uses a critically damped spring (mass 1, stiffness 900, damping 60). Release uses a lightly underdamped spring (mass 1, stiffness 500, damping 30), allowing a tiny overshoot before settling. These are starting values to judge on-device at normal speed, not fixed-duration choreography. Large surfaces use the same spring but much less travel.

Release, cancellation, and repeated presses retarget the current spring rather than queueing animations. Hover and focus do not restart spatial feedback. Actions execute immediately, without waiting for the rebound; opening a sheet or navigating may overlap or interrupt it. Disabled controls reset feedback. Reduced motion removes transforms and applies tonal state changes immediately.

## Tonal indication

Normal presses use spatial feedback only, without a tonal overlay. Reduced-motion presses use a subtle 4% state layer instead. Independent focus (10%) and hover (8%) indications remain visible, including during a press; overlapping states use the strongest opacity rather than adding together. The layer uses the control's content/on-container color: white for filled violet buttons and violet for peach playback buttons. It covers the surface and clips to its unchanged corners. Opacity uses the Material Expressive FastEffects spring (stiffness 3800, damping `2 * sqrt(3800)`, mass 1), or changes immediately with reduced motion. This is not Android's native ripple.

## Device review

Check New Note, Record Voice, playback in cards and the recording sheet, Save, and card navigation on Android first, then iOS. Compare quick taps and holds, repeated taps, dragging away to cancel, scrolling from a card, nested playback/favorite controls, disabled actions, and reduced motion. Verify that text stays steady, nested actions do not navigate the parent card, and no action waits for motion. Active/Favorite should remain visibly more expressive than all other controls.
