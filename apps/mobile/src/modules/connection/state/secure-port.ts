/**
 * The real secure store, and the honest answer where there is not one.
 *
 * `expo-secure-store` is the Keychain on iOS and the Keystore-backed shared preferences on
 * Android. It has no web implementation, and the alternatives on that platform - `localStorage`,
 * a cookie, IndexedDB - are readable by any script that runs on the origin. None of them is a
 * place to put a key that grants full access to someone's second brain, so the web build reports
 * the platform as unsupported and says so on screen rather than storing the key somewhere weaker
 * and calling it saved.
 *
 * This is the only file in the capability that imports the platform. Everything else takes a port.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { SecurePort } from './storage';

/**
 * One entry, holding the whole record.
 *
 * The name is stable across versions of the record, because the version lives inside the value.
 * Changing the key name would strand an old record where nothing ever looks for it, which reads to
 * the person holding the phone as their connection vanishing for no reason.
 */
const ENTRY = 'raphael.connection';

export const securePort: SecurePort =
  Platform.OS === 'web'
    ? { kind: 'unsupported' }
    : {
        kind: 'available',
        get: () => SecureStore.getItemAsync(ENTRY),
        set: (value) => SecureStore.setItemAsync(ENTRY, value),
        remove: () => SecureStore.deleteItemAsync(ENTRY),
      };

/** Whether this platform can keep a credential at all. Drives the setup screen, not a fallback. */
export const SECURE_STORAGE_SUPPORTED = securePort.kind === 'available';
