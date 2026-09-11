import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { forTerminal, forTerminalBlock } from './output.ts';

/**
 * Server-provided text is data, not markup.
 *
 * A title, a description, a tag, an error message - all authored by someone and arriving over a
 * network. Written straight to a terminal, a control sequence in any of it can move the cursor,
 * recolour the screen, or redraw a line to say something other than what happened.
 */

describe('inline rendering', () => {
  it('escapes escape sequences and control characters', () => {
    assert.equal(forTerminal('a\u001b[31mred'), 'a\\u001b[31mred');
    assert.equal(forTerminal('bell\u0007'), 'bell\\u0007');
    assert.equal(forTerminal('del\u007f'), 'del\\u007f');
  });

  it('escapes newlines, so authored text cannot fake another field', () => {
    // This is the whole reason inline and block rendering differ. A title of `Backend` followed by a
    // newline and `slug: forged` would otherwise print a second labelled field that no server sent.
    assert.equal(forTerminal('Backend\nslug: forged'), 'Backend\\u000aslug: forged');
    assert.equal(forTerminal('a\rb'), 'a\\u000db');
    assert.equal(forTerminal('a\tb'), 'a\\u0009b');
  });

  it('escapes bidirectional overrides and isolates', () => {
    // These reorder what is displayed without changing what is stored, so the line a person reads
    // can differ from the value they would get back if they copied it.
    for (const control of ['\u202e', '\u202d', '\u2066', '\u2069', '\u200f']) {
      assert.equal(
        forTerminal(`a${control}b`).includes(control),
        false,
        control.codePointAt(0)?.toString(16),
      );
    }
  });

  it('leaves ordinary text alone, including non-Latin scripts and emoji', () => {
    for (const value of ['Backend', 'Ideas & notes', 'проект', '日本語', 'a 🔑 b']) {
      assert.equal(forTerminal(value), value);
    }
  });
});

describe('block rendering', () => {
  it('keeps the formatting a person asked to see', () => {
    // A Markdown body is printed as its own region, after a blank line. Escaping its newlines would
    // make the command useless for reading a note.
    const body = '# Heading\n\n- one\n- two\n';
    assert.equal(forTerminalBlock(body), body);
    assert.equal(forTerminalBlock('a\tb'), 'a\tb');
  });

  it('still escapes anything that steers the terminal', () => {
    assert.equal(forTerminalBlock('a\u001b[2Jb'), 'a\\u001b[2Jb');
    assert.equal(forTerminalBlock('a\u0007b'), 'a\\u0007b');
  });
});
