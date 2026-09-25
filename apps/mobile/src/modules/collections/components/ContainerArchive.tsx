import { Text } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { ARCHIVE_MARK, ToggleLabel } from '../../../ui';
import {
  ARCHIVE_LABEL,
  InheritedLine,
  toggleHint,
  toggleSpokenLabel,
  type LifecycleAction,
  type LifecycleView,
} from '../../lifecycle';
import { openContainer } from '../../navigation';

/**
 * Archive on a container screen, and the lines under the toggle row: one shape for both screens.
 *
 * Archive is a state toggle, the last in the row. Its word is always "Archive"; it is filled while
 * the user's own archive is on this container, and pressing it then restores. It stays live in every
 * standing: archived only through a container above, pressing it adds the user's own archive, which
 * is what keeps this one archived once that container is restored. There is no separate Restore
 * button, no snackbar and no confirmation: the fill is the feedback and pressing again is the undo.
 */

export interface ArchiveToggleProps {
  view: LifecycleView;
  title: string;
  target: ContainerRef;
  /** The revision the screen's own Get read. */
  revision: number;
  action: LifecycleAction;
}

export function ArchiveToggle({ view, title, target, revision, action }: ArchiveToggleProps) {
  return (
    <ToggleLabel
      accessibilityHint={toggleHint(view)}
      accessibilityLabel={toggleSpokenLabel(view, title)}
      disabled={action.pending}
      label={ARCHIVE_LABEL}
      mark={ARCHIVE_MARK}
      onToggle={() => {
        action.run({ ref: target, revision, verb: view.canRestore ? 'restore' : 'archive' });
      }}
      selected={view.canRestore}
      testID="archive-toggle"
    />
  );
}

export interface ArchiveLinesProps {
  view: LifecycleView;
  action: LifecycleAction;
}

/**
 * What the toggle row cannot say: the last action's failure, then why this is archived when the
 * toggle does not show it. Nothing while a request runs - the busy ring says that on its own.
 */
export function ArchiveLines({ view, action }: ArchiveLinesProps) {
  const failure = action.pending ? null : action.failureMessage;

  return (
    <>
      {failure === null ? null : (
        <Text
          accessibilityLiveRegion="polite"
          className={[
            'mt-2 font-body text-[15px] leading-[22px]',
            action.failure === 'failed' ? 'text-danger' : 'text-ink-soft',
          ].join(' ')}
          testID="archive-failure"
        >
          {failure}
        </Text>
      )}
      <InheritedLine onOpen={openContainer} view={view} />
    </>
  );
}
