# Mobile

## What this is

Raphael's Expo React Native app for Android and iOS.

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
    api/                    # Backend bindings: the transport factory and session-only content
    query/                  # QueryClient setup, connection-scoped keys, and the failure adapter
    sqlite/                 # The SQL port, the migration runner, and the platform-split driver
    mocks/                  # Session-only local content, behind the api boundary
```

## Rules

- Optimize for local reasoning: an agent should usually understand a feature by reading its capability module and a few explicit dependency interfaces, not reconstructing behavior across global technical layers.
- Organize modules around capabilities, not necessarily individual screens. Keep related UI, state, queries, and mutations together.
- Expose narrow, meaningful interfaces through each module's `index.ts`. Cross-module consumers must not reach into private components, stores, or query keys. Avoid chains of forwarding wrappers.
- Create internal files and directories only when they earn their place; the tree is not mandatory scaffolding for every module.
- Keep `app/` focused on routes, providers, and root composition. Product behavior belongs in modules.
- Put capability-specific queries, mutations, and backend integration in the module's `client/` directory. Keep shared transport and runtime wiring in infrastructure; do not move product decisions there.
- Do not mirror server data into Zustand. State ownership follows the capability responsible for its behavior, not the number of consumers. Resolve cross-capability coordination when concrete requirements arise.
- Use `ui/` for genuinely shared presentation. Reuse should prevent meaningful drift without turning shared UI into a home for unrelated product behavior.
