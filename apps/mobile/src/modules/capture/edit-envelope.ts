/**
 * What to send, what that would produce, and whether the server already has it.
 *
 * Pure, and the three functions form one loop: `diff` says what must be sent to move the server from
 * the base to what is on screen; `applyEnvelope` says what the base becomes once that is
 * acknowledged; `matchesSubmitted` says whether an entity read back after a lost answer is what
 * sending that envelope would have produced.
 *
 * What is in flight has a second kind besides an update: a move, which carries the parent it asked for
 * and no authored field at all. A mobile move never renames, so it has nothing for `applyEnvelope` to
 * apply; only `matchesSubmitted` has to tell whether one landed.
 *
 * The rule the loop turns on: **the base is what this phone sent, never what the server echoed
 * back.** So `diff` and `applyEnvelope` work in the editor's raw values and never normalize anything.
 * A base re-seeded from the server's form - trimmed title, NFC tags, canonicalized document - while
 * the editor keeps its own form would diff as changed after every acknowledgement, and autosave would
 * never stop. Local-versus-local equality cannot loop.
 *
 * `matchesSubmitted` is the one function that crosses into the server's form, because it is the only
 * one comparing against something the server produced. It normalizes exactly as the server does, and
 * its failure direction is the one that keeps the person's writing.
 */

import type {
  NodeEntity,
  TipTapDocumentTransport,
  UpdateRequestInput,
} from '@raphael/contracts/nodes';
import { normalizeTag } from '@raphael/contracts/nodes';

import { displayableDocument } from './edit-display.ts';
import type { EditContent } from './edit-types.ts';

/**
 * The change fields of an update, and nothing else.
 *
 * Derived from the contract's own input type rather than restated, so a field the envelope gains is a
 * field this picks up. `target`, `revision` and `format` are the owner's to supply at dispatch; they
 * are not part of what changed, and an envelope that carried them could not be compared against
 * another one for sameness of intent.
 */
export type UpdateEnvelope = Pick<
  UpdateRequestInput,
  'title' | 'description' | 'slug' | 'body' | 'addTags' | 'removeTags'
>;

/**
 * What is in flight for a record: an authored update, or a move, each exactly as sent.
 *
 * A move carries the parent it asked for and never a slug: on this phone an ID changes only through an
 * ordinary update. `expectsWrite` is whether the requested parent differed from the owner's confirmed
 * one, decided at dispatch and kept with the envelope. A same-location move writes nothing and leaves
 * the revision alone, so after a lost answer a revision above the base can only be someone else's
 * write - and after a process death the envelope is the only place that fact survives.
 */
export type InflightEnvelope =
  | { readonly kind: 'update'; readonly envelope: UpdateEnvelope }
  | { readonly kind: 'move'; readonly parentId: number | null; readonly expectsWrite: boolean };

/** Serialized document equality. Both sides come from the editor, so this is a local comparison. */
const sameDocument = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * What must be sent to move the server from `base` to `current`. Null when nothing differs.
 *
 * Raw values throughout. Tags are set differences rather than a replacement list, because that is what
 * the contract accepts and because it is the only form that says what the person did rather than what
 * they ended up with: two clients adding different tags to the same entity both get their tag.
 *
 * A first accepted version after open may diff as a body change even when only the title was touched,
 * if the editor's serialization of the loaded document differs structurally from the server's
 * canonical form. That is bounded to one write per open - the base then holds the editor's form - and
 * it is accepted rather than designed around.
 */
