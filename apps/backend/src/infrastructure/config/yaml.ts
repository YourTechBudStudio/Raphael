import { readFileSync, statSync } from 'node:fs';

import * as YAML from 'yaml';

import { configurationFailure } from './errors.ts';

/**
 * Reading a configuration file as *data*, and nothing else.
 *
 * YAML is a large language. Almost none of it is configuration: anchors and aliases can expand a
 * small file into a very large object, explicit tags can ask the parser to construct values the
 * schema never described, merge keys can assemble a mapping the reader cannot see by looking at it,
 * and duplicate keys silently discard whichever value the author wrote first. This module's entire
 * job is to refuse all of that and hand back a plain JSON-shaped value.
 *
 * The parser's own defensive options are used, but they are not the guarantee. `maxAliasCount: 0`
 * fires during *conversion*, which is after parsing has already happened; a policy that depends on it
 * would be trusting one library option to stand in for a decision about what our file format is. So
 * the parsed representation is inspected directly: any alias, any anchor, and any explicit tag is
 * refused by name, before conversion runs at all.
 */

/**
 * The largest configuration file that will be read, in bytes. A configuration file is a handful of
 * scalars; this exists so a mistaken path at a huge file fails immediately instead of being read into
 * memory and parsed.
 */
export const CONFIG_MAX_BYTES = 64 * 1024;

const PARSE_OPTIONS = {
  // The 1.2 core schema only. No `yes`/`no` booleans, no sexagesimals, no implicit typing beyond
  // JSON's own vocabulary, so what an operator reads in the file is what the server receives.
  schema: 'core',
  version: '1.2',
  // A repeated key is an error rather than a silent last-one-wins. An operator who writes `port`
  // twice has a mistake in their file and needs to be told, not to have one of the two chosen.
  uniqueKeys: true,
  // Merge keys assemble a mapping from somewhere else in the file. Configuration should be readable
  // top to bottom.
  merge: false,
} as const satisfies YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions;

/** Refuse every construct that makes a YAML file mean more than it appears to. */
const rejectUnsafeConstructs = (document: YAML.Document.Parsed, path: string): void => {
  YAML.visit(document, {
    Node(_key, node) {
      if (YAML.isAlias(node)) {
        configurationFailure(
          'config_unsafe',
          `"${path}" uses a YAML alias (*name). Raphael's configuration is read literally; ` +
            `write the value out where it is used.`,
        );
      }
      if (node.anchor !== undefined) {
        configurationFailure(
          'config_unsafe',
          `"${path}" defines a YAML anchor (&${node.anchor}). Raphael's configuration is read ` +
            `literally; remove the anchor and write each value where it is used.`,
        );
      }
      if (node.tag !== undefined) {
        configurationFailure(
          'config_unsafe',
          `"${path}" uses an explicit YAML tag (${node.tag}). Raphael's configuration accepts ` +
            `plain strings, numbers, booleans, and mappings only.`,
        );
      }
    },
  });
};

/**
 * Read and parse a configuration file into plain data.
 *
 * An explicitly supplied path that cannot be read is a failure, never a silent fallback to defaults:
 * a typo in `--config` must not start a server with settings the operator did not choose.
 */
export const readConfigFile = (path: string): unknown => {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (cause) {
    configurationFailure(
      'config_unreadable',
      `cannot read the configuration file "${path}": ${(cause as Error).message}`,
      { cause },
    );
  }
  if (size > CONFIG_MAX_BYTES) {
    configurationFailure(
      'config_too_large',
      `the configuration file "${path}" is ${size} bytes, larger than the ${CONFIG_MAX_BYTES}-byte limit. ` +
        `A Raphael configuration file is a short document; check that the path points at the right file.`,
    );
  }

  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (cause) {
    configurationFailure(
      'config_unreadable',
      `cannot read the configuration file "${path}": ${(cause as Error).message}`,
      { cause },
    );
  }

  let documents: YAML.Document.Parsed[];
  try {
    documents = YAML.parseAllDocuments(source, PARSE_OPTIONS);
  } catch (cause) {
    configurationFailure(
      'config_malformed',
      `"${path}" is not valid YAML: ${(cause as Error).message}`,
      { cause },
    );
  }

  if (documents.length === 0) {
    configurationFailure('config_malformed', `"${path}" is empty.`);
  }
  if (documents.length > 1) {
    configurationFailure(
      'config_unsafe',
      `"${path}" contains ${documents.length} YAML documents. Raphael reads exactly one.`,
    );
  }

  const document = documents[0] as YAML.Document.Parsed;
  // Warnings are treated as errors. The one that matters most - an unresolvable custom tag - arrives
  // as a warning while the node is still constructed, so ignoring warnings would accept it.
  const problems = [...document.errors, ...document.warnings];
  const first = problems[0];
  if (first !== undefined) {
    // A repeated key is a mistake in an otherwise well-formed file; an unresolvable tag is the file
    // asking for a construct this format does not have. They are different things to fix, so they get
    // different reasons rather than one catch-all.
    const reason =
      first.code === 'DUPLICATE_KEY'
        ? 'config_invalid'
        : first.code === 'TAG_RESOLVE_FAILED'
          ? 'config_unsafe'
          : 'config_malformed';
    configurationFailure(reason, `"${path}" could not be read: ${first.message}`);
  }

  rejectUnsafeConstructs(document, path);

  try {
    // Belt to the inspection's braces: if an alias somehow reached here, conversion refuses rather
    // than expanding it.
    return document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    configurationFailure(
      'config_unsafe',
      `"${path}" could not be converted to plain configuration data: ${(cause as Error).message}`,
      { cause },
    );
  }
};
