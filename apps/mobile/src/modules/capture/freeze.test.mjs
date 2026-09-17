/**
 * What gets frozen, and what a stored request is allowed to become on the way back out.
 *
 * The properties here are the ones the server's fingerprint is sensitive to: an omitted title stays
 * omitted rather than being trimmed into existence, authored whitespace survives, the body is always
 * present, and a stored request this build would normalize differently is refused with the record
 * kept rather than migrated into a replay of something nobody wrote.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmptyDocument } from '@raphael/content';
import { TAGS_MAX_COUNT, TAG_MAX_CODE_POINTS } from '@raphael/contracts/nodes';

import {
  TAG_TOO_LONG_PROBLEM,
  TOO_MANY_TAGS_PROBLEM,
  UNPREPARABLE_PROBLEM,
  canonicalJson,
  freezeNoteRequest,
  recoverNoteInput,
  thawNoteRequest,
} from './freeze.ts';

const DESTINATION = { type: 'project', id: 7 };
const DOCUMENT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'written' }] }],
};

const frozen = (over = {}) =>
  freezeNoteRequest({
    destination: DESTINATION,
    title: 'A note',
    description: '',
    document: DOCUMENT,
    tags: [],
    idempotencyKey: 'key-1',
    ...over,
  });

const sent = (result) => {
  assert.equal(result.ok, true, result.ok ? '' : result.problem);

  return JSON.parse(result.request);
};

describe('freezing a note request', () => {
  it('asks for a note resource at an explicit parent id, in TipTap both ways', () => {
    const request = sent(frozen());

    assert.equal(request.type, 'resource');
    assert.equal(request.kind, 'note');
    assert.deepEqual(request.parent, { id: 7 });
    assert.equal(request.format, 'tiptap');
    assert.deepEqual(request.body, { format: 'tiptap', value: DOCUMENT });
    assert.deepEqual(request.tags, []);
    assert.equal(request.idempotencyKey, 'key-1');
  });

  /**
   * A logical attempt is the bytes that were sent, so the empty case must have one spelling.
   *
   * `CreateRequest.tags` is optional, so an empty list could be omitted or sent - and choosing
   * between them would make the frozen bytes depend on a client-side emptiness test. Two drafts that
   * are the same draft would then freeze to two requests under two fingerprints, and the server would
   * be asked the same question twice in two ways.
   */
  it('always sends tags, so an empty list has exactly one spelling', () => {
    const empty = frozen({ tags: [] }).request;

    assert.ok(empty.includes('"tags":[]'));
    // The same draft, frozen twice. Identical bytes, not merely equivalent requests.
    assert.equal(empty, frozen({ tags: [] }).request);
  });

  it('carries the tags it was given, in the order it was given them', () => {
    assert.deepEqual(sent(frozen({ tags: ['sync', 'design'] })).tags, ['sync', 'design']);
  });

  /**
   * A bound someone can reach from the details sheet is named, not swallowed.
   *
   * The sheet bounds nothing on purpose - the contract owns the numbers - so a long tag or a
   * twenty-sixth one is refused here. Without a named sentence the person gets "Raphael could not
   * prepare that request" over a tag they can see on screen, with nothing pointing at the cause and
   * Save repeating it forever. The editor already names the same mistake when the server refuses it.
   */
  it('names which tag bound was hit, rather than refusing the request unhelpfully', () => {
    const tooMany = Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, index) => `t${String(index)}`);
    const overCount = frozen({ tags: tooMany });

    assert.equal(overCount.ok, false);
    assert.equal(overCount.problem, TOO_MANY_TAGS_PROBLEM);
    assert.match(overCount.problem, /\b25\b/, 'it says how many are allowed');
    assert.match(overCount.problem, /Details/, 'and where to fix it');

    const overLength = frozen({ tags: ['a'.repeat(TAG_MAX_CODE_POINTS + 1)] });

    assert.equal(overLength.ok, false);
    assert.equal(overLength.problem, TAG_TOO_LONG_PROBLEM);
    assert.match(overLength.problem, /Details/);

    // Neither falls through to the sentence that names nothing.
    assert.notEqual(overCount.problem, UNPREPARABLE_PROBLEM);
    assert.notEqual(overLength.problem, UNPREPARABLE_PROBLEM);

    // And exactly at each bound still freezes, so the check is the contract's and not a stricter one.
    assert.equal(frozen({ tags: tooMany.slice(0, TAGS_MAX_COUNT) }).ok, true);
    assert.equal(frozen({ tags: ['a'.repeat(TAG_MAX_CODE_POINTS)] }).ok, true);
  });

  /**
   * A draft frozen before this build knew about tags must still replay.
   *
   * `tags` is declared `Schema.optional` with no default, so a stored request that never mentioned
   * them decodes to one that still does not - which is what keeps `thawNoteRequest`'s normalization
   * comparison quiet. Had it carried a default, every request frozen by the previous build would
   * come back `normalization_changed` and never be sent again.
   */
  it('replays a request frozen before tags existed, unchanged', () => {
    const stored = JSON.parse(frozen().request);
    delete stored.tags;
    const bytes = canonicalJson(stored);
    const thawed = thawNoteRequest(bytes);

    assert.equal(thawed.ok, true);
    assert.equal(canonicalJson(thawed.request), bytes, 'nothing was added on the way out');
  });

  it('refuses a title carrying a line break rather than repairing it', () => {
    // The composer turns a pasted break into a space where a person can still see it happen. A
    // title that reaches this boundary with one came from somewhere else - a draft written by an
    // older build, or a caller bypassing the field - and rewriting it here would mean the frozen
    // bytes are not the ones anyone approved, under a key the server may replay.
    for (const title of ['Field\nnotes', 'Field\r\nnotes', 'Field\u2028notes']) {
      const result = frozen({ title });

      assert.equal(result.ok, false);
      assert.match(result.problem, /one line/);
    }
  });

  it('omits a whitespace-only title instead of trimming one into existence', () => {
    const result = frozen({ title: '   ' });
    const request = sent(result);

    assert.equal('title' in request, false);
    // The recovery label records that no title was submitted. It is never authority for the one
    // core resolves from the content.
    assert.equal(result.title, '');
  });

  it('sends a written title exactly as typed', () => {
    const request = sent(frozen({ title: 'Kept  spacing ' }));

    assert.equal(request.title, 'Kept  spacing ');
  });

  it('keeps authored description whitespace and omits only an absent description', () => {
    assert.equal('description' in sent(frozen({ description: '' })), false);
    assert.equal(sent(frozen({ description: '  ' })).description, '  ');
  });

  it('sends the empty document as a body rather than omitting it', () => {
    // Omitting it would be equivalent on the server but would make the frozen request depend on a
    // client-side emptiness test.
    const request = sent(frozen({ document: createEmptyDocument() }));

    assert.deepEqual(request.body, {
      format: 'tiptap',
      value: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
  });

  it('refuses a title the contract will not accept, before anything is persisted', () => {
    const result = frozen({ title: 'x'.repeat(5000) });

    assert.equal(result.ok, false);
    assert.match(result.problem, /too long/);
  });

  it('refuses a body the transport contract will not carry', () => {
    // The contract checks that a document is transportable JSON within its limits; the canonical
    // vocabulary is core's and the editor's to enforce, and the owner only ever hands this a
    // snapshot the host has already validated structurally. Both checks exist; neither is this one.
    assert.equal(frozen({ document: 'not a document' }).ok, false);
    assert.equal(frozen({ document: null }).ok, false);
  });

  it('normalizes once, so freezing twice gives the same bytes', () => {
    assert.equal(frozen().request, frozen().request);
  });
});

