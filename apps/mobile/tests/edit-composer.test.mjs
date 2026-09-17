/**
 * What the editor says about one record.
 *
 * Two properties, and both are correctness rather than presentation. **Protection outranks every
 * statement about a server**, including the conflict band - a screen that reports a server's opinion
 * over "what you have written is not safe here" is telling someone their work is safe in the one
 * moment it is not. And **the alert colour appears once**: the status line goes quiet exactly when the
 * band is carrying the alert.
 *
 * The third thing asserted here is that no sentence says "slug".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTECTION_COPY, SAVING_STATUS, serverStatus } from '../src/modules/capture/composer.ts';
import {
  CONFLICTED_STATUS,
  CONFLICT_NOTICE,
  EDIT_PROBLEM_COPY,
  OFFLINE_STATUS,
  PENDING_STATUS,
  UNCONFIRMED_EDIT_STATUS,
  editComposerView,
  idLabelOf,
  refusedStatus,
} from '../src/modules/capture/edit-composer.ts';

const view = (standing, over = {}) =>
  editComposerView({
    standing,
    protection: undefined,
    lastRejection: null,
    nodeType: 'resource',
    kind: 'note',
    ...over,
  });

const protection = (over = {}) => ({
  committedVersion: 1,
  latestAcceptedVersion: 1,
  pending: false,
  writing: false,
  failedWrite: false,
  rendererUnknown: false,
  locked: false,
  attached: true,
  ...over,
});

describe('editComposerView', () => {
  it('says each ordinary standing in the quiet tone', () => {
    assert.deepEqual(view({ kind: 'synced', revision: 4 }).status, {
      text: serverStatus(4),
      tone: 'quiet',
    });
    assert.deepEqual(view({ kind: 'pending' }).status, { text: PENDING_STATUS, tone: 'quiet' });
    assert.deepEqual(view({ kind: 'saving' }).status, { text: SAVING_STATUS, tone: 'quiet' });
  });

  it('says what it cannot establish and cannot attempt in the alert tone', () => {
    assert.deepEqual(view({ kind: 'unconfirmed' }).status, {
      text: UNCONFIRMED_EDIT_STATUS,
      tone: 'alert',
    });
    assert.deepEqual(view({ kind: 'offline' }).status, { text: OFFLINE_STATUS, tone: 'alert' });
  });

  it('draws the conflict band and goes quiet on the status line', () => {
    const conflicted = view({ kind: 'conflicted' });

    assert.equal(conflicted.notice, 'conflict');
    // The band carries the alert, so the line states the fact without a second red thing beside it.
    assert.deepEqual(conflicted.status, { text: CONFLICTED_STATUS, tone: 'quiet' });
  });

  it('keeps the alert on the status line for every other alert standing', () => {
    for (const standing of [{ kind: 'unconfirmed' }, { kind: 'offline' }]) {
      const drawn = view(standing);

      assert.equal(drawn.notice, null);
      assert.equal(drawn.status.tone, 'alert');
    }
  });

  it('never offers an action; the only one is the Discard inside the band', () => {
    assert.deepEqual(Object.keys(view({ kind: 'conflicted' })).sort(), [
      'locked',
      'notice',
      'problem',
      'status',
    ]);
  });

  it('locks on a settling barrier, never merely on a request in flight', () => {
    assert.equal(view({ kind: 'saving' }).locked, false);
    assert.equal(
      view({ kind: 'saving' }, { protection: protection({ locked: true }) }).locked,
      true,
    );
  });

  describe('precedence', () => {
    it('puts a failed local write above a conflict, and takes the band away', () => {
      const drawn = view({ kind: 'conflicted' }, { protection: protection({ failedWrite: true }) });

      assert.deepEqual(drawn.status, { text: PROTECTION_COPY.failed_write, tone: 'alert' });
      // The band would be a second alert about a lesser fact.
      assert.equal(drawn.notice, null);
      assert.equal(drawn.problem, 'failed_write');
    });

    it('puts protection above a refusal, an unconfirmed send, offline and pending alike', () => {
      const standings = [
        { kind: 'refused', refusal: { code: 'slug_conflict', field: 'slug', reason: null, at: 1 } },
        { kind: 'unconfirmed' },
        { kind: 'offline' },
        { kind: 'pending' },
      ];

      for (const standing of standings) {
        const drawn = view(standing, {
          protection: protection({ rendererUnknown: true }),
          lastRejection: 'too_large',
        });

        assert.deepEqual(drawn.status, { text: PROTECTION_COPY.too_large, tone: 'alert' });
        assert.equal(drawn.problem, 'too_large');
      }
    });

    it('reads the protection question through composer.ts rather than restating it', () => {
      // An unanswered editor and a refused one are different facts, and both composers must agree.
      assert.equal(
        view({ kind: 'pending' }, { protection: protection({ rendererUnknown: true }) }).problem,
        'unanswered',
      );
    });
  });
});

describe('refusedStatus', () => {
  const at = 1;

  it('names each reason from the closed map', () => {
    assert.match(
      refusedStatus({ code: 'slug_conflict', field: 'slug', reason: null, at }, 'note ID'),
      /that note ID is already used/,
    );
    assert.match(
      refusedStatus(
        { code: 'invalid_input', field: 'title', reason: 'title_required', at },
        'note ID',
      ),
      /a title is required/,
    );
    assert.match(
      refusedStatus(
        { code: 'invalid_input', field: 'tags', reason: 'tags_too_many', at },
        'note ID',
      ),
      /too many tags/,
    );
    assert.match(
      refusedStatus({ code: 'invalid_input', field: 'slug', reason: null, at }, 'area ID'),
      /that area ID is not valid/,
    );
    assert.match(
      refusedStatus({ code: 'unsupported_content', field: 'body', reason: null, at }, 'note ID'),
      /does not support/,
    );
    assert.match(
      refusedStatus({ code: 'node_not_found', field: null, reason: null, at }, 'note ID'),
      /no longer exists on your server/,
    );
  });

  it('falls back to the code rather than inventing a cause', () => {
    assert.match(
      refusedStatus({ code: 'storage_busy', field: null, reason: null, at }, 'note ID'),
      /storage_busy/,
    );
  });

  it('says what is certainly true when the refusal could not be read', () => {
    const text = refusedStatus(null, 'note ID');

    assert.match(text, /refused the last change/);
    assert.match(text, /kept on this phone/);
  });
});

describe('the interface never says "slug"', () => {
  it('calls the field an ID, by what is being edited', () => {
    assert.equal(idLabelOf('resource', 'note'), 'note ID');
    assert.equal(idLabelOf('area', null), 'area ID');
    assert.equal(idLabelOf('project', null), 'project ID');
  });

  it('has no user-facing string containing the word', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/modules/capture/edit-composer.ts', import.meta.url)),
      'utf8',
    );
    // Every string literal in the module, including the refusal sentences and the problem copy.
    const literals = source.match(/'[^'\n]*'|`[^`]*`/g) ?? [];
    const sentences = literals.filter((literal) => /\s/.test(literal));

    for (const sentence of sentences) {
      assert.ok(!/slug/i.test(sentence), `user-facing string says "slug": ${sentence}`);
    }
  });

  it('says every standing and every problem without it', () => {
    const texts = [
      CONFLICTED_STATUS,
      CONFLICT_NOTICE,
      UNCONFIRMED_EDIT_STATUS,
      OFFLINE_STATUS,
      PENDING_STATUS,
      refusedStatus(null, 'note ID'),
      refusedStatus({ code: 'slug_conflict', field: 'slug', reason: null, at: 1 }, 'note ID'),
      ...Object.values(EDIT_PROBLEM_COPY),
    ];

    for (const text of texts) assert.ok(!/slug/i.test(text), text);
  });
});
