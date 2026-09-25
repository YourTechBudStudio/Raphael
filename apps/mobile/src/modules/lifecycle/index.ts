/**
 * Archive and restore as the phone reads and words them: the pure view of an entity's causes, every
 * lifecycle sentence, and the controls that draw the state.
 *
 * It depends on no screen module. Capture, collections, resources and search all draw it, so reaching
 * any of them would be a cycle and would give the words a second owner.
 */

export {
  useLifecycleAction,
  type LifecycleAction,
  type LifecycleActionInput,
  type LifecycleFailure,
} from './client/actions';
export { ArchiveIconToggle, type ArchiveIconToggleProps } from './components/ArchiveIconToggle';
export { InheritedLine, type InheritedLineProps } from './components/InheritedLine';
export {
  ARCHIVE_LABEL,
  ARCHIVED_LABEL,
  ARCHIVED_LEFT_OUT_SENTENCE,
  ARCHIVED_PARENT_CREATION_SENTENCE,
  INCLUDE_ARCHIVED_HINT,
  INCLUDE_ARCHIVED_LABEL,
  READ_ONLY_DETAILS_HINT,
  UNAVAILABLE_WHILE_ARCHIVED_HINT,
  actionFailureSentence,
  archivedAlongside,
  archivedRefusalSentence,
  briefOutcome,
  iconToggleSpokenLabel,
  inheritedLine,
  inheritedLineParts,
  inheritedLineHint,
  outcomeSentence,
  readOnlyDetailsSubtitle,
  statusSentence,
  toggleHint,
  toggleSpokenLabel,
  type LifecycleResult,
  type LifecycleVerb,
} from './copy.ts';
export { lifecycleView, type LifecycleView } from './view.ts';
