/**
 * A database that is never opened.
 *
 * The component tests mount screens whose module graph reaches the native driver, and reaching it is
 * not the same as using it: nothing in those tests opens a database, because what they exercise is
 * which branch a gate renders. Opening one would be a claim about `expo-sqlite` on a device, which
 * is not something a substitute can make - the real store is exercised against `node:sqlite` in
 * `tests/`, through the same port.
 */

export const openDatabaseAsync = () => {
  throw new Error('a component test must not open a database');
};
