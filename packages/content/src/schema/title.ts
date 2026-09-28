import { TITLE_MAX_CODE_POINTS } from '@raphael/contracts/nodes';

import type { CanonicalDocument } from '../index.ts';
import { deriveText } from './text.ts';

/**
 * The first non-empty line, trimmed and cut to the title bound. Cutting by code point can split a
 * grapheme cluster; that is accepted rather than adding a segmentation dependency.
 */
const firstLine = (text: string): string | undefined => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const bounded = [...trimmed].slice(0, TITLE_MAX_CODE_POINTS).join('').trimEnd();
    // Every later line is past the bound too, so nothing further can name it.
    return bounded.length === 0 ? undefined : bounded;
  }
  return undefined;
};

/**
 * A title from what the person already wrote: the body's first line, then the description's. Nothing
 * is invented, so a note with no usable text has no title and the caller must ask for one.
 */
export const deriveTitle = (document: CanonicalDocument, description: string): string | undefined =>
  firstLine(deriveText(document)) ?? firstLine(description);
