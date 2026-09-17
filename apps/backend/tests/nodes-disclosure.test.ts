import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

import {
  createNode,
  getNode,
  listNodes,
  toPublicError,
  updateNode,
  type NodeError,
} from '../src/modules/nodes/index.ts';
import { clockAt, expectLeft, expectRight, runNodes, withMigrated } from './support.ts';

/**
 * Sentinels chosen to look like private data. They appear as submitted values *and* as arbitrary
 * property names, because the decoder's formatted messages can carry either.
 */
const SECRETS = [
  'PATIENT-NAME-Aoife-Brennan',
  'sk-live-3f9a2b7c8d1e',
  'salary-negotiation-notes',
  'MY-PRIVATE-KEY-NAME',
] as const;

/** Everything reachable from a failure: the public envelope plus the error graph itself. */
const everythingVisible = (error: NodeError): string => {
  const parts = [
    JSON.stringify(toPublicError(error)),
    inspect(toPublicError(error), { depth: 10 }),
    // The error instance is not a wire value, but for an expected failure it must be clean too: nothing
    // payload-bearing may be retained at all.
    JSON.stringify(error) ?? '',
    inspect(error, { depth: 10 }),
  ];
  return parts.join('\n');
};

const assertClean = (error: NodeError, label: string): void => {
  const visible = everythingVisible(error);
  for (const secret of SECRETS) {
    assert.equal(
      visible.includes(secret),
      false,
      `${label}: "${secret}" reached a caller-visible or retained surface:\n${visible}`,
    );
  }
};

test('a rejected title never echoes the submitted title', () => {
  withMigrated('disclosure-title', (connection) => {
    const error = expectLeft(
      runNodes(
        connection,
        createNode({
          type: 'area',
          parent: { path: '/' },
          title: `${SECRETS[0]} ${'x'.repeat(300)}`,
        }),
      ),
    );
    assert.equal(toPublicError(error).details['reason'], 'title_too_long');
    assertClean(error, 'title too long');
  });
});

test('a rejected metadata payload echoes neither its values nor its property names', () => {
  withMigrated('disclosure-metadata', (connection) => {
    const error = expectLeft(
      runNodes(
        connection,
        createNode({
          type: 'area',
          parent: { path: '/' },
          title: 'Fine title',
          // Too deep for metadata, so the rejection comes from the JSON-safety walk, whose message names
          // the path it walked - which is exactly the disclosure this policy exists to prevent.
          metadata: {
            [SECRETS[3]]: { a: { b: { c: { d: { e: SECRETS[1] } } } } },
          },
        }),
      ),
    );
    assert.equal(toPublicError(error).code, 'invalid_input');
    assertClean(error, 'metadata too deep');
  });
});

test('an unsupported body reports a location, never the content at that location', () => {
  withMigrated('disclosure-body', (connection) => {
    const error = expectLeft(
      runNodes(
        connection,
        createNode({
          type: 'project',
          parent: { path: '/work' },
          title: 'Fine title',
          body: {
            format: 'tiptap',
            value: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: SECRETS[2] }] },
                { type: SECRETS[3], content: [{ type: 'text', text: SECRETS[1] }] },
              ],
            },
          },
        }),
      ),
    );
    const published = toPublicError(error);
    assert.equal(published.code, 'unsupported_content');
    assert.deepEqual(
      published.details['path'],
      [1],
      'the location is published; the content is not',
    );
    assertClean(error, 'unsupported body');
  });
});

test('an unrecognized property name is not reflected back', () => {
  withMigrated('disclosure-excess', (connection) => {
    const error = expectLeft(
      runNodes(
        connection,
        createNode({
          type: 'area',
          parent: { path: '/' },
          title: 'Fine title',
          [SECRETS[3]]: SECRETS[1],
        }),
      ),
    );
    assert.equal(toPublicError(error).code, 'invalid_input');
    assertClean(error, 'excess property');
  });
});

