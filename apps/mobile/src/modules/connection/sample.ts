import type { Connection } from './state/connection';

/**
 * A stand-in server, so the screens behind the connection gate have something plausible to render
 * while there is nothing to connect to.
 *
 * Used only by development-only preview controls. Phase 09 removes it with them.
 */
export const SAMPLE_CONNECTION: Connection = {
  base: 'https://pi.local:4000',
  origin: 'https://pi.local:4000',
  protocolVersion: 1,
  remembered: true,
};
