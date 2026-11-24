/**
 * The environment variables this CLI names, defined once for code and help alike.
 *
 * The clients' pair and the server's key are different variables on purpose: a shell that starts a
 * server and then runs client commands would otherwise hold half of the clients' pair. The server's
 * name is the backend's, restated here only because help must render without loading the backend; a
 * test holds the two equal.
 */

export const CLIENT_ENDPOINT_VARIABLE = 'RAPHAEL_ENDPOINT';
export const CLIENT_API_KEY_VARIABLE = 'RAPHAEL_API_KEY';
export const TIMEOUT_VARIABLE = 'RAPHAEL_TIMEOUT';
export const SERVER_API_KEY_VARIABLE = 'RAPHAEL_SERVER_API_KEY';

/**
 * The one way help tells someone to make a server key file. It never touches an existing `.env`,
 * which may hold other settings or the key clients already use: it says so and stops. A new file is
 * owner-only from the moment it exists, because the umask applies when the redirect creates it, and
 * `set -C` (noclobber) makes the redirect itself refuse a file that appeared since the check, or a
 * link at `.env`.
 */
export const SERVER_KEY_FILE_RECIPE = `[ -e .env ] && echo ".env already exists; add ${SERVER_API_KEY_VARIABLE} to it yourself." >&2 || (umask 077 && set -C && echo "${SERVER_API_KEY_VARIABLE}=$(openssl rand -hex 32)" > .env)`;
