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
 * Measured, not assumed. The phase 08 native probe ran the transport's guarantees through this
 * implementation on an Android emulator against a real server and controlled listeners: redirects are
 * refused before the credential is replayed, an overrunning body is cut off at the ceiling, stalled
 * headers time out, and cancellation works both before headers and mid-body. `FetchResponse.type` is
 * hard-coded to `'default'`, so the transport's `opaqueredirect` test can never fire here and the 3xx
 * status check is the only redirect defence on this runtime - which the probe confirmed is enough.
 * iOS was not exercised. The probe and its harness live in `tests/native-probe/`.
 */

import type { FetchLike } from '@raphael/client';
import { fetch as expoFetch } from 'expo/fetch';

export const appFetch: FetchLike = expoFetch;