describe('thawing a stored request', () => {
  it('returns what was frozen', () => {
    const result = thawNoteRequest(frozen().request);

    assert.equal(result.ok, true);
    assert.equal(canonicalJson(result.request), frozen().request);
  });

  it('refuses a stored request this build cannot decode, and says which failure it was', () => {
    assert.deepEqual(thawNoteRequest('not json'), { ok: false, reason: 'undecodable' });
    assert.deepEqual(thawNoteRequest('{"type":"resource"}'), { ok: false, reason: 'undecodable' });
  });

  it('refuses a stored request this build would normalize differently', () => {
    // A request missing the default this build materializes: it decodes, and decoding changes it.
    // Sending it would be sending something other than what was frozen, under the original key.
    const stored = JSON.parse(frozen().request);
    delete stored.format;

    assert.deepEqual(thawNoteRequest(canonicalJson(stored)), {
      ok: false,
      reason: 'normalization_changed',
    });
  });
});

describe('recovering what was submitted', () => {
  it('reads a decodable request exactly, and says it is complete', () => {
    const recovered = recoverNoteInput(frozen({ description: 'why' }).request, 'label');

    assert.deepEqual(recovered, {
      title: 'A note',
      description: 'why',
      tags: [],
      document: DOCUMENT,
      complete: true,
    });
  });

  it('reads a partially decodable request leniently and marks it incomplete', () => {
    // A body this build can no longer validate is still a body the person wrote. Nothing here
    // rewrites the stored bytes; it only reads what it can and refuses to call that whole.
    const stored = JSON.stringify({
      type: 'resource',
      kind: 'note',
      title: 'Half read',
      body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'summary' }] } },
    });
    const recovered = recoverNoteInput(stored, 'label');

    assert.equal(recovered.title, 'Half read');
    assert.equal(recovered.complete, false);
    assert.deepEqual(recovered.document, { type: 'doc', content: [{ type: 'summary' }] });
  });

  it('falls back to the stored label when nothing can be read at all', () => {
    assert.deepEqual(recoverNoteInput('{{{', 'label'), {
      title: 'label',
      description: '',
      tags: [],
      document: null,
      complete: false,
    });
  });
});
