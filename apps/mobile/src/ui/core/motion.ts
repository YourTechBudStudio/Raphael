/** Raphael's approved Active/Favorite choreography; not a universal Material duration. */
export const FEEDBACK_DURATION = 250;

/** Raphael spatial feedback: crisp compression, lightly underdamped return. */
export const PRESS_SPRING = { mass: 1, stiffness: 900, damping: 60 } as const;
export const RELEASE_SPRING = { mass: 1, stiffness: 500, damping: 30 } as const;
export const PRESS_SCALE = { button: 0.97, icon: 0.98, surface: 0.995 } as const;

/** AndroidX Expressive FastEffects; Reanimated damping = 2 * ratio * sqrt(stiffness). */
export const MATERIAL_EFFECTS = {
  mass: 1,
  stiffness: 3800,
  damping: 2 * Math.sqrt(3800),
} as const;

/** Material focus/hover tokens; Raphael's subtler press fallback is reduced-motion only. */
export const MATERIAL_STATE_OPACITY = { pressed: 0.04, focused: 0.1, hovered: 0.08 } as const;
