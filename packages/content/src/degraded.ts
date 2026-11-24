import { SUPPORTED_HEADING_LEVELS } from './headings.ts';

/** The deepest supported heading, and the Markdown that opens the first level past it. */
const DEEPEST_HEADING = Math.max(...SUPPORTED_HEADING_LEVELS);

/**
 * Markdown constructs the canonical body cannot represent, and what import keeps of each.
 *
 * Import keeps each as its source, as text or inside a code block, so nothing the author wrote is
 * lost. What is lost is the construct itself - a table stops being a table - and that is worth telling
 * the author about. The exceptions are a link with no label: a link is a mark on text, and with no
 * text there is nothing to carry it, so it is left out; and a link's title, which the link mark has no
 * attribute for. A footnote is not a construct the parser knows, so its marker and its text stay as
 * plain text. Normalization is not on this list: escaping, joined soft line
 * breaks, another emphasis spelling or a dropped code-block language change how the Markdown is
 * written, not what it says.
 *
 * Fenced code is not here either. A fence whose info string is not a plain language keeps its source
 * inside a code block, so the block is still code.
 *
 * One list, so help, warnings and the strict refusal describe the same set. It lives in the
 * dependency-free entry point; detection needs the parser and lives in `@raphael/content/conversion`.
 */
export const DEGRADED_CONSTRUCTS = [
  'table',
  'task_list',
  'image',
  'raw_html',
  'disallowed_link',
  'empty_link',
  'link_title',
  'footnote',
  'deep_heading',
] as const;

export type DegradedConstruct = (typeof DEGRADED_CONSTRUCTS)[number];

/**
 * Each construct as a plain noun phrase, and what import does with it as a past participle phrase,
 * so either reads after "is" or "was": `a table` / `kept as Markdown source in a code block`.
 */
export const DEGRADED_CONSTRUCT_DESCRIPTIONS: Readonly<
  Record<DegradedConstruct, { readonly name: string; readonly outcome: string }>
> = {
  table: { name: 'a table', outcome: 'kept as Markdown source in a code block' },
  task_list: { name: 'a task list checkbox', outcome: 'kept as plain text' },
  image: { name: 'an image', outcome: 'kept as plain text' },
  raw_html: { name: 'raw HTML', outcome: 'kept as plain text' },
  disallowed_link: {
    name: 'a link whose destination is not allowed',
    outcome: 'kept as plain text',
  },
  empty_link: { name: 'a link with no label', outcome: 'left out' },
  link_title: { name: 'a link title', outcome: 'left out' },
  footnote: { name: 'a footnote', outcome: 'kept as plain text' },
  deep_heading: {
    name: `a heading deeper than level ${DEEPEST_HEADING} (${'#'.repeat(DEEPEST_HEADING + 1)} or more)`,
    outcome: 'kept as Markdown source in a code block',
  },
};
