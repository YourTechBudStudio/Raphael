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
  SEARCH_PUNCTUATION_RULE,
  SEARCH_QUERIES_MAX_COUNT,
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MAX_TERMS,
  SLUG_GRAMMAR_DESCRIPTION,
  SLUG_MAX_CODE_POINTS,
  TAGS_MAX_COUNT,
  TAG_MAX_CODE_POINTS,
  TAG_MIN_CODE_POINTS,
  TITLE_MAX_CODE_POINTS,
  USER_ARCHIVE_OWNER,
  type NodeType,
} from '@raphael/contracts/nodes';

export const typeLabel = (type: NodeType): string =>
  type === 'resource' ? RESOURCE_KINDS.map((kind) => `${type}.${kind}`).join(', ') : type;

/**
 * A value that starts with `-` reads as another option unless it is joined to its flag with `=`, the
 * same advice the parser's refusal gives. `example` is the whole joined argument as it is typed.
 */
export const dashValueRule = (flag: string, example: string, what: string): string =>
  `A value that starts with -, such as ${what}, must be joined to its flag with =, as in \`${example}\`; otherwise it is read as another option and refused.${flag === '--body' ? ' A longer body is easier as a file or a pipe: `--body @list.md` or `--body @-`.' : ''}`;

export const HELP_RULES = {
  types: `Types: ${NODE_TYPES.flatMap((type) => typeLabel(type).split(', ')).join(', ')}. Items that can hold children: ${CONTAINER_TYPES.join(', ')}.`,
  // One sentence per parent, and per kind for a resource, so each starts with its own article.
  containment: Object.entries(PARENTAGE)
    .flatMap(([parent, children]) =>
      (parent === 'root'
        ? ['The root (/)']
        : typeLabel(parent as NodeType)
            .split(', ')
            .map((label) => `${/^[aeiou]/u.test(label) ? 'An' : 'A'} ${label}`)
      ).map((name) =>
        children.length === 0
          ? `${name} cannot hold children.`
          : `${name} can directly hold: ${children.map(typeLabel).join(', ')}.`,
      ),
    )
    .join('\n'),
  slug: `${SLUG_GRAMMAR_DESCRIPTION}. A slug may contain at most ${SLUG_MAX_CODE_POINTS} Unicode characters.`,
  fields: `Titles are required and may contain at most ${TITLE_MAX_CODE_POINTS} characters after trimming. Descriptions may contain at most ${DESCRIPTION_MAX_CODE_POINTS} characters. Give each tag its own --tag: ${TAG_MIN_CODE_POINTS}–${TAG_MAX_CODE_POINTS} characters per tag, at most ${TAGS_MAX_COUNT} tags. Tags are trimmed and NFC-normalized, are case-sensitive, and must not repeat or contain commas. Metadata is a JSON object set once at create: at most ${METADATA_MAX_TOP_LEVEL_KEYS} top-level keys, ${METADATA_MAX_DEPTH} levels deep, ${METADATA_MAX_KEY_CODE_POINTS} characters per key, and ${METADATA_MAX_SERIALIZED_BYTES} serialized UTF-8 bytes.`,
  paging: `The default page contains at most ${LIST_LIMIT_DEFAULT} results. --limit accepts ${LIST_LIMIT_MIN}–${LIST_LIMIT_MAX}; --skip skips results. At most ${SCOPES_MAX_COUNT} paths or ids may be searched or listed in one request.`,
  ordering: `--order-by accepts ${NODE_ORDER_FIELDS.join(', ')} with ${ORDER_DIRECTIONS.join(' or ')}; for example \`--order-by updatedAt:desc\`.`,
  filter: `--filter accepts a JSON object with keys ${FILTER_KEYS.join(', ')}. Allowed type values: ${NODE_TYPES.join(', ')}. Allowed kind values: ${RESOURCE_KINDS.join(', ')}. Each value is a scalar or {"$in":[...]}; sibling keys are ANDed. Tags match at least one supplied tag, with exact case after trimming and NFC normalization. A kind does not imply a type.`,
  search: `Search is recursive by default; use --direct for direct children only. Search everything with \`raphael search / -q auth\`. Matching includes titles, descriptions and note text. Repeat -q to OR queries together, at most ${SEARCH_QUERIES_MAX_COUNT} queries. Each query allows at most ${SEARCH_QUERY_MAX_CODE_POINTS} characters and ${SEARCH_QUERY_MAX_TERMS} words or quoted phrases. Words separated by spaces mean OR; uppercase AND binds more tightly than uppercase OR. Double quotes make a phrase. ${SEARCH_PUNCTUATION_RULE} Operators need a word or phrase on both sides. Lowercase and and or are ordinary search words. There are no parentheses, NOT, wildcards or field prefixes. Matching ignores case and accents; there is no stemming: token does not match tokens.`,
  // As `deriveTitle` reads it: the first line of the body's text that is not blank, whatever block
  // holds it, where each block and each hard line break starts a new line.
  derivedTitle: `Without --title, a note takes its title from the first line of the body's text that is not blank, in whatever block it is: a heading, paragraph, list item, quote or code block. Each block and each hard line break starts a new line; a soft line break reads as a space. With no such line, the description's first line that is not blank is used. Either is trimmed and cut at ${TITLE_MAX_CODE_POINTS} characters.`,
  dashValues: dashValueRule('--body', `--body='- first item'`, 'a Markdown list'),
  archiveCauses: `Archive causes print one per line, nearest first: directly, or through the archived container above the item, then who set the cause in parentheses. (${USER_ARCHIVE_OWNER}) is a cause set with archive; restore removes only that cause, and only on the item itself. JSON carries each cause as origin, owner and reason.`,
  content: `Body formats: ${BODY_FORMATS.join(', ')}. Supported Markdown heading levels: ${SUPPORTED_HEADING_LEVELS.join(', ')}. Supported document elements: ${SUPPORTED_NODES.join(', ')}. Supported text styles: ${SUPPORTED_MARKS.join(', ')}. Documents allow at most ${DOCUMENT_MAX_NODES} elements, nested at most ${DOCUMENT_MAX_DEPTH} levels deep counting each JSON object and array, so about half that many levels of elements. The complete serialized request may contain at most ${REQUEST_MAX_BYTES} UTF-8 bytes.`,
} as const;
