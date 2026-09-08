# Mobile

## What this is

Raphael's Expo React Native app for Android and iOS. The current UI uses in-memory mock data; the backend will own persistence and canonical server data.

## Tech stack

- Expo Router for routing and app composition.
- TanStack React Query for client caching of server state.
- Zustand for shared or independently lived client state.
- React state for component-local concerns such as inputs, focus, and measured layout.
- Uniwind and Tailwind CSS for styling. Follow the repository's design-system skill for visual and voice guidance.

## Structure

Organize by capability so a feature's behavior can be understood locally.

```text
src/
  app/                      # Thin Expo Router routes and root composition
  modules/
    <capability>/
      index.ts              # Deliberate public interface
      components/           # Capability-specific UI
      state/                # Zustand state owned by this capability
      client/               # Queries, mutations, and backend integration
  ui/                       # Shared components, layouts, and theme
  infrastructure/
    api/                    # Shared backend contracts and bindings
    query/                  # QueryClient setup
    mocks/                  # Temporary simulated backend and fixtures
```

Current modules: `home` composes the feed and active projects; `collections` owns area/project screens, contents, favorites, and active selection; `browse` owns tree browsing; `search` owns scoped search; `capture` owns text/voice capture; `resources` owns resource presentation and cache-refresh coordination; `playback` owns shared playback; `navigation` owns route helpers, navigation chrome, and the mutually exclusive sheet state.

## Rules

- Optimize for local reasoning: an agent should usually understand a feature by reading its capability module and a few explicit dependency interfaces, not reconstructing behavior across global technical layers.
- Organize modules around capabilities, not necessarily individual screens. Keep related UI, state, queries, and mutations together.
- Expose narrow, meaningful interfaces through each module's `index.ts`. Cross-module consumers must not reach into private components, stores, or query keys. Avoid chains of forwarding wrappers.
- Create internal files and directories only when they earn their place; the tree is not mandatory scaffolding for every module.
- Keep `app/` focused on routes, providers, and root composition. Product behavior belongs in modules.
- Put capability-specific queries, mutations, and backend integration in the module's `client/` directory. Keep shared transport and runtime wiring in infrastructure; do not move product decisions there.
- Keep cache maintenance behind capability interfaces. UI callers should not coordinate other modules' private cache details. Use the app-wide QueryClient rather than creating isolated caches per module. Queries containing resources opt into `resourceViewMeta`; successful resource writes call `invalidateResourceViews` through the resources module.
- Do not mirror server data into Zustand. State ownership follows the capability responsible for its behavior, not the number of consumers. Resolve cross-capability coordination when concrete requirements arise.
- Use `ui/` for genuinely shared presentation. Reuse should prevent meaningful drift without turning shared UI into a home for unrelated product behavior.
- Keep mocks behind the backend integration boundary. Feature UI must not import mock repositories or fixtures directly. Do not preserve obsolete mock compatibility when real backend integration replaces it.
- Apply the repository's Effect guidance at effectful boundaries where it provides useful failure, lifecycle, or concurrency guarantees; do not wrap presentation or pure helpers merely for uniformity.
