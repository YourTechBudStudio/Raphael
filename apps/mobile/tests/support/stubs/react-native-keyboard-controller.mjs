/**
 * The keyboard, never raised.
 *
 * Every view that makes room for the keyboard renders as a plain container, and the keyboard reports
 * itself closed, so a test observes the resting layout. Whether room is made on a device, and how it
 * moves, is device evidence and is not claimed here.
 */

import { createElement } from 'react';

import { toDomProps } from './react-native.mjs';

export const KeyboardProvider = ({ children }) => createElement('div', null, children);

export function KeyboardAvoidingView({ children, behavior: _behavior, ...rest }) {
  return createElement('div', { 'data-kav': true, ...toDomProps(rest) }, children);
}

export const useReanimatedKeyboardAnimation = () => ({
  height: { value: 0 },
  progress: { value: 0 },
});
