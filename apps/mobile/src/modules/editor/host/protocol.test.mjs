/**
 * The bridge grammar as native enforces it.
 *
 * Two properties matter more than the individual cases. Nothing a refusal says can contain what was
 * refused - a diagnostic that echoes an untrusted payload is a leak with a reassuring name. And
 * authored content that crosses the other way is data on arrival and data on delivery: it is never
 * interpolated into source, whatever it contains.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BRIDGE_MAX_CHARS } from '../bridge.ts';
import {
  encodeHostMessage,
  hostMessageFits,
  inspectSnapshotDocument,
  receiveEnvelope,
} from './protocol.ts';

const doc = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const snapshot = (over = {}) =>
  JSON.stringify({
    type: 'snapshot',
    sessionId: 1,
    editSeq: 1,
    document: doc('hello'),
    reason: 'edit',
    ...over,
  });

describe('envelopes', () => {
  it('drops an oversized envelope before it is parsed', () => {
    // Deliberately unparsable as well: if the size check ran second, this would read `unparsable`.
    const oversized = `{"type":"snapshot",${'x'.repeat(BRIDGE_MAX_CHARS)}`;
    assert.deepEqual(receiveEnvelope(oversized), { kind: 'refused', refusal: 'too_large' });
  });

  it('refuses malformed JSON without throwing', () => {
    assert.deepEqual(receiveEnvelope('{"type":'), { kind: 'refused', refusal: 'unparsable' });
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 42, { type: 'snapshot' }]) {
      assert.equal(receiveEnvelope(value).kind, 'refused');
    }
  });

  it('refuses an unknown message type and a non-object envelope', () => {
    for (const value of ['"text"', '[]', '{"type":"explode"}', '{"sessionId":1}']) {
      assert.deepEqual(receiveEnvelope(value), {
        kind: 'refused',
        refusal: 'unsupported_message',
      });
    }
  });

  it('never carries any part of a refused payload', () => {
    const refusal = receiveEnvelope('{"type":"explode","secret":"the note body"}');
    assert.equal(JSON.stringify(refusal).includes('the note body'), false);
    assert.deepEqual(Object.keys(refusal).sort(), ['kind', 'refusal']);
  });
});

describe('snapshot shape', () => {
  it('accepts a well-formed one, correlated or not', () => {
    const plain = receiveEnvelope(snapshot());
    assert.equal(plain.kind, 'message');
    assert.equal('requestId' in plain.message, false);

    const correlated = receiveEnvelope(snapshot({ reason: 'requested', requestId: 4 }));
    assert.equal(correlated.message.requestId, 4);
  });

  for (const [label, over] of [
    ['a fractional sequence', { editSeq: 1.5 }],
    ['a sequence beyond safe integers', { editSeq: Number.MAX_SAFE_INTEGER + 2 }],
    ['a negative sequence', { editSeq: -1 }],
    ['a session id of zero', { sessionId: 0 }],
    ['a reason it does not have', { reason: 'guess' }],
    ['a fractional request id', { requestId: 0.5 }],
  ]) {
    it(`refuses ${label}`, () => {
      assert.equal(receiveEnvelope(snapshot(over)).kind, 'refused');
    });
  }

  it('refuses a snapshot with no document at all, rather than reading it as an empty one', () => {
    assert.equal(
      receiveEnvelope('{"type":"snapshot","sessionId":1,"editSeq":1,"reason":"edit"}').kind,
      'refused',
    );
  });

  it('accepts an explicitly null document and lets validation refuse it', () => {
    const result = receiveEnvelope(snapshot({ document: null }));
    assert.equal(result.kind, 'message');
    assert.notEqual(inspectSnapshotDocument(result.message.document), undefined);
  });
});

describe('selection and rejection shape', () => {
  it('refuses an action name outside the vocabulary', () => {
    const raw = JSON.stringify({
      type: 'selection',
      sessionId: 1,
      state: { active: ['bold'], available: ['bold', 'summonDemon'] },
    });
    assert.equal(receiveEnvelope(raw).kind, 'refused');
  });

  it('copies the selection arrays rather than keeping the decoded ones', () => {
    const state = { active: ['bold'], available: ['bold', 'undo'] };
    const result = receiveEnvelope(JSON.stringify({ type: 'selection', sessionId: 1, state }));
    assert.deepEqual(result.message.state, state);
  });

  it('refuses a rejection code it does not know', () => {
    const raw = JSON.stringify({ type: 'rejected', sessionId: 1, code: 'because' });
    assert.equal(receiveEnvelope(raw).kind, 'refused');
  });

  it('accepts every code it does know', () => {
    for (const code of [
      'invalid_document',
      'unsupported_message',
      'too_large',
      'locked',
      'composing',
    ]) {
      const raw = JSON.stringify({ type: 'rejected', sessionId: 1, code });
      assert.equal(receiveEnvelope(raw).message.code, code);
    }
  });
});

describe('structural acceptance', () => {
  it('passes a supported document', () => {
    assert.equal(inspectSnapshotDocument(doc('fine')), undefined);
  });

  it('refuses an unsupported node, naming only our own vocabulary', () => {
    const failure = inspectSnapshotDocument({ type: 'doc', content: [{ type: 'image' }] });
    assert.equal(failure.reason, 'unsupported_node');
    assert.equal('element' in failure, false);
  });

  it('bounds transport before it walks anything', () => {
    let nested = { type: 'paragraph' };
    for (let depth = 0; depth < 200; depth += 1) {
      nested = { type: 'blockquote', content: [nested] };
    }
    const failure = inspectSnapshotDocument({ type: 'doc', content: [nested] });
    assert.equal(failure.reason, 'document_too_deep');
  });

  it('is not a claim of canonical validity', () => {
    // A heading inside a code block is structurally supported vocabulary and an invalid content
    // model. The WebView and core refuse it; this gate is a necessary condition, never an acceptance.
    const document = {
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'heading', attrs: { level: 1 } }] }],
    };
    assert.equal(inspectSnapshotDocument(document), undefined);
  });
});

describe('what is sent to the WebView', () => {
  /** Runs the injected script the way the WebView would, and returns what `receive` was handed. */
  const deliver = (message) => {
    let received;
    const window = {
      __raphaelEditor: {
        receive: (raw) => {
          received = raw;
        },
      },
    };
    // eslint-disable-next-line no-new-func
    new Function('window', encodeHostMessage(message))(window);
    assert.equal(typeof received, 'string', 'the payload must arrive as a string, not as source');
    return JSON.parse(received);
  };

  it('delivers an ordinary message unchanged', () => {
    const message = { type: 'init', sessionId: 1, document: doc('hello'), editable: true };
    assert.deepEqual(deliver(message), message);
  });

  it('delivers hostile-looking authored content as data, not as source', () => {
    const hostile = [
      '");window.stolen=1;//',
      '</script><script>window.stolen=1;</script>',
      'a\u2028b\u2029c',
      '\\"\\\\',
      '\u0000\u001f',
    ].join('\n');
    const message = { type: 'init', sessionId: 1, document: doc(hostile), editable: true };
    const delivered = deliver(message);
    assert.deepEqual(delivered, message);
    assert.equal(delivered.document.content[0].content[0].text, hostile);
  });

  it('never leaves a raw line separator in the injected source', () => {
    const script = encodeHostMessage({
      type: 'init',
      sessionId: 1,
      document: doc('a\u2028b'),
      editable: true,
    });
    assert.equal(script.includes('\u2028'), false);
    assert.equal(script.includes('\u2029'), false);
  });

  it('measures a host message against the same bound the other side applies', () => {
    const small = { type: 'requestSnapshot', sessionId: 1, requestId: 1 };
    assert.equal(hostMessageFits(small), true);

    const huge = {
      type: 'init',
      sessionId: 1,
      document: doc('x'.repeat(BRIDGE_MAX_CHARS)),
      editable: true,
    };
    assert.equal(hostMessageFits(huge), false);
  });
});
