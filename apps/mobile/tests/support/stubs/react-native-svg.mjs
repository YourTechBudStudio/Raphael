/** Shapes render as inert nodes; nothing under test asserts on vector geometry. */
import { createElement } from 'react';

import { toDomProps } from './react-native.mjs';

const shape = (name) =>
  function Shape({ children, ...rest }) {
    return createElement('span', { 'data-svg': name, ...toDomProps(rest) }, children);
  };

export const Path = shape('path');
export const Circle = shape('circle');
export const Rect = shape('rect');
export const G = shape('g');
export const Defs = shape('defs');
export const ClipPath = shape('clipPath');
export const LinearGradient = shape('linearGradient');
export const Stop = shape('stop');

export default shape('svg');
