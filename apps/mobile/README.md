# Raphael mobile

The Expo SDK 57 phone client for Raphael, built with Expo Router, Uniwind (Tailwind v4 classes), Reanimated, TanStack Query, and Zustand.

This is currently a front-end-only mock. Areas, projects, notes, favorites, and active project selections come from an in-memory repository with simulated latency; nothing is persisted and nothing talks to a backend yet. Anything you capture lives until the app reloads.

## Home and Browse

Home starts with full-width Active projects cards, followed by recent notes. The Active button adds or removes a project from this section; its label stays Active while the highlighted icon indicates selection. There is no count limit, automatic expiry, or connection to its favorite star. Two or three projects fit together on a typical phone; larger selections and larger text sizes scroll normally.

Browse opens on All each time. Favorites is a separate tab for starred areas and projects, with readable full-width shortcuts; switch using the tabs or swipe horizontally through the list. Switching tabs or reopening Browse clears the filter. Notes and other resource shortcuts are not supported by the mock yet.

Active status is deliberate and remains unchanged until edited during the mock session. Like the rest of this mock repository, selections reset to the fixtures on reload; durable storage is not implemented yet.

## Development

Install dependencies with `pnpm install` from the repository root, then start the app yourself:

```sh
pnpm --filter @raphael/mobile start
```

Use `pnpm --filter @raphael/mobile ios` or `pnpm --filter @raphael/mobile android` to open a simulator or emulator. `pnpm --filter @raphael/mobile web` provides a browser preview, not the planned standalone web client. Physical devices require a matching Expo Go version or a development build.

## Layout

- `src/app` — Expo Router routes: Home, `area/[id]`, `project/[id]`, and `search` as a modal.
- `src/modules` — capability modules with explicit `index.ts` interfaces and colocated `components/`, `client/`, and `state/` where needed. Home, collections, Browse, search, capture, resources, playback, and navigation each have a named owner.
- `src/infrastructure` — shared backend contracts and bindings, the app-wide QueryClient, and the temporary mock backend and fixtures. Module clients use the API binding rather than importing mocks.
- `src/ui` — shared presentation primitives and layouts. Product-aware resource cards and collection tiles live in their owning modules. `global.css` defines the color, font, and radius tokens; `src/ui/theme.ts` mirrors them for SVG and shadows.

Start with the relevant module's `index.ts`, then follow its implementation locally. Server projections stay in React Query, shared client state stays in Zustand, and component-local state stays in React. Navigation owns the one-open-sheet rule; playback owns the single playback session. See [package guidance](./AGENTS.md) for ownership and import rules.

## Verification

```sh
pnpm --filter @raphael/mobile check
```

This lints, exports iOS/Android/web bundles, typechecks, runs regression and module-boundary tests, and checks formatting. Exporting bundles is not a native compilation or device smoke test. Run `pnpm check` at the repository root to verify the full workspace.
