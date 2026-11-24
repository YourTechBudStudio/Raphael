/**
 * Loaded with `--import` before the CLI: `fetch` stands for a connection attempt to an address that
 * never accepts. Nothing ever answers, and like a real pending connect, the attempt keeps the event
 * loop alive long after the request was abandoned.
 */

globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  // The pending attempt, as the system holds it: alive for a minute whatever the caller does.
  setTimeout(() => {}, 60_000);
  return new Promise<never>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}) as typeof fetch;
