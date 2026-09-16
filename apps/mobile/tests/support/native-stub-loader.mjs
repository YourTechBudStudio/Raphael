/**
 * Module hooks that let one React Native component be rendered under Node, and nothing more.
 *
 * Two jobs. `react-native` and `react-native-webview` resolve to the substitutes beside this file,
 * because the real ones need a native runtime. And `.tsx` is transformed with esbuild, because
 * Node's type stripping handles TypeScript syntax but not JSX.
 *
 * The hooks are synchronous and in-thread (`module.registerHooks`), so the substitutes and the
 * transform are ordinary imports rather than a second module graph in a worker.
 *
 * Test-only. It is registered by the test that needs it and never by anything that ships; the
 * architecture assertions would fail if production code could reach any of this.
 */

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'esbuild';

const SUBSTITUTES = new Map([
  ['react-native', new URL('./stubs/react-native.mjs', import.meta.url).href],
  ['react-native-webview', new URL('./stubs/react-native-webview.mjs', import.meta.url).href],
]);

/** Installs the hooks. Returns a handle whose `deregister()` removes them again. */
export const installNativeStubs = () =>
  registerHooks({
    resolve: (specifier, context, next) => {
      const substitute = SUBSTITUTES.get(specifier);
      if (substitute !== undefined)
        return { url: substitute, format: 'module', shortCircuit: true };
      return next(specifier, context);
    },
    load: (url, context, next) => {
      if (!url.endsWith('.tsx')) return next(url, context);

      const source = readFileSync(fileURLToPath(url), 'utf8');
      const result = transformSync(source, {
        loader: 'tsx',
        format: 'esm',
        target: 'es2022',
        jsx: 'automatic',
        jsxImportSource: 'react',
        sourcefile: url,
      });
      return { format: 'module', source: result.code, shortCircuit: true };
    },
  });
