/**
 * What `server serve` uses when nothing says otherwise, for help and for hints that name a command.
 */

/**
 * The defaults and the YAML keys, as help states them. The backend's `CONFIG_DEFAULTS` is the
 * authority; this restates it only because help must render without loading the backend, and a test
 * holds the two equal.
 */
export const SERVE_DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  databasePath: './data/raphael.sqlite',
} as const;

/** The ports a configuration may ask for, restated from the backend's `CONFIGURED_PORT_RANGE`. */
export const SERVE_PORT_RANGE = { min: 1, max: 65_535 } as const;