test('a malformed selector does not echo what was submitted as one', () => {
  withMigrated('disclosure-selector', (connection) => {
    for (const target of [{ path: `/${SECRETS[0]}` }, { id: SECRETS[1] }, SECRETS[2]]) {
      const error = expectLeft(runNodes(connection, getNode({ target })));
      assertClean(error, `selector ${JSON.stringify(target)}`);
    }
  });
});

test('a list request rejected on its filter says nothing about the payload', () => {
  withMigrated('disclosure-list', (connection) => {
    const error = expectLeft(
      runNodes(connection, listNodes({ parent: { path: '/' }, types: [SECRETS[0]] })),
    );
    assert.equal(toPublicError(error).code, 'invalid_input');
    assertClean(error, 'list filter');
  });
});

test('a rejected update echoes neither its submitted change nor its excess properties', () => {
  withMigrated('disclosure-update', (connection) => {
    const created = expectRight(
      runNodes(
        connection,
        createNode({ type: 'project', parent: { path: '/work' }, title: 'Holder' }),
      ),
    ).entity;

    // Three refusals that each reach the decoder by a different route: an oversized title, an
    // unpatchable property the envelope has no field for, and a tag named in both lists. All three are
    // rejected before anything is written, and none of them may carry the submitted value back.
    const envelopes = [
      { title: `${SECRETS[0]} ${'x'.repeat(300)}` },
      { title: 'Fine title', metadata: { [SECRETS[3]]: SECRETS[1] } },
      { addTags: [SECRETS[2]], removeTags: [SECRETS[2]] },
    ];

    for (const change of envelopes) {
      const error = expectLeft(
        runNodes(
          connection,
          updateNode({ target: { id: created.id }, revision: created.revision, ...change }),
        ),
      );
      assert.equal(toPublicError(error).code, 'invalid_input');
      assertClean(error, `update ${JSON.stringify(Object.keys(change))}`);
    }
  });
});

test('an unexpected failure publishes nothing, while keeping its cause for the operator', () => {
  withMigrated('disclosure-internal', (connection) => {
    const created = expectRight(
      runNodes(
        connection,
        createNode({ type: 'project', parent: { path: '/work' }, title: 'Holder' }),
        clockAt(1_700_000_000_000),
      ),
    ).entity;

    // A stored body carrying private prose, corrupted so the read fails on it.
    connection.db
      .prepare('UPDATE nodes SET body = ? WHERE id = ?')
      .run(
        `{"type":"doc","content":[{"type":"${SECRETS[3]}","text":"${SECRETS[2]}"}]}`,
        created.id,
      );

    const error = expectLeft(runNodes(connection, getNode({ target: { id: created.id } })));
    const published = toPublicError(error);
    assert.equal(published.code, 'internal_error');
    assert.deepEqual(published.details, {});
    assert.equal(published.message, 'The request could not be completed.');

    // The public projection is clean. The error instance is not asserted clean here: an unexpected
    // failure may retain its cause, which is the point of retaining it, and is why phase 05 must project
    // explicitly rather than serialize an error - and why no routine log may print a cause chain.
    const visible = `${JSON.stringify(published)}\n${inspect(published, { depth: 10 })}`;
    for (const secret of SECRETS) {
      assert.equal(visible.includes(secret), false, `"${secret}" reached the public envelope`);
    }
  });
});

test('the public projection is built field by field, not spread from the error', () => {
  withMigrated('disclosure-projection', (connection) => {
    const error = expectLeft(runNodes(connection, getNode({ target: { id: 999_999 } })));
    const published = toPublicError(error);
    assert.deepEqual(Object.keys(published).sort(), ['code', 'details', 'message']);
    assert.equal('_tag' in published, false, 'an internal tag is not part of the wire contract');
    assert.equal('stack' in published, false);
    assert.equal('cause' in published, false);
  });
});
