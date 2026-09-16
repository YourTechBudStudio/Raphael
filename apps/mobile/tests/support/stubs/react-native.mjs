/**
 * Just enough of `react-native` for one component to render under Node.
 *
 * Only what `EditorHost` actually touches. This is not a React Native implementation and is not a
 * claim about platform behaviour; it exists so the JavaScript wiring can be driven.
 */

import { createElement } from 'react';

export const View = ({ children, style: _style, ...rest }) =>
  createElement('div', { 'data-view': true, ...rest }, children);

export const Platform = { OS: 'ios', select: (options) => options.ios ?? options.default };
