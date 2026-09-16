import type { CanonicalDocument } from '@raphael/content';
import { deriveText } from '@raphael/content/schema';
import { TITLE_MAX_CODE_POINTS } from '@raphael/contracts/nodes';

/**
 * Resolving a title for a note that did not supply one.
 *
 * The rule is "use what the person already wrote", in one order, with no invention anywhere in it.
 * Body text first, then the plain description. A note with no usable text in either place is asked for
 * a title rather than given a generic one - "Untitled note" is a name nobody chose, and a list of them
 * is worse than a prompt.
 *
 * Candidates come from `deriveText` rather than a second walk over the document. That matters beyond
 * avoiding duplicate code: the title then comes from the same extraction the search projection uses, so
 * "what this note says" is read once rather than twice by two functions that could disagree. It also
 * means a Mermaid or code block contributes its source text, which is what someone who wrote only a
 * diagram would expect to see as the name.
 */

export type TitleSource = 'body' | 'description';

export interface ResolvedTitle {
  readonly title: string;
  readonly source: TitleSource;
}

/**
 * The first non-empty line of some text, trimmed and bounded, or undefined when there is none.
 *
 * Truncation counts code points, matching how the contract measures a title. Cutting by code point can
 * split a grapheme cluster; that is accepted, because the alternative is a segmentation dependency for
 * a bound almost nothing reaches, and the result is still valid text the person can change.
 */
const candidateFrom = (text: string): string | undefined => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const points = [...trimmed];
    const bounded =
      points.length <= TITLE_MAX_CODE_POINTS
        ? trimmed
        : points.slice(0, TITLE_MAX_CODE_POINTS).join('').trimEnd();
    // Truncation can leave nothing behind - 200 code points of whitespace followed by a word. That
    // exhausts this source rather than this line, because every later line is past the bound anyway.
    if (bounded.length === 0) return undefined;
    return bounded;
  }
  return undefined;
};

/**
 * Resolves a title for a kind that permits omitting one, or reports that nothing here can name it.
 *
 * Nothing beyond trimming is normalized. Internal whitespace, case, and Unicode form are left as
 * authored, exactly as an explicit title is.
 */
export const resolveOmittedTitle = (
  document: CanonicalDocument,
  description: string,
): ResolvedTitle | undefined => {
  const fromBody = candidateFrom(deriveText(document));
  if (fromBody !== undefined) return { title: fromBody, source: 'body' };

  const fromDescription = candidateFrom(description);
  if (fromDescription !== undefined) return { title: fromDescription, source: 'description' };

  return undefined;
};
