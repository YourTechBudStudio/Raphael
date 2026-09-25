/**
 * What gets sent, what that produces, and whether the server already has it.
 *
 * The properties defended here decide whether autosave terminates and whether someone's applied edit
 * is reported back to them as a conflict. Three are worth naming.
 *
 * **A diff taken against a base this phone sent is empty.** That is the whole reason the base is never
 * re-seeded from the server's normalized echo, and the normalizing-server case below is the one that
 * would otherwise spin forever.
 *
 * **`applyEnvelope` reproduces the server's tag order exactly.** It produces the next base, so an
 * order that disagreed would make every following diff non-empty.
 *
 * **`matchesSubmitted` recognizes an applied update through the server's normalization**, and refuses
 * everything it cannot establish. Its revision precondition is what stops it acknowledging a third
 * party's write as this phone's own.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyEnvelope,
  contentOf,
  diff,
  matchesSubmitted,
  readInflight,
  serializeInflight,
} from '../src/modules/capture/edit-envelope.ts';

const CANONICAL = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../packages/content/tests/fixtures/supported-basics/expected-document.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

const OTHER_DOCUMENT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'different' }] }],
};

/** `matchesSubmitted` for an update envelope, the only kind before moves. */
const matchesUpdate = (entityRead, envelope, base, baseRevision) =>
  matchesSubmitted(entityRead, { kind: 'update', envelope }, base, baseRevision);

const content = (over = {}) => ({
  title: 'Contracts',
  description: 'what we agreed',
  slug: 'contracts',
  tags: ['work', 'review'],
  document: CANONICAL,
  ...over,
});

const entity = (over = {}) => ({
  id: 7,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: 'contracts',
  revision: 2,
  title: 'Contracts',
  description: 'what we agreed',
  tags: ['work', 'review'],
  active: false,
  archived: false,
  archiveCauses: [],
  metadata: {},
  body: { format: 'tiptap', value: CANONICAL },
  ...over,
});

describe('diff', () => {
  it('is null when nothing differs', () => {
    assert.equal(diff(content(), content()), null);
  });

  it('carries each scalar only when it changed', () => {
    assert.deepEqual(diff(content(), content({ title: 'Contracts v2' })), {
      title: 'Contracts v2',
    });
    assert.deepEqual(diff(content(), content({ description: 'revised' })), {
      description: 'revised',
    });
    assert.deepEqual(diff(content(), content({ slug: 'contracts-v2' })), { slug: 'contracts-v2' });
  });

  it('sends an emptied description, because absence is what "unchanged" means', () => {
    assert.deepEqual(diff(content(), content({ description: '' })), { description: '' });
  });

  it('carries the body as a tiptap value when the documents differ', () => {
    assert.deepEqual(diff(content(), content({ document: OTHER_DOCUMENT })), {
      body: { format: 'tiptap', value: OTHER_DOCUMENT },
    });
  });

  it('expresses tags as set differences and omits an empty list', () => {
    assert.deepEqual(diff(content(), content({ tags: ['work', 'review', 'urgent'] })), {
      addTags: ['urgent'],
    });
    assert.deepEqual(diff(content(), content({ tags: ['work'] })), { removeTags: ['review'] });
    assert.deepEqual(diff(content(), content({ tags: ['work', 'urgent'] })), {
      addTags: ['urgent'],
      removeTags: ['review'],
    });
  });

  it('never sends an empty tag list, which the contract would take as a change', () => {
    const envelope = diff(content(), content({ title: 'Renamed' }));

    assert.ok(!('addTags' in envelope));
    assert.ok(!('removeTags' in envelope));
  });

  it('carries every changed field at once', () => {
    assert.deepEqual(
      diff(
        content(),
        content({
          title: 'Renamed',
          description: 'revised',
          slug: 'renamed',
          tags: ['urgent'],
          document: OTHER_DOCUMENT,
        }),
      ),
      {
        title: 'Renamed',
        description: 'revised',
        slug: 'renamed',
        body: { format: 'tiptap', value: OTHER_DOCUMENT },
        addTags: ['urgent'],
        removeTags: ['work', 'review'],
      },
    );
  });

  it('is empty again against the base the acknowledgement installs', () => {
    // The loop that matters: what was sent becomes the base, so the next diff has nothing to say.
    const current = content({ title: 'Renamed', tags: ['work', 'urgent'] });
    const sent = diff(content(), current);

    assert.equal(diff(applyEnvelope(content(), sent), current), null);
  });
});

