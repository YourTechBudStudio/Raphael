/**
 * What a note card needs, published on its own, for capabilities that only map a server summary.
 *
 * A second public entry point beside `index.ts`, and the reason is the module graph rather than
 * taste. `index.ts` publishes the cards, the grid and the sections, so everything it reaches is a
 * React Native component - and a capability that only needs to turn a `NodeSummary` into the shape a
 * card is drawn from would have to pull the whole renderer in to get it. Search does exactly that:
 * its request builder maps hits, it is a pure module with no presentation in it, and its unit tests
 * run it directly in Node, where importing the renderer half is not merely heavy but impossible.
 *
 * So this file exports the summary projection and nothing else: no components, no queries, no cache.
 * It is a leaf, which is what makes it safe for another capability to depend on. `index.ts`
 * re-exports the same names, so there is one definition of what a note summary is rather than two
 * that could drift.
 *
 * The rule it must keep, which `architecture.test.mjs` checks: nothing this reaches may reach back
 * into a capability that imports it. The extension on the re-export below is load-bearing for the
 * same reason the file is: Node resolves this path for real when a unit test reaches through it.
 */

export { toNoteSummaryItem, type NoteSummaryItem } from './client/summary.ts';
