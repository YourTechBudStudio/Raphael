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
  // The frozen sentence, restored with the control it names. Phase 05 held the second half back
  // because New note was absent and pointing someone at a control that was not on the screen would
  // have been the exact lie this section exists to avoid.
  empty:
    'No notes yet. Whatever is on your mind goes in with New note, and can find its place later.',
  failed: 'Unable to load notes. Pull down to try again.',
};

/** An area or a project: the notes filed in it, and nothing from underneath it. */
export const CONTAINER_NOTES_COPY: NoteSectionCopy = {
  empty: 'No notes found.',
  failed: 'Unable to load notes.',
};
