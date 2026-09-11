import type { AnyExtension } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { Text } from '@tiptap/extension-text';

import { SUPPORTED_HEADING_LEVELS } from '../index.ts';

/**
 * Link carries only `href`. Upstream also defines `target`, `rel`, `class` and `title`, which are
 * rendering policy rather than authored content: storing them would put presentation decisions in
 * canonical data, grow every stored link, and give callers four more attributes to get wrong. A
 * renderer applies its own link handling.
 */
const CanonicalLink = Link.extend({
  addAttributes: () => ({ href: { default: null } }),
});

/**
 * The supported document schema, shared by validation here and by the editor later. Extensions are
 * listed individually and pinned rather than assembled from StarterKit: a starter bundle can gain
 * nodes in a patch release, which is precisely what an allowlist must not do.
 *
 * A fresh array is returned per call so no caller can mutate a shared configuration.
 */
export const contentExtensions = (): AnyExtension[] => [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: [...SUPPORTED_HEADING_LEVELS] }),
  BulletList,
  OrderedList,
  ListItem,
  CodeBlock,
  Blockquote,
  HorizontalRule,
  HardBreak,
  Bold,
  Italic,
  Strike,
  Code,
  CanonicalLink,
];
