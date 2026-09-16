/**
 * Motion, flattened.
 *
 * Every animation resolves instantly to its target and reduced motion is reported as on, so a test
 * observes the settled appearance. Motion is a device concern and is not what these tests are about;
 * what matters is that a component that animates still renders, still announces itself, and still
 * calls back. Timing, easing and interpolation belong in device evidence.
 */

import { createElement } from 'react';

import { toDomProps } from './react-native.mjs';

const animated = (tag, marker) =>
  function Animated({ children, ...rest }) {
    return createElement(tag, { [marker]: true, ...toDomProps(rest) }, children);
  };

const AnimatedView = animated('div', 'data-animated');

export const useAnimatedStyle = (factory) => factory();
export const useAnimatedProps = (factory) => factory();
export const useSharedValue = (value) => ({ value });
export const withSpring = (value) => value;
export const withTiming = (value) => value;
export const withSequence = (...values) => values[values.length - 1];
export const withRepeat = (value) => value;
export const cancelAnimation = () => undefined;
export const interpolateColor = (_value, _input, output) => output[0];
export const runOnJS = (fn) => fn;
export const interpolate = (_value, _input, output) => output[0];

/** Layout and entering animations are identity descriptors; nothing under test inspects them. */
const descriptor = () => {
  const self = {
    duration: () => self,
    delay: () => self,
    easing: () => self,
    springify: () => self,
    build: () => () => ({ initialValues: {}, animations: {} }),
  };

  return self;
};

export const FadeIn = descriptor();
export const LinearTransition = descriptor();
export const useReducedMotion = () => true;
export const Easing = {
  bezier: () => (t) => t,
  out: (fn) => fn,
  in: (fn) => fn,
  inOut: (fn) => fn,
  ease: (t) => t,
  linear: (t) => t,
};

export default {
  View: AnimatedView,
  Text: animated('span', 'data-animated-text'),
  createAnimatedComponent: (Component) => Component,
};
