/**
 * What an exit code means here, defined once.
 *
 * The distinction that earns its keep is 2 versus 1. **2 means the command was wrong** - a flag that
 * does not exist, a selector that is not an address, a configuration that cannot be used. Nothing was
 * sent and nothing is pending. **1 means the command was right and the work did not succeed** - the
 * server refused, the connection failed, the outcome is unknown. A script can branch on that:
 * retrying a 2 will fail identically forever, while a 1 may be worth another look.
 *
 * Signals get their conventional codes so a shell reports what actually happened. They are only used
 * for *forced* termination, where cleanup did not finish; an orderly shutdown after a first signal is
 * an ordinary success and exits 0.
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export type ExitCode = 0 | 1 | 2 | 130 | 143;