describe('applyEnvelope', () => {
  it('replaces each carried scalar and leaves the rest', () => {
    assert.deepEqual(applyEnvelope(content(), { title: 'Renamed' }), content({ title: 'Renamed' }));
  });

  it('takes the document from a carried body', () => {
    assert.deepEqual(
      applyEnvelope(content(), { body: { format: 'tiptap', value: OTHER_DOCUMENT } }).document,
      OTHER_DOCUMENT,
    );
  });

  it('produces the server’s tag order: kept in stored order, then additions in submitted order', () => {
    const base = content({ tags: ['a', 'b', 'c'] });

    assert.deepEqual(applyEnvelope(base, { removeTags: ['b'], addTags: ['z', 'y'] }).tags, [
      'a',
      'c',
      'z',
      'y',
    ]);
  });

  it('treats adding a present tag as a set no-op rather than a duplicate', () => {
    assert.deepEqual(applyEnvelope(content(), { addTags: ['work'] }).tags, ['work', 'review']);
  });

  it('treats removing an absent tag as a set no-op', () => {
    assert.deepEqual(applyEnvelope(content(), { removeTags: ['nope'] }).tags, ['work', 'review']);
  });
});

describe('matchesSubmitted', () => {
  it('matches a title the server trimmed', () => {
    const base = content();
    const envelope = { title: '  Contracts v2  ' };

    assert.equal(matchesUpdate(entity({ title: 'Contracts v2' }), envelope, base, 1), true);
  });

  it('matches an uncarried base title that itself carries whitespace', () => {
    // The base holds what was sent, whitespace included; the server stored its trim.
    const base = content({ title: '  Contracts  ' });

    assert.equal(matchesUpdate(entity({ title: 'Contracts' }), { slug: 'x' }, base, 1), false);
    assert.equal(
      matchesUpdate(entity({ title: 'Contracts', slug: 'x' }), { slug: 'x' }, base, 1),
      true,
    );
  });

  it('matches a tag the server NFC-normalized', () => {
    // Built rather than typed: the two forms are indistinguishable in a source file, so a literal
    // would be one careless normalization away from silently testing nothing.
    const composed = 'Caf\u00e9';
    const decomposed = composed.normalize('NFD');
    const base = content({ tags: [] });

    assert.notEqual(decomposed, composed);
    assert.equal(
      matchesUpdate(entity({ tags: [composed] }), { addTags: [decomposed] }, base, 1),
      true,
    );
  });

  it('compares the resulting tag list in order, not as a set', () => {
    const base = content({ tags: ['a', 'b'] });
    const envelope = { addTags: ['z'] };

    assert.equal(matchesUpdate(entity({ tags: ['a', 'b', 'z'] }), envelope, base, 1), true);
    assert.equal(matchesUpdate(entity({ tags: ['z', 'a', 'b'] }), envelope, base, 1), false);
  });

  it('matches a carried body the server stored unchanged', () => {
    assert.equal(
      matchesUpdate(
        entity({ body: { format: 'tiptap', value: OTHER_DOCUMENT } }),
        { body: { format: 'tiptap', value: OTHER_DOCUMENT } },
        content(),
        1,
      ),
      true,
    );
  });

  it('refuses when a carried body differs from what the server holds', () => {
    // The safe direction: a body we sent and cannot recognize is a conflict, which keeps the writing.
    assert.equal(
      matchesUpdate(entity(), { body: { format: 'tiptap', value: OTHER_DOCUMENT } }, content(), 1),
      false,
    );
  });

  it('ignores an uncarried body that differs from the base', () => {
    // The base holds the editor's form of a document the server canonicalized, so the two legitimately
    // differ. A body this envelope never submitted says nothing about whether the envelope applied,
    // and treating it as evidence would report a conflict for every title-only save whose answer was
    // lost.
    const base = content({ document: OTHER_DOCUMENT });

    assert.equal(matchesUpdate(entity({ title: 'Renamed' }), { title: 'Renamed' }, base, 1), true);
  });

  it('requires exactly one write since the base', () => {
    const envelope = { title: 'Renamed' };
    const named = entity({ title: 'Renamed' });

    assert.equal(matchesUpdate({ ...named, revision: 2 }, envelope, content(), 1), true);
    // Two writes since the base: one of them was not ours, and acknowledging would advance past a
    // change this phone never read.
    assert.equal(matchesUpdate({ ...named, revision: 3 }, envelope, content(), 1), false);
    // No write at all: the update did not apply.
    assert.equal(matchesUpdate({ ...named, revision: 1 }, envelope, content(), 1), false);
  });

  it('refuses a description or slug the server does not hold exactly', () => {
    assert.equal(matchesUpdate(entity(), { description: ' spaced ' }, content(), 1), false);
    assert.equal(matchesUpdate(entity(), { slug: 'other' }, content(), 1), false);
  });
});

/**
 * A move carries a parent and nothing authored, and its answer can be lost like any other.
 *
 * The property defended here is that reconciliation never adopts someone else's write as this phone's
 * move: a move is recognized only by the parent it asked for, one revision past the base, over
 * authored fields that did not move - and a move that expected no write is never recognized at all.
 */
