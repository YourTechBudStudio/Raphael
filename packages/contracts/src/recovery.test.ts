import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SHUTTING_DOWN_REASON, projectRecoveryDetails } from './recovery.ts';
import type { JsonObject } from './shared/json.ts';

/**
 * These tests are written against a server we do not control.
 *
 * Today's backend already chooses every published detail field by hand and never spreads an error
 * instance, so none of the hostile payloads below can currently be produced by it. That is the point:
 * this projection defends against a future backend, a different server, or a proxy - so the cases
 * that matter are the ones our own server would never send.
 */

const project = (code: string, details: JsonObject) => projectRecoveryDetails(code, details);

describe('recovery detail projection', () => {
  describe('preserving what a person needs', () => {
    it('keeps the validated fields of an invalid_input rejection', () => {
      assert.deepEqual(
        project('invalid_input', {
          field: 'title',
          reason: 'slug_underivable',
          limit: 200,
          nodeType: 'resource',
        }),
        { field: 'title', reason: 'slug_underivable', limit: 200, nodeType: 'resource' },
      );
    });

    it('keeps the conflicting address and its scope', () => {
      assert.deepEqual(
        project('slug_conflict', { field: 'slug', slug: 'backend', scope: 'sibling' }),
        {
          field: 'slug',
          slug: 'backend',
          scope: 'sibling',
        },
      );
    });

    it('keeps a document location and its element name', () => {
      assert.deepEqual(
        project('unsupported_content', {
          field: 'body',
          reason: 'unsupported_node',
          path: [0, 3, 1],
          element: 'codeBlock',
          limit: 64,
        }),
        {
          field: 'body',
          reason: 'unsupported_node',
          path: [0, 3, 1],
          element: 'codeBlock',
          limit: 64,
        },
      );
    });

    it('keeps camelCase element names, which a lowercase identifier rule would discard', () => {
      for (const element of ['codeBlock', 'horizontalRule', 'bulletList', 'listItem']) {
        assert.deepEqual(
          project('unsupported_content', { element }),
          { element },
          `${element} should survive projection`,
        );
      }
    });
  });

  describe('preservation without interpretation', () => {
    it('preserves a well-formed reason this release has never heard of', () => {
      assert.deepEqual(project('invalid_input', { reason: 'title_contains_emoji' }), {
        reason: 'title_contains_emoji',
      });
    });

    it('does not let an unfamiliar reason impersonate the one reason clients act on', () => {
      // `shutting_down` is the only reason a client may read as a certainty claim, and only under
      // `storage_busy`. The projection preserves both of these; it is the caller's comparison that
      // must be exact, so what this asserts is that projection alone confers no meaning.
      const lookalike = project('storage_busy', { reason: 'shutting_down_soon' });
      assert.deepEqual(lookalike, { reason: 'shutting_down_soon' });
      assert.notEqual(lookalike.reason, SHUTTING_DOWN_REASON);

      const genuine = project('storage_busy', { reason: 'shutting_down' });
      assert.equal(genuine.reason, SHUTTING_DOWN_REASON);
    });

    it('preserves a reason this build does not recognize rather than dropping it', () => {
      // A self-hosted server is upgraded independently of an installed client, so a reason this build
      // has never heard of is ordinary rather than suspect - and it is exactly when forwarding what
      // the server said is more useful than saying nothing. Validating against a closed list here
      // would discard the informative value; the sanitizing above is what keeps it safe to show.
      //
      // `unsupported_node_type` used to be this example, back when it was a reason core produced for
      // a stored type the API could not represent. It is gone now that resources are public, which
      // makes it a genuine stand-in for a reason that is not in this build's vocabulary.
      assert.deepEqual(
        project('invalid_input', { reason: 'unsupported_node_type', nodeType: 'resource' }),
        { reason: 'unsupported_node_type', nodeType: 'resource' },
      );
    });
  });

  describe('hostile values inside recognized fields', () => {
    it('drops a terminal escape sequence hiding in a reason', () => {
      assert.deepEqual(project('invalid_input', { reason: '\u001b[2J\u001b[1;1Hgotcha' }), {});
    });

    it('drops a reason carrying a newline', () => {
      assert.deepEqual(project('invalid_input', { reason: 'busy\nX-Injected: yes' }), {});
    });

    it('drops a reason carrying a bidirectional override', () => {
      assert.deepEqual(project('invalid_input', { reason: 'safe\u202egnihtemos' }), {});
    });

    it('drops an oversized reason', () => {
      assert.deepEqual(project('invalid_input', { reason: 'a'.repeat(65) }), {});
      assert.deepEqual(project('invalid_input', { reason: 'a'.repeat(64) }), {
        reason: 'a'.repeat(64),
      });
    });

    it('drops an element name carrying a control character', () => {
      assert.deepEqual(project('unsupported_content', { element: 'code\u0007Block' }), {});
    });

    it('drops a field name that is not one of ours', () => {
      assert.deepEqual(project('invalid_input', { field: 'password' }), {});
      assert.deepEqual(project('invalid_input', { field: '__proto__' }), {});
    });

    it('drops a slug that is not a canonical address', () => {
      assert.deepEqual(project('slug_conflict', { slug: 'Not A Slug' }), {});
      assert.deepEqual(project('slug_conflict', { slug: '../../etc/passwd' }), {});
      assert.deepEqual(project('slug_conflict', { slug: 'a'.repeat(101) }), {});
    });

    it('drops a scope outside its closed set', () => {
      assert.deepEqual(project('slug_conflict', { scope: 'global' }), {});
    });

    it('drops unsafe and negative numbers', () => {
      for (const limit of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
        assert.deepEqual(project('payload_too_large', { limit }), {});
      }
      assert.deepEqual(project('payload_too_large', { limit: 0 }), { limit: 0 });
    });

    it('drops a whole location when any segment is unusable', () => {
      // A partial path would point at somewhere the failure did not happen.
      assert.deepEqual(project('unsupported_content', { path: [0, -1, 2] }), {});
      assert.deepEqual(project('unsupported_content', { path: [0, 'x', 2] }), {});
      assert.deepEqual(project('unsupported_content', { path: Array(33).fill(0) }), {});
    });

    it('drops an Allow value that is not a method list', () => {
      assert.deepEqual(project('method_not_allowed', { allow: 'POST' }), { allow: 'POST' });
      assert.deepEqual(project('method_not_allowed', { allow: 'POST, GET' }), {
        allow: 'POST, GET',
      });
      assert.deepEqual(project('method_not_allowed', { allow: 'post' }), {});
    });
  });

  describe('what never survives', () => {
    it('omits unknown properties beside a known code', () => {
      assert.deepEqual(
        project('slug_conflict', {
          field: 'slug',
          slug: 'backend',
          scope: 'sibling',
          apiKey: 'sk-live-not-a-real-key',
          stack: 'Error: at /home/owner/secrets.ts:12',
        }),
        { field: 'slug', slug: 'backend', scope: 'sibling' },
      );
    });

    it('omits a recognized property name used under a code that does not carry it', () => {
      // `slug` is meaningful under slug_conflict and meaningless under payload_too_large; a flat
      // allowlist would have let it through here.
      assert.deepEqual(project('payload_too_large', { slug: 'backend', limit: 1_048_576 }), {
        limit: 1_048_576,
      });
    });

    it('projects nothing for codes that carry no details', () => {
      for (const code of ['unauthorized', 'route_not_found', 'internal_error']) {
        assert.deepEqual(project(code, { reason: 'anything', field: 'title' }), {});
      }
    });

    it('projects nothing for a code this release does not recognize', () => {
      assert.deepEqual(project('quota_exceeded', { field: 'title', reason: 'over_quota' }), {});
    });

    it('does not read inherited properties', () => {
      const hostile = Object.create({ reason: 'inherited_reason' }) as JsonObject;
      assert.deepEqual(project('invalid_input', hostile), {});
    });

    it('never rejects an otherwise valid envelope because one detail was unusable', () => {
      assert.deepEqual(
        project('invalid_input', { field: 'title', reason: '\u001b[31m', limit: 200 }),
        { field: 'title', limit: 200 },
      );
    });
  });
});