export const diff = (base: EditContent, current: EditContent): UpdateEnvelope | null => {
  const added = current.tags.filter((tag) => !base.tags.includes(tag));
  const removed = base.tags.filter((tag) => !current.tags.includes(tag));

  // Conditional spreads rather than assignment onto a builder: under `exactOptionalPropertyTypes` a
  // present-but-undefined property is not the same as an absent one, and absence is precisely what
  // "this field is unchanged" means to the contract.
  //
  // Each tag list is omitted when empty rather than sent as `[]`. An empty list is a *mention* of a
  // change field, so the contract would accept it as an ordinary write that bumps the revision and
  // alters nothing.
  const envelope: UpdateEnvelope = {
    ...(current.title === base.title ? {} : { title: current.title }),
    ...(current.description === base.description ? {} : { description: current.description }),
    ...(current.slug === base.slug ? {} : { slug: current.slug }),
    ...(sameDocument(current.document, base.document)
      ? {}
      : {
          // `as` rather than a validation: the document is one the editor canonicalized and the host
          // structurally validated, and the request decode at dispatch is what proves it.
          body: { format: 'tiptap' as const, value: current.document as TipTapDocumentTransport },
        }),
    ...(added.length === 0 ? {} : { addTags: added }),
    ...(removed.length === 0 ? {} : { removeTags: removed }),
  };

  return Object.keys(envelope).length === 0 ? null : envelope;
};

/**
 * The tag list `envelope` produces over `base`, in the server's own order.
 *
 * Kept tags in stored order with removals dropped, then additions not already present in submitted
 * order. Reproducing that order exactly is not cosmetic: this list becomes the next base, and an order
 * that disagreed with the server's would make the following diff non-empty forever.
 */
const applyTags = (base: EditContent, envelope: UpdateEnvelope): readonly string[] => {
  const removed = new Set(envelope.removeTags ?? []);
  const kept = base.tags.filter((tag) => !removed.has(tag));
  const added = (envelope.addTags ?? []).filter((tag) => !kept.includes(tag));

  return [...kept, ...added];
};

/**
 * `base` with `envelope` applied, in the editor's own values: the next base after an acknowledgement.
 *
 * Never normalized, for the reason the module header gives. This is what was *sent*, which is the
 * thing the next diff has to be taken against.
 */
export const applyEnvelope = (base: EditContent, envelope: UpdateEnvelope): EditContent => ({
  title: envelope.title ?? base.title,
  description: envelope.description ?? base.description,
  slug: envelope.slug ?? base.slug,
  tags: applyTags(base, envelope),
  document: envelope.body === undefined ? base.document : envelope.body.value,
});

/**
 * Whether the server's entity is what sending `envelope` over `base` would have produced.
 *
 * Asked only when an answer was lost, and answered so that the person's own applied change is
 * recognized as applied rather than reported as a conflict. It compares under the normalization the
 * server applies, so a trimmed title or an NFC-normalized tag is a match and not a difference.
 *
 * **The revision is a precondition, not decoration.** Exactly one write has happened since the base,
 * and every carried field says what we sent: together those mean the write was ours. Without it, the
 * fields could match by coincidence after a third party's write, and acknowledging would advance
 * `baseRevision` past a change this phone never read.
 *
 * **The body is only compared when the envelope carried one.** A body we did not submit is not
 * evidence about whether our envelope applied, and comparing the base's editor-form document against
 * the server's canonical form would report a conflict for every title-only save whose answer was lost.
 * A third party's concurrent body change is caught by the next revision-guarded write, which is the
 * answer for every other concurrent change.
 *
 * Failure direction is the safe one for the bytes: any mismatch is a conflict, which keeps the
 * person's writing.
 */
const matchesAuthored = (
  entity: NodeEntity,
  envelope: UpdateEnvelope,
  base: EditContent,
  baseRevision: number,
): boolean => {
  if (entity.revision !== baseRevision + 1) return false;

  // The backend trims; `TitleInput` only validates. So the stored title is the trim of what was sent,
  // whether that came from the envelope or was left as the base's own - which may itself carry the
  // whitespace it was sent with.
  if (entity.title !== (envelope.title ?? base.title).trim()) return false;
  if (entity.description !== (envelope.description ?? base.description)) return false;
  if (entity.slug !== (envelope.slug ?? base.slug)) return false;

  if (envelope.body !== undefined) {
    // `tiptap` because every Get and every update this owner sends asks for it.
    if (entity.body.format !== 'tiptap') return false;
    if (!sameDocument(envelope.body.value, entity.body.value)) return false;
  }

  const expected = applyTags(base, envelope).map(normalizeTag);
  const stored = entity.tags.map(normalizeTag);

  return expected.length === stored.length && expected.every((tag, index) => tag === stored[index]);
};

