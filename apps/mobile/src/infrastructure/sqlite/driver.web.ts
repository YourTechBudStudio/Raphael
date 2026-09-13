/**
 * Web has no database, and this file is why `expo-sqlite` never enters the web bundle.
 *
 * Metro resolves this in place of `driver.ts` on web, so the native module and the browser worker
 * and wasm asset it drags behind it are not in the graph at all. That is a build-time fact rather
 * than a runtime check - the web bundle genuinely cannot resolve that asset, so a check inside a
 * function would come too late.
 *
 * Web is already an unsupported platform for this app: the connection gate shows an explanation
 * instead of the app. This keeps that true of the build as well as the screen.
 */

import type { SqlConnection, SqlDriver } from './port.ts';

export const SQLITE_SUPPORTED = false;

export const sqlDriver: SqlDriver = {
  open: (): Promise<SqlConnection> =>
    Promise.reject(new Error('This platform has no database for saved attempts.')),
};
