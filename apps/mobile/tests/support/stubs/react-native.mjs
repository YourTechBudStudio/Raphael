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
  'submitBehavior',
  'onSubmitEditing',
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
        // Both states are carried, not only the true one: "this control is not busy" is a claim a
        // test needs to be able to make about a toggle whose write has settled.
        if (value.busy !== undefined) dom['aria-busy'] = String(value.busy);
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
/**
 * A scroll view that renders its refresh control, so a test can pull to refresh (`pullToRefresh`).
 */
export const ScrollView = function ScrollView({ children, refreshControl, ...rest }) {
  return createElement(
    'div',
    { 'data-scrollview': true, ...toDomProps(rest) },
    refreshControl ?? null,
    children,
  );
};
/**
 * A text field a test can actually type into.
 *
 * `onChangeText` is React Native's, and the DOM has no such event, so it is translated the way the
 * accessibility props are: a real `change` carries its value through. `onSubmitEditing` becomes
 * Enter, which is what the platform does with the return key.
 *
 * Its measured cap is surfaced as `data-max-height` because `style` is otherwise dropped, and a
 * field whose height follows the text scale has nothing else a test could observe. Only that one
 * value is exposed; the rest of the style stays off the DOM, where it would mean nothing.
 */
export const TextInput = function TextInput({
  children,
  editable,
  multiline,
  onChangeText,
  onSubmitEditing,
  style,
  value,
  ...rest
}) {
  const flattened = StyleSheet.flatten(style) ?? {};

  // A multiline field is a textarea, because a single-line `input` silently strips the line breaks
  // out of its own value - which would hide exactly the input the title's normalization exists for.
  return createElement(
    multiline === true ? 'textarea' : 'input',
    {
      'data-textinput': true,
      ...toDomProps(rest),
      // A field that takes no writing is one a test has to be able to tell apart.
      ...(editable === false ? { readOnly: true } : {}),
      ...(flattened.maxHeight === undefined ? {} : { 'data-max-height': flattened.maxHeight }),
      value: value ?? '',
      onChange:
        onChangeText === undefined ? undefined : (event) => onChangeText(event.target.value),
      onKeyDown:
        onSubmitEditing === undefined
          ? undefined
          : (event) => {
              if (event.key === 'Enter') onSubmitEditing();
            },
    },
    children,
  );
};
export const KeyboardAvoidingView = passThrough('div', 'data-kav');
export const ActivityIndicator = passThrough('div', 'data-activity');
/**
 * The pull-to-refresh control: says whether it is refreshing, and holds the handler a pull would run.
 * Nothing a person can click, because a pull is not a click.
 */
export const RefreshControl = ({ refreshing, onRefresh }) =>
  createElement('div', {
    'data-refresh': true,
    'data-refreshing': String(refreshing === true),
    ref: (node) => {
      if (node !== null) node.pull = onRefresh;
    },
  });

/** Pulls the first refresh control inside `container`, as a person dragging the screen down would. */
export const pullToRefresh = (container) => {
  const control = container.querySelector('[data-refresh]');

  if (control === null || typeof control.pull !== 'function') {
    throw new Error('nothing on screen can be pulled to refresh');
  }
  control.pull();
};
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

/**
 * Foreground and background, driven by a test.
 *
 * Real enough to prove a listener is registered and removed with its screen. What a phone actually
 * does between `inactive` and a killed process is device evidence and is not claimed here.
 */
const appStateListeners = new Set();

export const setAppState = (next) => {
  AppState.currentState = next;
  for (const listener of appStateListeners) listener(next);
};

export const AppState = {
  currentState: 'active',
  addEventListener: (event, listener) => {
    if (event === 'change') appStateListeners.add(listener);

    return {
      remove: () => {
        appStateListeners.delete(listener);
      },
    };
  },
};

/**
 * Android's system Back, as a listener a test can fire.
 *
 * Real enough to prove the composer intercepts it and gives it up with the screen. What a device
 * does with the gesture, and what a swipe-back does on iOS, is device evidence.
 */
const backListeners = new Set();

export const pressSystemBack = () => {
  // Newest first, which is how Android delivers it: the topmost handler gets the first refusal.
  for (const listener of [...backListeners].reverse()) {
    if (listener() === true) return true;
  }

  return false;
};

export const BackHandler = {
  addEventListener: (event, listener) => {
    if (event === 'hardwareBackPress') backListeners.add(listener);

    return {
      remove: () => {
        backListeners.delete(listener);
      },
    };
  },
};

/** Overridden per test to drive the column-collapse threshold. */
let dimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };

export const setWindowDimensions = (next) => {
  dimensions = { ...dimensions, ...next };
};

export const useWindowDimensions = () => dimensions;

/**
 * Enough of `Animated` to let a timed notice run under Node.
 *
 * Values are plain holders and `timing` completes on the next turn rather than over its duration:
 * these tests are about what a component *says* and *calls back*, and a fake clock driving a real
 * animation would be testing the substitute. What a transition looks like is device evidence.
 */
class AnimatedValue {
  constructor(value) {
    this.value = value;
  }

  interpolate() {
    return this;
  }
}

const timing = (value, config) => ({
  start: (done) => {
    value.value = config.toValue;
    if (typeof done === 'function') done({ finished: true });
  },
});

export const Animated = {
  Value: AnimatedValue,
  View: passThrough('div', 'data-animated'),
  Text: passThrough('span', 'data-animated-text'),
  timing,
  multiply: (value) => value,
};

export const Easing = {
  in: (fn) => fn,
  out: (fn) => fn,
  ease: (value) => value,
};

export const StyleSheet = {
  create: (styles) => styles,
  flatten: (style) => (Array.isArray(style) ? Object.assign({}, ...style.flat()) : style),
};
