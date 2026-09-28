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
import type { DestinationEyebrow, DetailsChip, StatusLine } from '../copy.ts';
import { ComposerShell } from './ComposerShell';

export interface CaptureViewProps {
  title: string;
  description: string;
  /** Identity of the document under edit. Changing it replaces the renderer. */
  documentId: string;
  document: unknown;
  status: StatusLine;
  /** The pill: Save, Saving… or Try now. */
  action: { readonly label: string; readonly enabled: boolean };
  /** A Save is waiting for the server: the fields, the destination and Close wait with it. */
  saving: boolean;
  destination: DestinationEyebrow;
  details: DetailsChip;
  editorRef?: Ref<EditorPort> | undefined;
  onCommand: (command: EditorCommand) => void;
  selection: EditorSelectionState;
  onSelectionChange: (state: EditorSelectionState) => void;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSnapshot: (snapshot: EditorSnapshot) => void;
  onProblem?: ((problem: EditorProblem) => void) | undefined;
  onSave: () => void;
  onDestination: () => void;
  onDetails: () => void;
  onClose: () => void;
  testID?: string | undefined;
}

/**
 * Writing a new note: the editor's shape, plus the two things only a draft has - a destination that
 * can still be chosen, and a Save.
 */
export function CaptureView({
  title,
  description,
  documentId,
  document,
  status,
  action,
  saving,
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
  onSave,
  onDestination,
  onDetails,
  onClose,
  testID,
}: CaptureViewProps) {
  return (
    <ComposerShell
      barLeading={
        <Chip
          accessibilityHint={details.hint}
          accessibilityLabel={details.spoken}
          disabled={saving}
          icon={Tag}
          label={details.label}
          onPress={onDetails}
          style={{ flexShrink: 1 }}
          testID="capture-details"
        />
      }
      barTrailing={
        <SavePill
          accessibilityHint="Creates this note on your server"
          disabled={!action.enabled}
          label={action.label}
          onPress={onSave}
          testID="capture-action"
        />
      }
      closeDisabled={saving}
      closeHint={saving ? 'Available once your server has answered' : undefined}
      description={description}
      document={document}
      documentId={documentId}
      editorRef={editorRef}
      eyebrow={{
        kind: 'button',
        label: destination.label,
        spoken: destination.spoken,
        hint: destination.hint,
        disabled: saving,
        onPress: onDestination,
      }}
      locked={saving}
      namespace="capture"
      onClose={onClose}
      onCommand={onCommand}
      onDescriptionChange={onDescriptionChange}
      onProblem={onProblem}
      onSelectionChange={onSelectionChange}
      onSnapshot={onSnapshot}
      onTitleChange={onTitleChange}
      selection={selection}
      status={status}
      testID={testID}
      title={title}
      titleLabel="Note title"
    />
  );
}
