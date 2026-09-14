/**
 * The fetch implementation this app hands to the shared client, chosen rather than inherited.
 *
 * The shared transport reads responses incrementally under a size ceiling, so it requires a real
 * `ReadableStream` body. Two implementations are reachable on this runtime and only one of them
 * satisfies that: Expo installs `expo/fetch` as the global `fetch` unless `EXPO_PUBLIC_USE_RN_FETCH`
 * is set, in which case the global is React Native's XHR-backed polyfill, whose `body` is not a
 * stream. Reading the global would therefore make a security- and correctness-relevant dependency a
 * function of an environment variable and of module evaluation order. Importing the implementation
 * directly is the whole point of this file.
 *
 * Expo's `FetchResponse.type` is hard-coded to `'default'`, so the shared transport relies on
 * its 3xx status check to reject redirects on this runtime.
 */

import type { FetchLike } from '@raphael/client';
import { fetch as expoFetch } from 'expo/fetch';

export const appFetch: FetchLike = expoFetch;
