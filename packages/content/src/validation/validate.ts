import { DOCUMENT_MAX_NODES } from '@raphael/contracts/nodes';

import { contentFailure, type ContentFailure } from '../failures.ts';
import { SUPPORTED_HEADING_LEVELS, SUPPORTED_MARKS, SUPPORTED_NODES } from '../index.ts';
import { isAllowedHref } from './url.ts';

/**
 * Strict document validation, run *before* deserialization.
 *
 * ProseMirror cannot be the validator here. `Node.fromJSON` silently drops attributes it does not
 * recognize, and `check()` accepts `heading` level 6 under a schema configured for 1-3, so a
 * document that "passes" can still be a document the author did not write. Everything unsupported is
 * therefore rejected here, while the structure still exists to reject.
 *
 * The walk is iterative. A deeply nested document must not be able to exhaust the stack in the very
 * function whose job is to bound it.
 */

const NODE_KEYS = new Set(['type', 'attrs', 'content', 'text', 'marks']);
const MARK_KEYS = new Set(['type', 'attrs']);

const NODE_ATTRS: Record<string, readonly string[]> = {
  heading: ['level'],
  orderedList: ['start', 'type'],
  codeBlock: ['language'],
};

const MARK_ATTRS: Record<string, readonly string[]> = { link: ['href'] };

const SUPPORTED_NODE_SET: ReadonlySet<string> = new Set(SUPPORTED_NODES);
const SUPPORTED_MARK_SET: ReadonlySet<string> = new Set(SUPPORTED_MARKS);
const HEADING_LEVEL_SET: ReadonlySet<number> = new Set(SUPPORTED_HEADING_LEVELS);

/** Matches the fence info-string policy: a bare language token, never a whole info string. */
export const CODE_LANGUAGE = /^[A-Za-z0-9+#._-]{1,32}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const attrFailure = (
  node: Record<string, unknown>,
  type: string,
  path: readonly number[],
): ContentFailure | undefined => {
  const attrs = node['attrs'];
  if (attrs === undefined) return undefined;
  if (!isObject(attrs)) return contentFailure('invalid_attribute_value', path, { element: type });

  const allowed = NODE_ATTRS[type] ?? [];
  for (const key of Object.keys(attrs)) {
    if (!allowed.includes(key))
      return contentFailure('unsupported_attribute', path, { element: type });
  }

  if (type === 'heading') {
    const level = attrs['level'];
    if (typeof level !== 'number' || !HEADING_LEVEL_SET.has(level)) {
      return contentFailure('invalid_attribute_value', path, { element: 'heading.level' });
    }
  }
  if (type === 'codeBlock') {
    const language = attrs['language'];
    if (language !== undefined && language !== null && typeof language !== 'string') {
      return contentFailure('invalid_attribute_value', path, { element: 'codeBlock.language' });
    }
    if (typeof language === 'string' && !CODE_LANGUAGE.test(language)) {
      return contentFailure('invalid_attribute_value', path, { element: 'codeBlock.language' });
    }
  }
  if (type === 'orderedList') {
    const start = attrs['start'];
    if (start !== undefined && start !== null) {
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) {
        return contentFailure('invalid_attribute_value', path, { element: 'orderedList.start' });
      }
    }
    // `type` exists upstream as an HTML list-marker style. Markdown has no equivalent and our
    // serializer never emits one, so only the schema default is accepted rather than stored.
    const listType = attrs['type'];
    if (listType !== undefined && listType !== null) {
      return contentFailure('invalid_attribute_value', path, { element: 'orderedList.type' });
    }
  }
  return undefined;
};

const markFailure = (marks: unknown, path: readonly number[]): ContentFailure | undefined => {
  if (marks === undefined) return undefined;
  if (!Array.isArray(marks)) return contentFailure('unsupported_mark', path);

  const seen = new Set<string>();
  for (const mark of marks) {
    if (!isObject(mark)) return contentFailure('unsupported_mark', path);
    for (const key of Object.keys(mark)) {
      if (!MARK_KEYS.has(key)) return contentFailure('unsupported_mark', path);
    }
    const type = mark['type'];
    if (typeof type !== 'string' || !SUPPORTED_MARK_SET.has(type)) {
      return contentFailure('unsupported_mark', path);
    }
    if (seen.has(type)) return contentFailure('duplicate_mark', path, { element: type });
    seen.add(type);

    const attrs = mark['attrs'];
    if (attrs !== undefined) {
      if (!isObject(attrs))
        return contentFailure('invalid_attribute_value', path, { element: type });
      const allowed = MARK_ATTRS[type] ?? [];
      for (const key of Object.keys(attrs)) {
        if (!allowed.includes(key)) {
          return contentFailure('unsupported_attribute', path, { element: type });
        }
      }
    }
    if (type === 'link') {
      const href = isObject(attrs) ? attrs['href'] : undefined;
      if (!isAllowedHref(href)) return contentFailure('invalid_link', path);
    }
  }
  return undefined;
};

interface Frame {
  readonly node: Record<string, unknown>;
  readonly path: readonly number[];
  /** Text inside a code block may hold line breaks; inline text may not. */
  readonly inCodeBlock: boolean;
}

/**
 * Inline text carries no line breaks. A newline in an inline text node has no Markdown
 * representation — `hardBreak` is how a line break is expressed — and no editor produces one, so
 * accepting it would store a document that cannot be exported without changing it. Code block text
 * is exempt, because line breaks are its whole point.
 */
const LINE_BREAK = /[\r\n]/u;

/**
 * Validates the whole document against the supported vocabulary and counts its nodes. Returns the
 * first failure, or `undefined` when the document is entirely supported.
 */
export const findDocumentFailure = (input: unknown): ContentFailure | undefined => {
  if (!isObject(input) || input['type'] !== 'doc') return contentFailure('invalid_document');

  let nodes = 0;
  const stack: Frame[] = [{ node: input, path: [], inCodeBlock: false }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, path, inCodeBlock } = frame;

    nodes += 1;
    if (nodes > DOCUMENT_MAX_NODES) {
      return contentFailure('document_too_many_nodes', path, { limit: DOCUMENT_MAX_NODES });
    }

    for (const key of Object.keys(node)) {
      if (!NODE_KEYS.has(key)) return contentFailure('unsupported_attribute', path);
    }

    const type = node['type'];
    if (typeof type !== 'string' || !SUPPORTED_NODE_SET.has(type)) {
      // The name is not ours, so it is not reported: unrecognized input is never reflected back.
      return contentFailure('unsupported_node', path);
    }

    if (type === 'text') {
      const text = node['text'];
      if (typeof text !== 'string' || text.length === 0)
        return contentFailure('invalid_text', path);
      if (!inCodeBlock && LINE_BREAK.test(text)) return contentFailure('invalid_text', path);
      if (node['content'] !== undefined) return contentFailure('invalid_document', path);
    } else if (node['text'] !== undefined) {
      return contentFailure('invalid_text', path);
    }

    const attrRejection = attrFailure(node, type, path);
    if (attrRejection !== undefined) return attrRejection;

    const markRejection = markFailure(node['marks'], path);
    if (markRejection !== undefined) return markRejection;

    const content = node['content'];
    if (content !== undefined) {
      if (!Array.isArray(content)) return contentFailure('invalid_document', path);
      const childInCodeBlock = type === 'codeBlock';
      for (let index = content.length - 1; index >= 0; index -= 1) {
        const child = content[index];
        if (!isObject(child)) return contentFailure('invalid_document', [...path, index]);
        stack.push({ node: child, path: [...path, index], inCodeBlock: childInCodeBlock });
      }
    }
  }
  return undefined;
};
