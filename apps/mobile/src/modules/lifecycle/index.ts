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
} from './client/actions';
export { ArchiveIconToggle, type ArchiveIconToggleProps } from './components/ArchiveIconToggle';
export { InheritedLine, type InheritedLineProps } from './components/InheritedLine';
export {
  ARCHIVE_LABEL,
  ARCHIVED_LABEL,
  ARCHIVED_LEFT_OUT_SENTENCE,
  INCLUDE_ARCHIVED_HINT,
  INCLUDE_ARCHIVED_LABEL,
  READ_ONLY_DETAILS_HINT,
  UNAVAILABLE_WHILE_ARCHIVED_HINT,
  archivedAlongside,
  failedActionSentence,
  iconToggleSpokenLabel,
  inheritedLine,
  inheritedLineParts,
  inheritedLineHint,
  readOnlyDetailsSubtitle,
  statusSentence,
  toggleHint,
  toggleSpokenLabel,
  type LifecycleVerb,
} from './copy.ts';
export { lifecycleView, type LifecycleView } from './view.ts';
