/**
 * A transport for the favorites tests that answers only when the test says so.
 *
 * Every request waits, in the order it was sent, until the test answers it by route. That is what
 * lets a test hold a refetch open while it looks at what the star shows, or fail one page of a list
 * while the pages before it stay. `signal` is ignored: nothing here is about cancellation, and the
 * behavior under test must hold when an answer simply arrives later.
 *
 * Plain data and no renderer, so each test installs its own DOM and native stubs before React loads.
 */

export const ADD = '/api/favorites/add';
export const REMOVE = '/api/favorites/remove';
export const LIST = '/api/favorites/list';

/** A favorite as a page carries it. Only the fields the phone reads differ between tests. */
export const summary = (id, over = {}) => ({
  id,
  type: 'area',
  kind: null,
  parentId: null,
  slug: `node-${String(id)}`,
  revision: 1,
  title: `Node ${String(id)}`,
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: true,
  ...over,
});

export const ok = (value) => ({ ok: true, value });

/** A favorites page answering the request it is for, so its window is the one that was asked. */
export const page = (body, items, hasMore = false) =>
  ok({ items, skip: body.skip, limit: body.limit, hasMore });

export const refused = () => ({
  ok: false,
  failure: { kind: 'http', status: 404, code: 'node_not_found', message: 'Node 3 does not exist.' },
});

export const unreachable = () => ({
  ok: false,
  failure: { kind: 'network', message: 'Unreachable.' },
});

export const onDemandServer = () => {
  const waiting = [];
  const asked = [];

  return {
    /** Every request sent, in order: `{ path, body }`. */
    asked,
    of: (path) => asked.filter((call) => call.path === path),
    inFlight: (path) => waiting.filter((call) => call.path === path).length,
    /** The body of the oldest request still waiting on `path`. */
    pending: (path) => waiting.find((call) => call.path === path)?.body,
    /** Answers the oldest request waiting on `path` with `reply(body)`. */
    settle: (path, reply) => {
      const index = waiting.findIndex((call) => call.path === path);
      if (index === -1) throw new Error(`nothing in flight for ${path}`);
      const [call] = waiting.splice(index, 1);
      call.resolve(reply(call.body));
    },
    /** Answers everything still waiting as unreachable, so nothing outlives its test. */
    drain: () => {
      for (const call of waiting.splice(0)) call.resolve(unreachable());
    },
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: (call) =>
        new Promise((resolve) => {
          asked.push({ path: call.route.path, body: call.body });
          waiting.push({ path: call.route.path, body: call.body, resolve });
        }),
    },
  };
};
