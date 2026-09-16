/**
 * Just enough of `react-native` for a handful of components to render under Node.
 *
 * Only what the components under test actually touch. This is not a React Native implementation and
 * is not a claim about platform behaviour: it exists so the JavaScript a component runs - which
 * branch it takes, what it announces, what it calls back - can be driven without a device.
 *
 * React Native's accessibility props are translated into the DOM's own, so a test can find a control
 * the way a screen reader would - by its name, its role, its state - rather than by a class name.
 * That translation is the reason these tests can say anything about accessibility at all; what a
 * real screen reader does with the same props is device evidence and is not claimed here.
 */

import { createElement } from 'react';

const ROLES = {
  header: 'heading',
  button: 'button',
  link: 'link',
  image: 'img',
  list: 'list',
  none: 'presentation',
  text: undefined,
  summary: undefined,
  adjustable: 'slider',
};

/** Props React Native understands and the DOM does not. Dropped rather than passed through. */
const NATIVE_ONLY = new Set([
  'accessible',
  'inset',
  'accessibilityActions',
  'accessibilityValue',
  'accessibilityElementsHidden',
  'importantForAccessibility',
  'onAccessibilityAction',
  'onHoverIn',
  'onHoverOut',
  'onLongPress',
  'onPressIn',
  'onPressOut',
  'onLayout',
  'hitSlop',
  'numberOfLines',
  'pointerEvents',
  'keyboardDismissMode',
  'keyboardShouldPersistTaps',
  'showsVerticalScrollIndicator',
  'scrollEventThrottle',
  'refreshControl',
  'placeholderTextColor',
  'multiline',
  'blurOnSubmit',
  'returnKeyType',
  'autoFocus',
  'editable',
  'behavior',
  'tintColor',
  'colors',
  'allowsLinkPreview',
  'hideKeyboardAccessoryView',
  'javaScriptEnabled',
  'source',
]);

/** Translates one React Native prop bag into DOM attributes a test can query. */
export const toDomProps = ({ style: _style, ...props }) => {
  const dom = {};

  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || NATIVE_ONLY.has(name)) continue;

    switch (name) {
      case 'accessibilityLabel':
        dom['aria-label'] = value;
        break;
      case 'accessibilityHint':
        dom['aria-description'] = value;
        break;
      case 'accessibilityLiveRegion':
        if (value !== 'none') dom['aria-live'] = value;
        break;
      case 'accessibilityRole': {
        const role = ROLES[value];
        if (role !== undefined) dom.role = role;
        break;
      }
      case 'accessibilityState':
        if (value.disabled === true) dom['aria-disabled'] = 'true';
        if (value.selected !== undefined) dom['aria-selected'] = String(value.selected);
        if (value.expanded !== undefined) dom['aria-expanded'] = String(value.expanded);
        break;
      case 'testID':
        dom['data-testid'] = value;
        break;
      case 'className':
        dom.className = value;
        break;
      default:
        dom[name] = value;
    }
  }

  return dom;
};

const passThrough = (tag, marker) =>
  function Element({ children, ...rest }) {
    return createElement(tag, { [marker]: true, ...toDomProps(rest) }, children);
  };

export const View = passThrough('div', 'data-view');
export const Text = passThrough('span', 'data-text');
export const ScrollView = passThrough('div', 'data-scrollview');
export const TextInput = passThrough('input', 'data-textinput');
export const KeyboardAvoidingView = passThrough('div', 'data-kav');
export const ActivityIndicator = passThrough('div', 'data-activity');
export const RefreshControl = passThrough('div', 'data-refresh');
export const Image = passThrough('span', 'data-image');

/** Renders inline rather than into a portal; `visible={false}` renders nothing, as it must. */
export const Modal = ({ children, visible = true, ...rest }) =>
  visible ? createElement('div', { 'data-modal': true, ...toDomProps(rest) }, children) : null;

export const Pressable = ({ children, onPress, disabled, ...rest }) =>
  createElement(
    'button',
    {
      'data-pressable': true,
      disabled: disabled === true,
      onClick: disabled === true ? undefined : onPress,
      ...toDomProps(rest),
    },
    typeof children === 'function' ? children({}) : children,
  );

export const Platform = { OS: 'ios', select: (options) => options.ios ?? options.default };

export const Alert = {
  calls: [],
  alert: (...args) => {
    Alert.calls.push(args);
  },
};

/** Whether a screen reader is reported as running. Set per test to drive the collapse. */
let screenReader = false;
const screenReaderListeners = new Set();

export const setScreenReaderEnabled = (enabled) => {
  screenReader = enabled;
  for (const listener of screenReaderListeners) listener(enabled);
};

export const AccessibilityInfo = {
  isScreenReaderEnabled: async () => screenReader,
  addEventListener: (event, listener) => {
    if (event === 'screenReaderChanged') screenReaderListeners.add(listener);

    return {
      remove: () => {
        screenReaderListeners.delete(listener);
      },
    };
  },
};

export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => undefined }),
};

/** Overridden per test to drive the column-collapse threshold. */
let dimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };

export const setWindowDimensions = (next) => {
  dimensions = { ...dimensions, ...next };
};

export const useWindowDimensions = () => dimensions;

export const StyleSheet = {
  create: (styles) => styles,
  flatten: (style) => (Array.isArray(style) ? Object.assign({}, ...style.flat()) : style),
};
