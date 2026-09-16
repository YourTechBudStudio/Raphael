/**
 * Gestures, inert.
 *
 * The real package reaches into Reanimated's module object at import time, which a substitute cannot
 * satisfy and which has nothing to do with what is under test here. Drag and swipe behaviour is
 * device evidence.
 */

import { createElement } from 'react';

import { toDomProps } from './react-native.mjs';

const passThrough = (marker) =>
  function Element({ children, ...rest }) {
    return createElement('div', { [marker]: true, ...toDomProps(rest) }, children);
  };

export const GestureHandlerRootView = passThrough('data-gesture-root');
export const GestureDetector = passThrough('data-gesture-detector');
export const ScrollView = passThrough('data-gesture-scroll');

const builder = () => {
  const self = new Proxy(
    {},
    {
      get: () => () => self,
    },
  );

  return self;
};

export const Gesture = {
  Pan: builder,
  Tap: builder,
  Simultaneous: builder,
  Race: builder,
};
