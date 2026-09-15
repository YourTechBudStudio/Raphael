import { Effect } from 'effect';

/**
 * Hand control back to the event loop.
 *
 * The yield is a *macrotask*, not a fiber yield: what has to happen between batches of synchronous
 * storage work is Node's event loop reaching its poll phase, so socket reads and writes progress. A
 * yield that resolved as a microtask would satisfy the shape of a batching loop and starve the server
 * anyway. This creates the opportunity; it does not promise that any particular request runs.
 *
 * `Effect.async` rather than a detached promise, so an interruption during the pause cancels the
 * pending immediate instead of leaving a timer that fires into a torn-down runtime.
 *
 * Shared by every bounded background pass in this capability rather than reimplemented per loop. Two
 * copies of "let the poll phase run" would be two things that could drift, and the consequence of the
 * weaker one is a stalled server rather than a visible bug.
 */
export const yieldToEventLoop: Effect.Effect<void> = Effect.async<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});