describe('matchesSubmitted for a move', () => {
  const move = (over = {}) => ({ kind: 'move', parentId: 9, expectsWrite: true, ...over });

  it('recognizes the parent it asked for, one write past the base, with its address kept', () => {
    assert.equal(
      matchesSubmitted(entity({ parentId: 9, revision: 2 }), move(), content(), 1),
      true,
    );
  });

  it('refuses another parent, or any count of writes but one', () => {
    assert.equal(
      matchesSubmitted(entity({ parentId: 4, revision: 2 }), move(), content(), 1),
      false,
    );
    assert.equal(
      matchesSubmitted(entity({ parentId: 9, revision: 3 }), move(), content(), 1),
      false,
    );
    assert.equal(
      matchesSubmitted(entity({ parentId: 9, revision: 1 }), move(), content(), 1),
      false,
    );
  });

  it('refuses a rival title change landing at the same revision', () => {
    assert.equal(
      matchesSubmitted(entity({ parentId: 9, revision: 2, title: 'Theirs' }), move(), content(), 1),
      false,
    );
  });

  it('refuses a move to the root when the server holds a parent', () => {
    assert.equal(
      matchesSubmitted(
        entity({ parentId: 3, revision: 2 }),
        move({ parentId: null }),
        content(),
        1,
      ),
      false,
    );
    assert.equal(
      matchesSubmitted(
        entity({ parentId: null, revision: 2 }),
        move({ parentId: null }),
        content(),
        1,
      ),
      true,
    );
  });

  /**
   * The case `expectsWrite` exists for. A body is never compared for an envelope that did not carry
   * one, so a rival's body-only write at base + 1 would pass every other comparison - and a move that
   * expected no write cannot have produced any revision above the base.
   */
  it('never recognizes a move that expected no write, even over a rival body-only write', () => {
    const rival = entity({
      parentId: 3,
      revision: 2,
      body: { format: 'tiptap', value: OTHER_DOCUMENT },
    });

    assert.equal(
      matchesSubmitted(rival, move({ parentId: 3, expectsWrite: false }), content(), 1),
      false,
    );
  });
});

/**
 * The persisted grammar of the `inflight` column.
 *
 * Every row written before moves holds a bare update envelope, and must still read as one. Anything
 * tagged that this build did not write is retained unreadable rather than reinterpreted, which is the
 * store's posture for every other column.
 */
describe('readInflight and serializeInflight', () => {
  it('reads a bare envelope as an update, exactly as it was stored before moves', () => {
    assert.deepEqual(readInflight({ title: 'x' }), { kind: 'update', envelope: { title: 'x' } });
    assert.deepEqual(readInflight({}), { kind: 'update', envelope: {} });
  });

  it('reads a tagged move', () => {
    assert.deepEqual(readInflight({ kind: 'move', parentId: 9, expectsWrite: true }), {
      kind: 'move',
      parentId: 9,
      expectsWrite: true,
    });
    assert.deepEqual(readInflight({ kind: 'move', parentId: null, expectsWrite: false }), {
      kind: 'move',
      parentId: null,
      expectsWrite: false,
    });
  });

  it('refuses an unknown or null discriminator rather than reading it as an update', () => {
    assert.equal(readInflight({ kind: 'rename', title: 'x' }), null);
    assert.equal(readInflight({ kind: null, title: 'x' }), null);
  });

  it('refuses a malformed move', () => {
    for (const parentId of [0, -1, 1.5, '9', undefined]) {
      assert.equal(
        readInflight({ kind: 'move', parentId, expectsWrite: true }),
        null,
        String(parentId),
      );
    }
    assert.equal(readInflight({ kind: 'move', parentId: 9 }), null);
    assert.equal(readInflight({ kind: 'move', parentId: 9, expectsWrite: 'yes' }), null);
  });

  it('refuses a move carrying a slug, which this phone never sends', () => {
    assert.equal(readInflight({ kind: 'move', parentId: 9, expectsWrite: true, slug: 'x' }), null);
  });

  it('stores an update bare and a move tagged, and reads both back', () => {
    const update = { kind: 'update', envelope: { title: 'x', addTags: ['a'] } };
    const move = { kind: 'move', parentId: 9, expectsWrite: true };

    assert.deepEqual(JSON.parse(serializeInflight(update)), { title: 'x', addTags: ['a'] });
    assert.deepEqual(readInflight(JSON.parse(serializeInflight(update))), update);
    assert.deepEqual(readInflight(JSON.parse(serializeInflight(move))), move);
  });
});

describe('contentOf', () => {
  it('reads an entity as content', () => {
    assert.deepEqual(contentOf(entity()), {
      title: 'Contracts',
      description: 'what we agreed',
      slug: 'contracts',
      tags: ['work', 'review'],
      document: CANONICAL,
    });
  });

  it('accepts a container, because containers are edited by the same editor', () => {
    assert.notEqual(contentOf(entity({ type: 'area', kind: null })), null);
  });

  it('refuses a body this build cannot display', () => {
    assert.equal(contentOf(entity({ body: { format: 'markdown', value: '# hi' } })), null);
    assert.equal(
      contentOf(entity({ body: { format: 'tiptap', value: { type: 'nonsense' } } })),
      null,
    );
  });
});
