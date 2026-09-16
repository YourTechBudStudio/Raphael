/**
 * The notice's timing and spacing, apart from the component so that whatever it lifts can move with
 * it rather than approximating it.
 *
 * Timed, not sprung, and deliberately short: a statement about something that has already happened
 * should arrive and leave without asking for attention.
 */

/** 200 ms rise-and-fade in with ease-out. */
export const SNACKBAR_IN_MS = 200;
/** 150 ms out with ease-in. */
export const SNACKBAR_OUT_MS = 150;
/** How long it stands before leaving on its own. */
export const SNACKBAR_HOLD_MS = 2000;
/** The gap between the notice and whatever it lifts. */
export const SNACKBAR_GAP = 12;
