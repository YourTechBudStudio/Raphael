import { Tag } from 'lucide-react-native';
import type { Ref } from 'react';

import { Chip, SavePill } from '../../../ui';
import type {
  EditorCommand,
  EditorPort,
  EditorProblem,
  EditorSelectionState,
  EditorSnapshot,
} from '../../editor';
import type { ComposerView, DestinationEyebrow } from '../composer.ts';
import type { DetailsChip } from '../edit-composer.ts';
import { ComposerShell, type ComposerEyebrow } from './ComposerShell';

export interface CaptureViewProps {
  title: string;
  description: string;
  /** Identity of the document under edit. Changing it replaces the renderer. */
  documentId: string;
  document: unknown;
  view: ComposerView;
  /** What the eyebrow says about where this goes. Composed by `destinationEyebrow`, never here. */
  destination: DestinationEyebrow;
  /** What the Details chip says and how it is spoken. Composed by `detailsChip`, never here. */
  details: DetailsChip;
  editorRef?: Ref<EditorPort> | undefined;
  /** Sends one formatting command to the renderer. The screen above holds the port. */
  onCommand: (command: EditorCommand) => void;
  /** Which commands apply and which are available. Held above, because the repair sheet reads it. */
  selection: EditorSelectionState;
  onSelectionChange: (state: EditorSelectionState) => void;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSnapshot: (snapshot: EditorSnapshot) => void;
  onProblem?: ((problem: EditorProblem) => void) | undefined;
  onLinkPress?: ((href: string) => void) | undefined;
  /** The pill: Save, Retry or Record it again, as the view decided. */
  onAction: () => void;
  onDestination: () => void;
  onDetails: () => void;
  onClose: () => void;
  testID?: string | undefined;
}

/**
 * Writing a note: the edit screen's shape, under the creation policy.
 *
 * `ComposerShell` is the screen; this is the half of it that only a note nobody has created yet has.
 * It adds the two things you can only do to writing that is still entirely yours: choose where it
 * goes, and decide when it is sent.
 *
 * **The destination is the eyebrow, not a chip**, in the same slot where an existing entity names
 * where it is filed - because it is the same fact, and on a new note it is still a choice. It stops
 * being a choice in two different ways, which the eyebrow says differently:
 *
 * - **Locked**, while a request is in the air. It stays a button, disabled, and the hint says it comes
 *   back, which is true.
 * - **Frozen**, once a request has answered for it. It becomes a plain label - the path is still
 *   there, only the press is gone - because the note is on the server at that place, moving is not in
 *   this story, and nothing the person waits for will change it. A permanently disabled button would
 *   promise otherwise.
 */
export function CaptureView({
  title,
  description,
  documentId,
  document,
  view,
  destination,
  details,
  editorRef,
  onCommand,
  selection,
  onSelectionChange,
  onTitleChange,
  onDescriptionChange,
  onSnapshot,
  onProblem,
  onLinkPress,
  onAction,
  onDestination,
  onDetails,
  onClose,
  testID,
}: CaptureViewProps) {
  const eyebrow: ComposerEyebrow = view.destinationFrozen
    ? { kind: 'label', label: destination.label, spoken: destination.spoken }
    : {
        kind: 'button',
        label: destination.label,
        spoken: destination.spoken,
        hint: destination.hint,
        disabled: view.locked,
        onPress: onDestination,
      };

  return (
    <ComposerShell
      barLeading={
        <Chip
          accessibilityHint={details.hint}
          accessibilityLabel={details.spoken}
          disabled={view.locked}
          icon={Tag}
          label={details.label}
          onPress={onDetails}
          style={{ flexShrink: 1 }}
          testID="capture-details"
        />
      }
      barTrailing={
        view.action.kind === 'none' ? undefined : (
          <SavePill
            accessibilityHint={view.action.hint}
            disabled={!view.action.enabled}
            label={view.action.label}
            onPress={onAction}
            testID="capture-action"
          />
        )
      }
      // Unavailable while a request is in the air, and visibly so. Leaving then would take the lock a
      // save is holding and leave the screen its outcome has nowhere to appear on - and a disabled
      // control says that, where a silently ignored tap would not.
      closeDisabled={view.locked}
      closeHint={view.locked ? 'Available once this note has finished saving' : undefined}
      description={description}
      document={document}
      documentId={documentId}
      editorRef={editorRef}
      eyebrow={eyebrow}
      locked={view.locked}
      namespace="capture"
      onClose={onClose}
      onCommand={onCommand}
      onDescriptionChange={onDescriptionChange}
      onLinkPress={onLinkPress}
      onProblem={onProblem}
      onSelectionChange={onSelectionChange}
      onSnapshot={onSnapshot}
      onTitleChange={onTitleChange}
      selection={selection}
      status={view.status}
      testID={testID}
      title={title}
      titleLabel="Note title"
      unprotected={view.problem !== null}
    />
  );
}
