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
 * The one way help tells someone to make a server key file. The file is owner-only before the key is
 * written into it: the umask makes a new file 0600, the chmod tightens one that already existed (a
 * plain `>` keeps an existing file's mode), and if the chmod fails nothing is written.
 */
export const SERVER_KEY_FILE_RECIPE = `(umask 077 && touch .env && chmod 600 .env && echo "${SERVER_API_KEY_VARIABLE}=$(openssl rand -hex 32)" > .env)`;
