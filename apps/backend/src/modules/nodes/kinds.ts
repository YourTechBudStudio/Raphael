import type { ResourceKind } from '@raphael/contracts/nodes';

/**
 * The resource kinds core admits, and the creation policy that differs by kind.
 *
 * Deliberately a table rather than a registry: there is no dynamic loading, no migration hook, no
 * route, and no per-kind service. It exists so that "a note may omit its title" is one fact with one
 * home, rather than a `kind === 'note'` test spread across preparation, diagnostics, and the CLI.
 *
 * The contract decoder already refuses an unsupported kind, so this table is consulted for policy and
 * never for admission. That separation is what keeps it from growing into an extension host.
 */
export interface ResourceKindDefinition {
  readonly kind: ResourceKind;
  /** Whether core resolves an omitted title from content for this kind. */
  readonly allowsOmittedTitle: boolean;
}

export const RESOURCE_KIND_DEFINITIONS: Readonly<Record<ResourceKind, ResourceKindDefinition>> = {
  note: { kind: 'note', allowsOmittedTitle: true },
};

/**
 * Whether a kind permits omitting a title. A container is not a kind and never reaches this.
 *
 * The lookup is destructured rather than indexed-and-dotted because the record is indexed by a closed
 * union: the compiler is right that an arbitrary index could miss, and answering that with a non-null
 * assertion would silence the one check that would catch a kind added to the vocabulary without a
 * definition. An absent definition means the table and the vocabulary disagree, which is a programming
 * error here rather than something a caller did.
 */
export const allowsOmittedTitle = (kind: ResourceKind): boolean => {
  const definition = RESOURCE_KIND_DEFINITIONS[kind];
  return definition === undefined ? false : definition.allowsOmittedTitle;
};
