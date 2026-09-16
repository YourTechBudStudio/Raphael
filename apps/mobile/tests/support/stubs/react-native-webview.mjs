/**
 * A WebView that records what was injected and hands its props back to the test.
 *
 * It renders nothing meaningful and runs no script: the point is which props the host set, which
 * callbacks it wired, and what it injected through the imperative handle.
 */

import { createElement, useEffect, useImperativeHandle, useRef } from 'react';

/** Every instance that has mounted, in order. A remount under a new `key` appends. */
export const webViews = [];

export const resetWebViews = () => {
  webViews.length = 0;
};

export function WebView(props) {
  const instance = useRef(null);
  instance.current ??= {
    injected: [],
    mounted: true,
    props,
    injectJavaScript(script) {
      this.injected.push(script);
    },
  };
  instance.current.props = props;

  useImperativeHandle(props.ref, () => instance.current, []);

  useEffect(() => {
    const self = instance.current;
    webViews.push(self);
    return () => {
      self.mounted = false;
    };
  }, []);

  return createElement('div', { 'data-webview': true });
}
