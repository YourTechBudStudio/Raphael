/**
 * The transport's time bounds.
 *
 * What these do: stop a connection from occupying the server indefinitely while doing nothing. A peer
 * can open a socket and never finish its headers, trickle a body a byte at a time, hold a keep-alive
 * connection open forever, or accept a response so slowly that it is never delivered. Every one of
 * those is transport work, none of them reaches SQLite, and all of them are bounded here.
 *
 * What these do not do, and must never be described as doing: bound *execution*. Content conversion
 * and SQLite are synchronous and run on this thread. While one of them runs, no timer fires, because
 * timers are event-loop work and the event loop is not running. A deadline is therefore the
 * configured duration plus however long the loop takes to reach it, not a wall-clock guarantee - and
 * a slow operation is not something the transport can interrupt.
 *
 * These are fixed constants rather than configuration. Each one is a property of the protocol rather
 * than of an installation, and adding six knobs would mean six more values to validate and six more
 * ways for a server to be configured into a state nobody tested. Tests inject shorter durations
 * directly; none of that reaches the YAML surface.
 */

export interface Deadlines {
  /** Time to receive a complete set of request headers. */
  readonly headersMs: number;
  /** Time to receive a complete request, headers and body. Not the time to *process* it. */
  readonly requestMs: number;
  /** Time an idle keep-alive connection is kept before it is closed. */
  readonly keepAliveMs: number;
  /** Time a socket may be inactive in either direction before it is destroyed. */
  readonly socketIdleMs: number;
  /**
   * Time to finish delivering a response, measured from the first write.
   *
   * Inactivity alone does not bound this: a peer that reads one byte at a time is active and can hold
   * a response open indefinitely. On expiry the connection is destroyed - the headers are already
   * sent, so there is no envelope left to write, and the truthful signal is a truncated response.
   */
  readonly responseMs: number;
  /**
   * How long shutdown waits for in-flight requests to finish before closing connections underneath
   * them. Cooperative: it cannot fire while synchronous work holds the thread.
   */
  readonly drainMs: number;
  /**
   * How often Node checks connections against `headersMs` and `requestMs`.
   *
   * Node's default is 30 seconds, which would make a 10-second header deadline fire up to 40 seconds
   * late - the deadline would be set and effectively not enforced. One second keeps the observed
   * behavior close to the stated one, at the cost of one periodic timer per server.
   */
  readonly checkIntervalMs: number;
}

export const DEFAULT_DEADLINES: Deadlines = {
  headersMs: 10_000,
  requestMs: 30_000,
  keepAliveMs: 5_000,
  socketIdleMs: 60_000,
  responseMs: 30_000,
  drainMs: 10_000,
  checkIntervalMs: 1_000,
};
