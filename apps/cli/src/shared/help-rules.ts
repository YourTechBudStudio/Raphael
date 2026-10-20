/** Product rule descriptions assembled from the same public vocabulary that requests use. */
import { SUPPORTED_HEADING_LEVELS, SUPPORTED_MARKS, SUPPORTED_NODES } from '@raphael/content';
import { REQUEST_MAX_BYTES } from '@raphael/contracts';
import {
  BODY_FORMATS,
  CONTAINER_TYPES,
  DESCRIPTION_MAX_CODE_POINTS,
  DOCUMENT_MAX_DEPTH,
  DOCUMENT_MAX_NODES,
  FILTER_KEYS,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  METADATA_MAX_DEPTH,
  METADATA_MAX_KEY_CODE_POINTS,
  METADATA_MAX_SERIALIZED_BYTES,
  METADATA_MAX_TOP_LEVEL_KEYS,
  NODE_ORDER_FIELDS,
  NODE_TYPES,
  ORDER_DIRECTIONS,
  PARENTAGE,
  RESOURCE_KINDS,
  SCOPES_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MAX_TERMS,
  SLUG_GRAMMAR_DESCRIPTION,
  SLUG_MAX_CODE_POINTS,
  TAGS_MAX_COUNT,
  TAG_MAX_CODE_POINTS,
  TAG_MIN_CODE_POINTS,
  TITLE_MAX_CODE_POINTS,
  type NodeType,
} from '@raphael/contracts/nodes';

export const typeLabel = (type: NodeType): string =>
  type === 'resource' ? RESOURCE_KINDS.map((kind) => `${type}.${kind}`).join(', ') : type;

export const HELP_RULES = {
  types: `Types: ${NODE_TYPES.flatMap((type) => typeLabel(type).split(', ')).join(', ')}. Items that can hold children: ${CONTAINER_TYPES.join(', ')}.`,
  containment: Object.entries(PARENTAGE)
    .map(([parent, children]) => {
      const name = parent === 'root' ? 'The root (/)' : typeLabel(parent as NodeType);
      return children.length === 0
        ? `${name} cannot hold children.`
        : `${name} can directly hold ${children.map(typeLabel).join(', ')}.`;
    })
    .join('\n'),
  slug: `${SLUG_GRAMMAR_DESCRIPTION}. A slug may contain at most ${SLUG_MAX_CODE_POINTS} Unicode characters.`,
  fields: `Titles are required and may contain at most ${TITLE_MAX_CODE_POINTS} characters after trimming. Descriptions may contain at most ${DESCRIPTION_MAX_CODE_POINTS} characters. Give each tag its own --tag: ${TAG_MIN_CODE_POINTS}–${TAG_MAX_CODE_POINTS} characters per tag, at most ${TAGS_MAX_COUNT} tags. Tags are trimmed and NFC-normalized, are case-sensitive, and must not repeat or contain commas. Metadata is a JSON object set once at create: at most ${METADATA_MAX_TOP_LEVEL_KEYS} top-level keys, ${METADATA_MAX_DEPTH} levels deep, ${METADATA_MAX_KEY_CODE_POINTS} characters per key, and ${METADATA_MAX_SERIALIZED_BYTES} serialized UTF-8 bytes.`,
  paging: `The default page contains at most ${LIST_LIMIT_DEFAULT} results. --limit accepts ${LIST_LIMIT_MIN}–${LIST_LIMIT_MAX}; --skip skips results. At most ${SCOPES_MAX_COUNT} paths or ids may be searched or listed in one request.`,
  ordering: `--order-by accepts ${NODE_ORDER_FIELDS.join(', ')} with ${ORDER_DIRECTIONS.join(' or ')}; for example --order-by updatedAt:desc.`,
  filter: `--filter accepts a JSON object with keys ${FILTER_KEYS.join(', ')}. Allowed type values: ${NODE_TYPES.join(', ')}. Allowed kind values: ${RESOURCE_KINDS.join(', ')}. Each value is a scalar or {"$in":[...]}; sibling keys are ANDed. Tags match at least one supplied tag, with exact case after trimming and NFC normalization. A kind does not imply a type.`,
  search: `Search is recursive by default; use --direct for direct children only. Search everything with raphael search / -q auth. Matching includes titles, descriptions and note text. Repeat -q to OR queries together, at most ${SEARCH_QUERIES_MAX_COUNT} queries. Each query allows at most ${SEARCH_QUERY_MAX_CODE_POINTS} characters and ${SEARCH_QUERY_MAX_TERMS} words or quoted phrases. Adjacent words mean OR; uppercase AND binds more tightly than uppercase OR. Double quotes make a phrase. Operators need a word or phrase on both sides. Lowercase and and or are ordinary search words. There are no parentheses, NOT, wildcards or field prefixes. Matching ignores case and accents; there is no stemming: token does not match tokens. Punctuation separates words: auth* matches auth, not authentication.`,
  content: `Body formats: ${BODY_FORMATS.join(', ')}. Supported Markdown heading levels: ${SUPPORTED_HEADING_LEVELS.join(', ')}. Supported document elements: ${SUPPORTED_NODES.join(', ')}. Supported text styles: ${SUPPORTED_MARKS.join(', ')}. Documents allow at most ${DOCUMENT_MAX_DEPTH} levels and ${DOCUMENT_MAX_NODES} elements. The complete serialized request may contain at most ${REQUEST_MAX_BYTES} UTF-8 bytes.`,
} as const;
