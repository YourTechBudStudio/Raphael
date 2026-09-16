/**
 * The bundle's entry point. It wires the runtime to the two things only the real WebView has: the
 * React Native message channel and the digest the generator stamped into the document.
 *
 * Nothing in the native graph imports this file, and Metro never sees it: it is compiled by
 * `scripts/build-editor.mjs` into the embedded document and by nothing else.
 */

import { createEditorRuntime } from './runtime.ts';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (raw: string) => void };
    __RAPHAEL_EDITOR_DIGEST__?: string;
    __raphaelEditor?: { receive: (raw: unknown) => void };
  }
}

const element = document.getElementById('editor');
if (element === null) throw new Error('editor root missing');

const runtime = createEditorRuntime({
  element,
  post: (raw) => window.ReactNativeWebView?.postMessage(raw),
  payloadDigest: window.__RAPHAEL_EDITOR_DIGEST__ ?? '',
});

// The host addresses exactly this name, and delivers a JSON string it parses as data.
window.__raphaelEditor = { receive: runtime.receive };

// Last, so a host that answers immediately finds a runtime that can receive.
runtime.announce();
