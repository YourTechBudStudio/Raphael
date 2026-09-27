/**
 * A process-wide, strictly increasing number, taken just before a read is sent.
 *
 * It orders reads by when they were *requested*, which a timestamp of when data *arrived* cannot do.
 * The favorite star uses it to decide whether a read can have seen a write the server has confirmed:
 * only a read requested after the confirmation can. A counter rather than a clock, so it never jumps
 * backwards and never ties.
 */

let last = 0;

export const nextReadStamp = (): number => (last += 1);
