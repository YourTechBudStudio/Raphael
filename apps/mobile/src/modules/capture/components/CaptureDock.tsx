import { Text } from 'react-native';

import { UNAVAILABLE_WHILE_ARCHIVED_HINT } from '../../lifecycle/copy.ts';
import { useSheetsStore } from '../../navigation';
import { useNewNote } from '../client/new-note.ts';
import { CaptureBar } from './CaptureBar';

export interface CaptureDockProps {
  /** Raised by a notice below it, so nothing covers the pair. */
  lift?: number | undefined;
  /**
   * The screen it sits on shows an archived container. The pair stays in place and is unavailable:
   * the server refuses filing into it, and removing the pair would move what is under a thumb.
   */
  unavailable?: boolean | undefined;
  testID?: string | undefined;
}

/**
 * The capture pair, wired.
 *
 * It exists so the three screens that carry capture do not each repeat the same wiring, and so that
 * the one rule that matters - a draft is created before the composer opens - is expressed once. A
 * screen renders this; it does not know how a note is started.
 *
 * Mounted by the routes rather than by the screens inside `collections`, which keeps the dependency
 * pointing one way: capture reads the hierarchy to name a destination, and nothing in collections
 * needs to know that capture exists.
 */
export function CaptureDock({ lift, unavailable = false, testID }: CaptureDockProps) {
  const newNote = useNewNote();
  const openVoiceCapture = useSheetsStore((state) => state.openVoiceCapture);

  return (
    <>
      {newNote.problem === null ? null : (
        <Text
          accessibilityLiveRegion="assertive"
          className="absolute inset-x-5 bottom-28 font-body text-[15px] text-danger"
        >
          {newNote.problem}
        </Text>
      )}
      <CaptureBar
        busy={newNote.busy}
        lift={lift}
        onNewNote={newNote.start}
        onVoice={openVoiceCapture}
        testID={testID}
        unavailable={unavailable ? UNAVAILABLE_WHILE_ARCHIVED_HINT : undefined}
      />
    </>
  );
}
