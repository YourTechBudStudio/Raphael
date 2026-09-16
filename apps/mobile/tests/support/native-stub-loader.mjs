/**
 * Module hooks that let one React Native component be rendered under Node, and nothing more.
 *
 * Two jobs. The native packages resolve to the substitutes beside this file, because the real ones
 * need a native runtime, a bundler, or both. And `.tsx` is transformed with esbuild, because Node's
 * type stripping handles TypeScript syntax but not JSX.
 *
 * The substitutes are deliberately shallow. They exist so a component's own JavaScript can be driven
 * - which branch it takes, what it announces, what it calls back - and they are not a claim about
 * what a real device does with the same props. Anything that is genuinely about the platform belongs
 * in device evidence, not here.
 *
 * The hooks are synchronous and in-thread (`module.registerHooks`), so the substitutes and the
 * transform are ordinary imports rather than a second module graph in a worker.
 *
 * Test-only. It is registered by the test that needs it and never by anything that ships; the
 * architecture assertions would fail if production code could reach any of this.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'esbuild';

const SUBSTITUTES = new Map(
  [
    'react-native',
    'react-native-webview',
    'react-native-safe-area-context',
    'react-native-reanimated',
    'react-native-svg',
    'uniwind',
    'lucide-react-native',
    'expo-router',
    'react-native-gesture-handler',
    'expo-secure-store',
    'expo-sqlite',
    'expo-crypto',
    'expo-image',
  ]
    .map((specifier) => [specifier, new URL(`./stubs/${specifier}.mjs`, import.meta.url).href])
    // Subpath specifiers cannot name a file directly, so they are listed with their own file.
    .concat([['expo/fetch', new URL('./stubs/expo-fetch.mjs', import.meta.url).href]]),
);

/**
 * Metro's module resolution, for the two cases `src` relies on: a folder that means its `index.ts`,
 * and an import written without its extension.
 *
 * Node's resolver requires both to be spelled out. Rewriting several hundred imports across the app
 * to suit the test runner would be the tail wagging the dog, and would make the source disagree with
 * every other file in the repository. Resolving them here instead keeps the substitution in the one
 * place that already exists for it.
 */
const resolveLikeMetro = (specifier, parentURL) => {
  if (!specifier.startsWith('.') || parentURL === undefined) return undefined;

  const base = new URL(specifier, parentURL);
  const asPath = fileURLToPath(base);

  if (existsSync(asPath) && statSync(asPath).isDirectory()) {
    for (const index of ['index.ts', 'index.tsx']) {
      const candidate = new URL(`${specifier}/${index}`, parentURL);
      if (existsSync(fileURLToPath(candidate))) return candidate.href;
    }

    return undefined;
  }

  if (existsSync(asPath)) return undefined;

  for (const extension of ['.ts', '.tsx']) {
    const candidate = new URL(`${specifier}${extension}`, parentURL);
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }

  return undefined;
};

/** Installs the hooks. Returns a handle whose `deregister()` removes them again. */
export const installNativeStubs = () =>
  registerHooks({
    resolve: (specifier, context, next) => {
      const substitute = SUBSTITUTES.get(specifier);
      if (substitute !== undefined)
        return { url: substitute, format: 'module', shortCircuit: true };

      // No `format`: Node infers it, which is what keeps a `.ts` file going through its own type
      // stripping rather than being read as plain JavaScript.
      const metro = resolveLikeMetro(specifier, context.parentURL);
      if (metro !== undefined) return { url: metro, shortCircuit: true };

      return next(specifier, context);
    },
    load: (url, context, next) => {
      // `.ts` under `src` may also carry JSX-adjacent syntax Node's stripper accepts, so only `.tsx`
      // needs the transform; everything else keeps Node's own handling.
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
