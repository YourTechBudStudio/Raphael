/**
 * When a change of connection has to throw the navigation stack away.
 *
 * Every route behind the current one names a container by an id that belonged to the server
 * connected when it was pushed. After a change of connection those ids mean nothing - or, worse,
 * mean something else, because two servers can both have a container 3 - so the stack is retired
 * rather than walked back into.
 *
 * The rule is stated as a function because getting it wrong is invisible. The first version cleared
 * what it remembered whenever there was no active connection, which made reconnecting after a
 * disconnect look exactly like a first launch: no retirement, and a stack of the old server's routes
 * still sitting there to be walked back into. Remembering across the gap is the whole fix, and this
 * is where it can be proven rather than reasoned about.
 *
 * The first activation of a launch never retires anything. There is nothing behind the gate yet,
 * and a deep link that opened the app is waiting to be honoured.
 */

export interface RetirementMemory {
  /** The last activation this device actually ran under, remembered across being disconnected. */
  readonly lastActivation: number | null;
}

export const NO_RETIREMENT_MEMORY: RetirementMemory = { lastActivation: null };

export interface RetirementStep {
  readonly memory: RetirementMemory;
  readonly retire: boolean;
}

export const nextRetirement = (
  memory: RetirementMemory,
  activation: number | null,
): RetirementStep => {
  // Being disconnected is not a change of server by itself: nothing new can be navigated to, and
  // what was remembered has to survive so the next connection is recognised as a change.
  if (activation === null) return { memory, retire: false };

  return {
    memory: { lastActivation: activation },
    retire: memory.lastActivation !== null && memory.lastActivation !== activation,
  };
};
