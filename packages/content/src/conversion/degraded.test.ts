import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import { DEGRADED_CONSTRUCTS, DEGRADED_CONSTRUCT_DESCRIPTIONS } from '../degraded.ts';
import { containsRawHtml } from './html.ts';
import { fromMarkdown, importMarkdown } from './import.ts';

/** Openers repeated before one closing delimiter they could all share. */
const CLOSED_SHAPES = [
  ['<!A', '>'],
  ['<!--', '-->'],
  ['<?', '?>'],
  ['<![CDATA[', ']]>'],
  ['<a b="x" ', '>'],
  ['<a ', '>'],
  ['</a', '>'],
  ['<a b="', '"'],
] as const;

const degraded = (markdown: string): readonly string[] => {
  const result = importMarkdown(markdown);
  assert.ok(Either.isRight(result), `expected a document, got ${JSON.stringify(result)}`);
  return result.right.degraded;
};

describe('degraded constructs', () => {
  it('reports each construct import keeps as source rather than as itself', () => {
    const cases: Record<(typeof DEGRADED_CONSTRUCTS)[number], readonly string[]> = {
      table: ['| a | b |\n| - | - |\n| 1 | 2 |', 'Before\n\n| a |\n|---|\n| 1 |\n\nAfter'],
      task_list: ['- [ ] Write it', '- [x] Done', '* [X] Done\n* plain', '1. [ ]'],
      image: [
        '![chart](https://example.com/c.png)',
        'See ![x](y.png "t") here.',
        // A destination the parser itself refuses is still an image the body cannot hold.
        '![x](data:text/html,hello)',
        '![x](javascript:alert(1))',
      ],
      raw_html: [
        'Some <b>bold</b> text.',
        '<div class="note">\nhello\n</div>',
        'Line <br/> break',
        'A <!-- comment --> here',
        "An <span data-x='1' hidden>attribute</span>",
        '- item with </em> close',
        // By CommonMark's own grammar this is an open tag `y` with attributes `and` and `y`.
        'if x<y and y>z then',
        // The parser decodes the entity in the text; the tag is still the one written.
        '<img src="a&amp;b">',
        'An <a title="&quot;q&quot;">entity</a> attribute',
        // Decoding can make the text ill-formed HTML; the source is what was written.
        '<input value="&quot;">',
        '<img alt="&quot;x&quot;">',
        '<input value=&#60;x>',
      ],
      // A relative destination has no base to resolve against, so the stored link would go nowhere.
      disallowed_link: [
        'See [notes](./notes.md).',
        'A [ftp](ftp://example.com/x) link',
        // The parser refuses these schemes itself, so they arrive as text, not as links.
        '[click](javascript:alert(1))',
        'A [file](file:///etc/passwd) link',
        '[x]( <VBScript:msgbox(1)>)',
        '[data](data:text/html,hi)',
        // Entities are decoded before the destination is judged, so this is javascript:.
        '[x](java&#x73;cript:alert(1))',
        // No label, so no text: it is reported when met, and kept as its source.
        '[](javascript:alert(1))',
        'Before [](./relative.md) after',
      ],
      deep_heading: ['#### Four', '###### Six'],
    };
    for (const construct of DEGRADED_CONSTRUCTS) {
      for (const markdown of cases[construct]) {
        assert.deepEqual(degraded(markdown), [construct], `${construct}: ${markdown}`);
      }
    }
  });

  it('reports several at once, in list order and each once', () => {
    assert.deepEqual(
      degraded('![a](b)\n\n| a |\n|---|\n| 1 |\n\n- [ ] x\n- [ ] y\n\n<i>z</i> ![c](d)'),
      ['table', 'task_list', 'image', 'raw_html'],
    );
  });

  it('does not report normalization or text that only looks like a construct', () => {
    for (const markdown of [
      '',
      '# Title\n\nPlain *text* and **bold**, a [link](https://example.com).',
      'a < b > c',
      'if x < y and y > z then',
      '1 <2 and 3> 0',
      'Use `<b>` for bold.',
      '```html\n<div>hi</div>\n```',
      '    <div>indented code</div>',
      '\\<b\\> is escaped',
      '\\<b> is escaped too',
      '&lt;b&gt; is an entity',
      '<https://example.com> is an autolink',
      '<me@example.com> is an email autolink',
      '$5 * 3 = $15_total_',
      '**Date:** today\n**Status:** draft',
      '- [link](https://example.com) item',
      '- [ x] not a checkbox',
      '- [] not a checkbox',
      'Text [ ] in the middle',
      // Only an item's first text can be a checkbox, not a later paragraph after the list.
      '- a\n\n[ ] not in a list',
      '- a\n\n  [ ] a second paragraph of the item',
      '```not a language! at all\ncode\n```',
      '### Three',
      '> quote <',
      '- a\n- b',
      // Asked for as literal text, or inside code.
      '\\[click](javascript:alert(1))',
      'Run `[click](javascript:alert(1))` to see',
      'javascript: is a scheme',
    ]) {
      assert.deepEqual(degraded(markdown), [], markdown);
    }
  });

  it('keeps a refused link with no label as its source', () => {
    const kept = importMarkdown('[](javascript:alert(1))');
    assert.ok(Either.isRight(kept));
    assert.deepEqual(kept.right.document.content, [
      { type: 'paragraph', content: [{ type: 'text', text: '[](javascript:alert(1))' }] },
    ]);
  });

  it('agrees with fromMarkdown on the document and on refusals', () => {
    for (const markdown of ['| a |\n|---|\n| 1 |', '# Hi', '<b>x</b>']) {
      const both = importMarkdown(markdown);
      assert.ok(Either.isRight(both));
      assert.deepEqual(both.right.document, Either.getOrThrow(fromMarkdown(markdown)));
    }
  });

  it('finds raw HTML in time proportional to the text, however it is arranged', () => {
    // Each of these restarted an unanchored search at every `<`; at 64K characters some took
    // seconds. Half a megabyte of each must now be quick, with room for a slow machine.
    for (const unit of [
      '<!--',
      '<?',
      '<![CDATA[',
      '<!A',
      '<a b ',
      '<a b="',
      "<a b='",
      '</a ',
      '\\<b>',
    ]) {
      const text = unit.repeat(Math.floor((512 * 1024) / unit.length));
      const started = performance.now();
      containsRawHtml(text, text);
      assert.ok(performance.now() - started < 1_000, `${unit} took too long`);
    }
  });

  it('imports a megabyte of openers sharing one closing delimiter in bounded memory', () => {
    // Each opener once recognized its own overlapping construct, and keeping them all ran out of a
    // 4 GiB heap at about 200 KB. The child gets a small heap, so holding more than the text fails.
    const importer = new URL('./import.ts', import.meta.url).href;
    const script = `
      const { importMarkdown } = await import(${JSON.stringify(importer)});
      for (const [open, close] of ${JSON.stringify(CLOSED_SHAPES)}) {
        const result = importMarkdown(open.repeat(Math.floor(1_000_000 / open.length)) + close);
        if (result._tag !== 'Right') throw new Error('refused ' + open);
      }`;
    const ran = spawnSync(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(ran.status, 0, ran.stderr);
  });

  it('describes every construct', () => {
    for (const construct of DEGRADED_CONSTRUCTS) {
      const description = DEGRADED_CONSTRUCT_DESCRIPTIONS[construct];
      assert.ok(description.name.length > 0 && description.kept.length > 0, construct);
    }
  });
});
