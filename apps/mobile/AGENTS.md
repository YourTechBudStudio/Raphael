# Mobile

## What this is

Raphael's Expo React Native app for Android and iOS. Areas and projects are read from and created on the connected Raphael server through `@raphael/client`. Creation attempts are kept in a local SQLite database so an unfinished one survives the process; notes, favorites, and active-project selections have no server operation yet and are kept in memory for the session, scoped to the connection, and nothing in the app may present those as saved.

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

Current modules: `connection` owns the server connection, its secure storage, and the transition between one connection and the next; `home` composes the feed and active projects; `collections` owns the hierarchy query, area/project screens, container creation and its durable attempt records, favorites, and active selection; `browse` owns tree browsing; `search` owns scoped search; `capture` owns text/voice capture; `resources` owns resource presentation and the one session-only notes query; `playback` owns shared playback; `navigation` owns route helpers, navigation chrome, and the mutually exclusive sheet state.

## Rules

- Optimize for local reasoning: an agent should usually understand a feature by reading its capability module and a few explicit dependency interfaces, not reconstructing behavior across global technical layers.
- Organize modules around capabilities, not necessarily individual screens. Keep related UI, state, queries, and mutations together.
- Expose narrow, meaningful interfaces through each module's `index.ts`. Cross-module consumers must not reach into private components, stores, or query keys. Avoid chains of forwarding wrappers.
- Create internal files and directories only when they earn their place; the tree is not mandatory scaffolding for every module.
- Keep `app/` focused on routes, providers, and root composition. Product behavior belongs in modules.
- Put capability-specific queries, mutations, and backend integration in the module's `client/` directory. Keep shared transport and runtime wiring in infrastructure; do not move product decisions there.
- Keep cache maintenance behind capability interfaces. UI callers should not coordinate other modules' private cache details. Use the app-wide QueryClient rather than creating isolated caches per module. A successful note write calls `invalidateResources` through the resources module; a successful container write is handled inside collections, which seeds and invalidates together and fences both by the activation the write was made under.
- Container creation has one dispatcher, app-scoped, in `modules/collections/creation/`. Nothing outside that capability may import it. Persist the attempt before sending it, persist the answer before presenting it, and delete a record only once it has been consumed - never because a refresh succeeded or failed.
- `mutationOutcome` describes one HTTP attempt. An attempt that has ever been uncertain stays unresolved through any later rejection or non-dispatch; `logicalStateOf` is the only thing that decides what a record means, and no screen reads its state string to work that out.
- A frozen request is never rewritten. Validate a stored one before replaying it, and where this build would decode or normalize it differently, keep the record and refuse to send rather than migrating the payload.
- Reach SQLite through `infrastructure/sqlite`. `expo-sqlite` is named only by `driver.ts`, with `driver.web.ts` beside it, because Metro walks a dynamic import when it builds the web graph and a runtime platform check comes too late.
- Never silently reset, recreate, or downgrade a local database, and never fall back to memory when it cannot be opened. "There is nothing unfinished" and "Raphael cannot read its record of unfinished work" are different sentences and need different surfaces.
- Build every server query key with `scopeKey` from `infrastructure/query`, and capture the session's transport in the query function rather than reading the current one when it runs. Two servers can mint the same numeric id, so an unstamped key is not a description of anything.
- Return a `ClientResult` failure through `unwrap` so it throws; never cache `{ ok: false }` as data.
- The API key lives in the connection capability and travels only inside a transport closure. It must not reach a screen, a log, a query key, persisted state, or a navigation parameter.
- Local records reference containers by `{ type, id }` and never copy a server title, slug, or parent. Missing or failed hierarchy data is not deletion: never reap a local reference because a read failed.
- A note's destination is always chosen explicitly. There is no default area, no inbox, and no inference from the current screen.
- Do not mirror server data into Zustand. State ownership follows the capability responsible for its behavior, not the number of consumers. Resolve cross-capability coordination when concrete requirements arise.
- Use `ui/` for genuinely shared presentation. Reuse should prevent meaningful drift without turning shared UI into a home for unrelated product behavior.
- Keep mocks behind the backend integration boundary. Feature UI must not import mock repositories or fixtures directly. Do not preserve obsolete mock compatibility when real backend integration replaces it.
- Apply the repository's Effect guidance at effectful boundaries where it provides useful failure, lifecycle, or concurrency guarantees; do not wrap presentation or pure helpers merely for uniformity.
