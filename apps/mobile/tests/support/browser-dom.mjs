/**
 * A simulated browser for the editor's own tests, and nothing else.
 *
 * `jsdom` is a test-only dependency. It never enters a bundle: the native graph has no DOM at all,
 * and the browser bundle runs in a real WebView. What it buys is that the editor tests drive the
 * actual TipTap editor, the actual commands and the actual history rather than a model of them.
 *
 * What it cannot buy is stated plainly: a simulated DOM proves nothing about real IME behaviour,
 * layout, or a mobile keyboard. Those belong to device evidence.
 */

import { JSDOM } from 'jsdom';

const GLOBALS = [
  'Node',
  'Element',
  'HTMLElement',
  'Document',
  'DocumentFragment',
  'DOMParser',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

/** Installs a document and returns the root the editor should mount into, plus a teardown. */
export const installDom = () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', {
    pretendToBeVisual: true,
  });

  const restore = [];
  const define = (name, value) => {
    const had = Object.hasOwn(globalThis, name);
    const previous = globalThis[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restore.push(() => {
      if (had)
        Object.defineProperty(globalThis, name, {
          value: previous,
          configurable: true,
          writable: true,
        });
      else Reflect.deleteProperty(globalThis, name);
    });
  };

  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  for (const name of GLOBALS) define(name, dom.window[name]);

  return {
    element: dom.window.document.getElementById('editor'),
    window: dom.window,
    teardown: () => {
      for (const undo of restore.reverse()) undo();
      dom.window.close();
    },
  };
};

/** A clock the test drives, so a debounce and a settle window are exact rather than hopeful. */
export const scheduler = () => {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    timers: {
      setTimer: (run, ms) => {
        next += 1;
        timers.set(next, { at: now + ms, run });
        return next;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
  };
};
