/**
 * The two sentences that differ between Home's Notes section and a container's.
 *
 * Copy rather than a component, so the section itself has no branch on which screen it is drawn on.
 * Both variants are flat lines under the heading: a section with nothing to show is not content, and
 * a card saying so would claim otherwise.
 */
export interface NoteSectionCopy {
  /** Read successfully, and there is nothing here. */
  readonly empty: string;
  /** The list could not be read. Also shown beside cards from an earlier reading. */
  readonly failed: string;
}

/** Home: everything on the server, and what an account with nothing in it is told. */
export const HOME_NOTES_COPY: NoteSectionCopy = {
  // The frozen sentence for this line names New note, which Phase 06 restores along with the
  // control. Until the control is on the screen, pointing someone at it would be a lie of the exact
  // kind this section exists to avoid.
  empty: 'No notes yet.',
  failed: 'Unable to load notes. Pull down to try again.',
};

/** An area or a project: the notes filed in it, and nothing from underneath it. */
export const CONTAINER_NOTES_COPY: NoteSectionCopy = {
  empty: 'No notes found.',
  failed: 'Unable to load notes.',
};
