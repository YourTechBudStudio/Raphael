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
  MOVE_EYEBROW_HINT,
  MOVE_LOCKED_HINT,
  MOVE_UNCONFIRMED_HINT,
  PENDING_STATUS,
  UNCONFIRMED_EDIT_STATUS,
  editCardSentence,
  editComposerView,
  idLabelOf,
  moveControl,
  moveNotSentSentence,
  moveRefusalSentence,
  movedNotice,
  movedNoticeHolds,
  movedStatus,
  refusedStatus,
} from '../src/modules/capture/edit-composer.ts';
import { STANDING_ORDER } from '../src/modules/capture/edit-unfinished.ts';

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

/**
 * The sentence a list says about one record, which is not the status line said again.
 *
 * Two arms exist precisely because the status line is false away from the editor, and both are
 * asserted in their own words rather than against a constant - a test that compared them to the
 * thing they deliberately are not would pass on the day someone put the constants back.
 *
 * `UNCONFIRMED_EDIT_STATUS` says "checking your server": true in the editor, where the owner
 * reconciles on open, and a claim about work that is not running anywhere else. `PENDING_STATUS`
 * says "saving soon": true only while an editor holds the record with its debounce armed.
 */
describe('editCardSentence', () => {
  const sentence = (standing, over = {}) =>
    editCardSentence({ standing, refusal: null, nodeType: 'resource', kind: 'note', ...over });

  it('never claims an activity that is not running', () => {
    const unconfirmed = sentence('unconfirmed');

    assert.match(unconfirmed, /may or may not have reached your server/);
    assert.match(unconfirmed, /Open it to check/);
    assert.ok(
      !/checking your server/.test(unconfirmed),
      'nothing is checking away from the editor',
    );
    assert.notEqual(unconfirmed, UNCONFIRMED_EDIT_STATUS);
  });

  it('never promises a save nothing is about to make', () => {
    const pending = sentence('pending');

    assert.match(pending, /kept on this phone/);
    assert.match(pending, /have not reached your server/);
    assert.ok(!/saving soon/.test(pending), 'no editor is holding this, so nothing is saving soon');
    assert.notEqual(pending, PENDING_STATUS);
    assert.notEqual(pending, OFFLINE_STATUS);
    // One fact is true of both, and the card has no room to tell them apart usefully.
    assert.equal(sentence('offline'), pending);
  });

  it('says a request in the air is exactly that', () => {
    assert.match(sentence('saving'), /on their way to your server/);
  });

  it('reuses the sentences that already exist rather than writing them twice', () => {
    assert.equal(sentence('conflicted'), CONFLICT_NOTICE);
    assert.equal(
      sentence('refused', {
        refusal: { code: 'slug_conflict', field: 'slug', reason: null, at: 1 },
      }),
      refusedStatus({ code: 'slug_conflict', field: 'slug', reason: null, at: 1 }, 'note ID'),
    );
    assert.equal(
      sentence('unusable', { problem: 'unusable_body' }),
      EDIT_PROBLEM_COPY.unusable_body,
    );
  });

  it('claims least about an unusable row whose reason could not be read either', () => {
    assert.equal(sentence('unusable'), EDIT_PROBLEM_COPY.unreadable_row);
  });

  /**
   * The assertion that matters most here.
   *
   * `unfinishedEdits` filters `synced` out, so nothing draws that arm today - and a function with a
   * hole in it renders a blank card the day that filter changes. The list is walked from
   * `STANDING_ORDER`, the one runtime enumeration of the union, whose `satisfies` fails to compile
   * when a standing is added; restating the standings here would be a second list free to fall
   * behind the first.
   */
  it('has a sentence for every standing, including the one nothing draws', () => {
    const standings = Object.keys(STANDING_ORDER);

    assert.ok(standings.includes('synced'), 'the enumeration covers the filtered standing too');

    for (const standing of standings) {
      // A row with no readable type is the shape the unusable arm is given, and every other arm
      // has to stay total over it too.
      const text = sentence(standing, { problem: 'unreadable_row', nodeType: null, kind: null });

      assert.equal(typeof text, 'string', `${standing} has no sentence`);
      assert.ok(text.length > 0, `${standing} says nothing`);
    }
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
    // Interpolations are blanked first: `${input.slug}` is an identifier the compiler reads, not a
    // word anybody sees, and the chip legitimately *shows* the stored value under the name "ID".
    // What must never appear is the word itself, in prose.
    const literals = source.match(/'[^'\n]*'|`[^`]*`/g) ?? [];
    const sentences = literals
      .map((literal) => literal.replaceAll(/\$\{[^}]*\}/g, '\u2026'))
      .filter((literal) => /\s/.test(literal));

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

describe('moving', () => {
  const control = (over = {}) =>
    moveControl({
      locationKnown: true,
      locked: false,
      leaving: false,
      moveInflight: false,
      ...over,
    });

  it('offers the eyebrow as Move only where the location is known', () => {
    assert.equal(control({ locationKnown: false }), null);
    assert.deepEqual(control(), { disabled: false, hint: MOVE_EYEBROW_HINT });
  });

  it('disables it while writing is protected or the screen is leaving, and says when it comes back', () => {
    assert.deepEqual(control({ locked: true }), { disabled: true, hint: MOVE_LOCKED_HINT });
    assert.deepEqual(control({ leaving: true }), { disabled: true, hint: MOVE_LOCKED_HINT });
  });

  it('names the unanswered move before anything else that holds it', () => {
    assert.deepEqual(control({ moveInflight: true, locked: true }), {
      disabled: true,
      hint: MOVE_UNCONFIRMED_HINT,
    });
  });

  describe('the moved status', () => {
    const notice = { place: 'Raphael', revision: 8 };

    it('says where it went, at the revision the record is synced at', () => {
      assert.deepEqual(view({ kind: 'synced', revision: 8 }, { moved: notice }).status, {
        text: 'Moved to Raphael · revision 8',
        tone: 'quiet',
      });
      assert.equal(movedStatus('the top level', 3), 'Moved to the top level · revision 3');
    });

    it('holds only while the record is synced at exactly that revision', () => {
      assert.equal(movedNoticeHolds(notice, { kind: 'synced', revision: 8 }), true);
      assert.equal(movedNoticeHolds(notice, { kind: 'synced', revision: 9 }), false);
      assert.equal(movedNoticeHolds(notice, { kind: 'pending' }), false);
      assert.equal(
        view({ kind: 'synced', revision: 9 }, { moved: notice }).status.text,
        serverStatus(9),
      );
      assert.equal(view({ kind: 'pending' }, { moved: notice }).status.text, PENDING_STATUS);
    });

    it('names the place as the eyebrow names it now, so a rename elsewhere is followed', () => {
      const went = { parentId: 5, revision: 8 };
      const there = { kind: 'known', parentId: 5 };

      assert.deepEqual(movedNotice(went, there, 'Raphael'), { place: 'Raphael', revision: 8 });
      // Another client renamed the destination; the next reading names it, and so does the line.
      assert.deepEqual(movedNotice(went, there, 'Raphael app'), {
        place: 'Raphael app',
        revision: 8,
      });
      assert.equal(movedNotice(null, there, 'Raphael'), null);
    });

    it('claims no name it cannot back', () => {
      const went = { parentId: 5, revision: 8 };

      // Not yet named, or the owner's location is no longer where the move went.
      assert.equal(
        movedNotice(went, { kind: 'known', parentId: 5 }, undefined).place,
        'its new place',
      );
      assert.equal(
        movedNotice(went, { kind: 'known', parentId: 6 }, 'Elsewhere').place,
        'its new place',
      );
      assert.equal(movedNotice(went, { kind: 'unknown' }, 'Raphael').place, 'its new place');
      assert.equal(
        movedNotice({ parentId: null, revision: 3 }, { kind: 'known', parentId: null }, 'Areas')
          .place,
        'the top level',
      );
    });

    it('never outranks protection', () => {
      const drawn = view(
        { kind: 'synced', revision: 8 },
        { moved: notice, protection: protection({ failedWrite: true }) },
      );

      assert.deepEqual(drawn.status, { text: PROTECTION_COPY.failed_write, tone: 'alert' });
    });

    it('is not cleared by the lock a sheet holds', () => {
      const drawn = view(
        { kind: 'synced', revision: 8 },
        { moved: notice, protection: protection({ locked: true }) },
      );

      assert.equal(drawn.status.text, 'Moved to Raphael · revision 8');
    });
  });

  describe('refusals', () => {
    const apiError = (code, details = {}) => ({
      kind: 'api_error',
      status: 409,
      mutationOutcome: 'not_applied',
      message: `server said ${code}`,
      error: { code, message: code },
      details,
    });
    const context = { idLabel: 'note ID', place: 'Raphael', slug: 'sync-notes' };

    it('points a collision to Details, naming the place and the ID', () => {
      assert.equal(
        moveRefusalSentence(apiError('slug_conflict', { field: 'destination' }), context),
        'Something in Raphael already uses the note ID “sync-notes”. Change this note ID in Details, then move it.',
      );
    });

    it('tells a cycle from a place that cannot hold this', () => {
      assert.equal(
        moveRefusalSentence(apiError('invalid_parent', { reason: 'cycle' }), context),
        'Something cannot move inside itself.',
      );
      assert.equal(
        moveRefusalSentence(apiError('invalid_parent', { reason: 'parent_type' }), context),
        'That place cannot hold this.',
      );
    });

    it('says which side is missing', () => {
      assert.notEqual(
        moveRefusalSentence(apiError('node_not_found', { field: 'target' }), context),
        moveRefusalSentence(apiError('node_not_found', { field: 'destination' }), context),
      );
    });

    it('says what the client said for anything else', () => {
      assert.equal(
        moveRefusalSentence(
          { kind: 'transport', mutationOutcome: 'not_applied', message: 'No route' },
          context,
        ),
        'No route',
      );
    });

    it('has a sentence for every reason a move was not sent', () => {
      for (const reason of [
        'unsent_writing',
        'no_session',
        'conflicted',
        'refused',
        'unconfirmed',
        'unknown_location',
      ]) {
        const sentence = moveNotSentSentence(reason);

        assert.ok(sentence.length > 0 && !/slug/i.test(sentence), reason);
      }
      assert.equal(moveNotSentSentence('conflicted'), CONFLICT_NOTICE);
    });
  });
});
