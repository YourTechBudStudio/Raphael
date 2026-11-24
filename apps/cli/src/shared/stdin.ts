/**
 * Reading standard input under a byte budget, abandoned on a signal.
 *
 * The bound is counted as bytes arrive. Reading everything and measuring afterwards would be a bound
 * that does not bound anything. A signal ends the wait: the input is abandoned and the caller ends as
 * interrupted. Destroying the stream is what releases the loop; a paused one would hold it forever.
 */

import { Interrupted, interruptionOf } from './interrupt.ts';

export const readStandardInput = async (options: {
  readonly limit: number;
  /** The error for input past the limit. */
  readonly tooLarge: () => Error;
  readonly signal?: AbortSignal | undefined;
  readonly input?: NodeJS.ReadableStream & { destroy?: () => void };
}): Promise<Buffer> => {
  const { signal } = options;
  const input = options.input ?? process.stdin;
  const chunks: Buffer[] = [];
  let total = 0;
  const interrupted = (): Interrupted =>
    signal === undefined ? new Interrupted('SIGINT') : interruptionOf(signal);
  // A function, not a property test: `aborted` flips while this code is suspended.
  const aborted = (): boolean => signal?.aborted === true;
  if (aborted()) throw interrupted();
  const abandon = (): void => {
    input.destroy?.();
  };
  signal?.addEventListener('abort', abandon, { once: true });
  try {
    for await (const chunk of input) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      total += buffer.byteLength;
      if (total > options.limit) throw options.tooLarge();
      chunks.push(buffer);
    }
  } catch (error) {
    if (aborted()) throw interrupted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abandon);
  }
  if (aborted()) throw interrupted();
  return Buffer.concat(chunks);
};
