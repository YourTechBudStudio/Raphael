/**
 * Freezing a request, and refusing to rewrite one.
 *
 * The fixed point is the cheap half: a stored request, decoded again, must be the same request. The
 * half that matters is what happens when it is not - a build that would normalize it differently
 * must refuse to send it rather than quietly send something else under a key the server may already
 * associate with the original.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, freezeRequest, recoverInput, thawRequest } from './freeze.ts';

const input = (over = {}) => ({
  target: { type: 'area', parentAreaId: null },
  title: 'Work',
  body: '',
  idempotencyKey: 'k-1',
  ...over,
});

describe('freezing', () => {
  it('addresses the root by path and a parent by id', () => {
    const atRoot = JSON.parse(freezeRequest(input()).request);
    assert.deepEqual(atRoot.parent, { path: '/' });

    const inArea = JSON.parse(
      freezeRequest(input({ target: { type: 'project', parentAreaId: 12 } })).request,
    );
    assert.deepEqual(inArea.parent, { id: 12 });
  });

  it('writes the materialized defaults out rather than relying on them', () => {
    const frozen = JSON.parse(freezeRequest(input()).request);

    assert.equal(frozen.format, 'markdown');
    assert.equal(frozen.idempotencyKey, 'k-1');
  });

  it('omits description always, and body only when it is exactly empty', () => {
    const empty = JSON.parse(freezeRequest(input({ body: '' })).request);
    assert.equal('body' in empty, false);
    assert.equal('description' in empty, false);

    // Whitespace someone typed is content. Trimming it here would change what they wrote.
    const spaces = JSON.parse(freezeRequest(input({ body: '   ' })).request);
    assert.deepEqual(spaces.body, { format: 'markdown', value: '   ' });
  });

  it('normalizes the title and refuses one that is not a title', () => {
    assert.equal(JSON.parse(freezeRequest(input({ title: '  Work  ' })).request).title, 'Work');

    const empty = freezeRequest(input({ title: '   ' }));
    assert.equal(empty.ok, false);
    assert.match(empty.problem, /title/i);

    const long = freezeRequest(input({ title: 'x'.repeat(500) }));
    assert.equal(long.ok, false);
  });

  it('produces the same text for the same request whatever order it was built in', () => {
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  });
});

describe('thawing', () => {
  it('is a fixed point for anything this build froze', () => {
    for (const body of ['', 'notes', '  ', '# heading\n\nand text']) {
      const frozen = freezeRequest(input({ body }));
      const thawed = thawRequest(frozen.request);

      assert.equal(thawed.ok, true);
      assert.equal(canonicalJson(thawed.request), frozen.request);
    }
  });

  it('refuses a stored request that no longer decodes', () => {
    assert.deepEqual(thawRequest('{"type":"nonsense"}'), {
      ok: false,
      reason: 'undecodable',
    });
    assert.deepEqual(thawRequest('not json at all'), { ok: false, reason: 'undecodable' });
  });

  it('refuses a stored request that decodes but would normalize differently', () => {
    // Valid, but missing the default this build materializes. Sending it would send something other
    // than what was frozen, under the key the server already knows.
    const stored = JSON.stringify({
      type: 'area',
      parent: { path: '/' },
      title: 'Work',
      idempotencyKey: 'k-1',
    });

    assert.deepEqual(thawRequest(stored), { ok: false, reason: 'normalization_changed' });
  });
});

describe('recovering what was authored', () => {
  it('returns the title and body exactly as they were written', () => {
    for (const body of ['', 'notes', '   ', '# heading\n\nand text']) {
      const frozen = freezeRequest(input({ title: 'Work', body }));
      const recovered = recoverInput(frozen.request, 'fallback');

      assert.deepEqual(recovered, { title: 'Work', body, complete: true });
    }
  });

  it('reads what it can from a request this build can no longer validate', () => {
    // A body the contract would now refuse is still a body the person wrote. Showing it back is
    // strictly better than showing them nothing - but it is marked incomplete, because a lenient
    // read cannot establish that it saw everything.
    const stored = JSON.stringify({
      type: 'area',
      parent: { path: '/' },
      title: 'Work',
      body: { format: 'markdown', value: 'the note that must not vanish' },
      idempotencyKey: 'k-1',
    });

    assert.deepEqual(recoverInput(stored, 'fallback'), {
      title: 'Work',
      body: 'the note that must not vanish',
      complete: false,
    });
  });

  it('falls back to the stored title when nothing can be parsed', () => {
    assert.deepEqual(recoverInput('not json', 'Work'), {
      title: 'Work',
      body: '',
      complete: false,
    });
  });
});
