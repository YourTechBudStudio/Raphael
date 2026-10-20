import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OperationCall, Transport } from '../shared/transport.ts';
import {
  addFavorite,
  archive,
  create,
  get,
  getPath,
  list,
  listFavorites,
  move,
  removeFavorite,
  restore,
  search,
  update,
} from './index.ts';

/** A transport that records what each capability declared, and answers nothing useful. */
const recording = (): { transport: Transport; effects: string[] } => {
  const effects: string[] = [];
  const transport: Transport = {
    endpoint: { base: 'http://raphael.invalid', origin: 'http://raphael.invalid' },
    timeoutMs: 15_000,
    invoke: async <A>(call: OperationCall<A>) => {
      effects.push(call.effect);
      return {
        ok: false,
        failure: { kind: 'network', effect: call.effect, delivery: 'not_sent', message: '' },
      };
    },
  };
  return { transport, effects };
};

describe('each capability declares whether it writes', () => {
  const target = { target: { id: 1 } };
  const cases: ReadonlyArray<
    readonly [string, (transport: Transport) => Promise<unknown>, string]
  > = [
    [
      'create',
      (t) => create(t, { type: 'area', parent: { path: '/' }, slug: 'a', title: 'A' }),
      'write',
    ],
    ['update', (t) => update(t, { ...target, revision: 1, title: 'A' }), 'write'],
    ['move', (t) => move(t, { ...target, revision: 1, destination: { path: '/b' } }), 'write'],
    ['archive', (t) => archive(t, { ...target, revision: 1 }), 'write'],
    ['restore', (t) => restore(t, { ...target, revision: 1 }), 'write'],
    ['addFavorite', (t) => addFavorite(t, target), 'write'],
    ['removeFavorite', (t) => removeFavorite(t, target), 'write'],
    ['get', (t) => get(t, target), 'read'],
    ['getPath', (t) => getPath(t, target), 'read'],
    ['list', (t) => list(t, { scopes: [{ path: '/' }] }), 'read'],
    ['search', (t) => search(t, { scopes: [{ path: '/' }], queries: ['a'] }), 'read'],
    ['listFavorites', (t) => listFavorites(t, {}), 'read'],
  ];
  for (const [name, send, effect] of cases) {
    it(`${name} is a ${effect}`, async () => {
      const { transport, effects } = recording();
      await send(transport);
      assert.deepEqual(effects, [effect]);
    });
  }
});
