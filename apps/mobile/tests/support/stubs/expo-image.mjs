/** An image that renders as a span. These tests are about text, names and state, not pixels. */
import { createElement } from 'react';

export const Image = ({ children, ...rest }) =>
  createElement('span', { 'data-image': true, ...rest }, children);