/**
 * Whether the server's entity is what sending `inflight` over `base` would have produced.
 *
 * Asked only when an answer was lost, and answered so that the person's own applied change is
 * recognized as applied rather than reported as a conflict. It compares under the normalization the
 * server applies, so a trimmed title or an NFC-normalized tag is a match and not a difference.
 *
 * **The revision is a precondition, not decoration.** Exactly one write has happened since the base,
 * and every carried field says what we sent: together those mean the write was ours. Without it, the
 * fields could match by coincidence after a third party's write, and acknowledging would advance
 * `baseRevision` past a change this phone never read.
 *
 * **The body is only compared when the envelope carried one.** A body we did not submit is not
 * evidence about whether our envelope applied, and comparing the base's editor-form document against
 * the server's canonical form would report a conflict for every title-only save whose answer was lost.
 * A third party's concurrent body change is caught by the next revision-guarded write, which is the
 * answer for every other concurrent change.
 *
 * **A move is matched by its parent, over unchanged authored fields.** One that expected no write can
 * never match: it cannot have produced a revision above the base, and a rival's body-only write at
 * base + 1 would otherwise pass every comparison, since a move carries no body to compare.
 *
 * Failure direction is the safe one for the bytes: any mismatch is a conflict, which keeps the
 * person's writing.
 */
export const matchesSubmitted = (
  entity: NodeEntity,
  inflight: InflightEnvelope,
  base: EditContent,
  baseRevision: number,
): boolean => {
  if (inflight.kind === 'update') {
    return matchesAuthored(entity, inflight.envelope, base, baseRevision);
  }

  if (!inflight.expectsWrite) return false;
  if (entity.parentId !== inflight.parentId) return false;

  return matchesAuthored(entity, {}, base, baseRevision);
};

/** Every property a stored move may have. */
const MOVE_FIELDS = new Set(['kind', 'parentId', 'expectsWrite']);

/**
 * The persisted grammar of the `inflight` column, exactly.
 *
 * - no `kind` property: a legacy update envelope, stored bare, as every row written before moves is;
 * - `kind: 'move'`: a move, whose `parentId` is null or a positive safe integer, whose `expectsWrite`
 *   is a boolean, and which carries nothing else this build would have to ignore - a `slug` included,
 *   because this phone never sends one with a move;
 * - any other present `kind`, `null` among them: not something this build wrote.
 *
 * Null means the row is retained as unreadable rather than reinterpreted as an update. `UpdateEnvelope`
 * has no `kind` field, so a bare update can never be mistaken for a tagged value.
 */
export const readInflight = (value: object): InflightEnvelope | null => {
  if (!Object.hasOwn(value, 'kind')) return { kind: 'update', envelope: value as UpdateEnvelope };

  const candidate = value as { kind?: unknown; parentId?: unknown; expectsWrite?: unknown };

  if (candidate.kind !== 'move') return null;
  if (Object.keys(value).some((field) => !MOVE_FIELDS.has(field))) return null;

  const { parentId, expectsWrite } = candidate;
  const parentOk =
    parentId === null ||
    (typeof parentId === 'number' && Number.isSafeInteger(parentId) && parentId > 0);

  if (!parentOk || typeof expectsWrite !== 'boolean') return null;

  return { kind: 'move', parentId, expectsWrite };
};

/** `readInflight`'s inverse: an update is stored bare, exactly as before moves; a move is tagged. */
export const serializeInflight = (inflight: InflightEnvelope): string =>
  JSON.stringify(
    inflight.kind === 'update'
      ? inflight.envelope
      : { kind: 'move', parentId: inflight.parentId, expectsWrite: inflight.expectsWrite },
  );

/**
 * An entity as content, for seeding a record. Null when its body is not one this build can open.
 *
 * The refusal is the store's own posture applied at the boundary where an entity arrives: a body this
 * build cannot display is named rather than repaired or silently emptied.
 */
export const contentOf = (entity: NodeEntity): EditContent | null => {
  const document = displayableDocument(entity.body);

  if (document === null) return null;

  return {
    title: entity.title,
    description: entity.description,
    slug: entity.slug,
    tags: entity.tags,
    document,
  };
};
