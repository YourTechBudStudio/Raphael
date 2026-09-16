/**
 * Identifiers for a test, and deliberately not random ones.
 *
 * The property that matters about the real generator is that two calls never collide, which is a
 * claim about the platform's implementation rather than about this app. A counter keeps the
 * collision-free part and makes what a test observes reproducible.
 */

let issued = 0;

export const randomUUID = () => {
  issued += 1;

  return `test-id-${String(issued)}`;
};
