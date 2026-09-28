import { Tag } from 'lucide-react-native';
import type { Ref } from 'react';

import { Chip } from '../../../ui';
import type {
  EditorCommand,
  EditorPort,
  EditorProblem,
  EditorSelectionState,
  EditorSnapshot,
} from '../../editor';
import { ArchiveIconToggle, READ_ONLY_DETAILS_HINT, type LifecycleView } from '../../lifecycle';
import type { DetailsChip, StatusLine } from '../copy.ts';
import { ComposerShell, type ComposerEyebrow } from './ComposerShell';
import { ConflictBand } from './ConflictBand';

export interface EditViewProps {
  title: string;
  description: string;
  /** Identity of the document under edit. Changing it replaces the renderer. */
  documentId: string;
  document: unknown;
  status: StatusLine;
  /** Where this is filed, deepest last. Empty draws no eyebrow rather than implying the top level. */
  location: readonly string[];
  details: DetailsChip;
  /** The Move control in the eyebrow. Null keeps the eyebrow a label. */
  move: { readonly onPress: () => void; readonly disabled: boolean; readonly hint: string } | null;
  /** The entity is archived: the fields and the renderer take no writing. */
  readOnly: boolean;
  archive: {
    readonly view: LifecycleView;
    readonly busy: boolean;
    readonly unavailable: string | undefined;
    readonly noun: string;
    readonly onArchive: () => void;
    readonly onRestore: () => void;
  };
  /** The conflict band's two ways out, or null when there is no conflict. */
  conflict: { readonly onTakeServers: () => void; readonly onKeepMine: () => void } | null;
  editorRef?: Ref<EditorPort> | undefined;
  onCommand: (command: EditorCommand) => void;
  selection: EditorSelectionState;
  onSelectionChange: (state: EditorSelectionState) => void;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSnapshot: (snapshot: EditorSnapshot) => void;
  onProblem?: ((problem: EditorProblem) => void) | undefined;
  onDetails: () => void;
  onClose: () => void;
  testID?: string | undefined;
}

/**
 * Editing something the server already holds. There is no Save: it autosaves, and the status line
 * beside Close says where the writing stands. The eyebrow names where it is filed and is the Move
 * control; the conflict band sits above the bar.
 */
export function EditView({
  title,
  description,
  documentId,
  document,
  status,
  location,
  details,
  move,
  readOnly,
  archive,
  conflict,
  editorRef,
  onCommand,
  selection,
  onSelectionChange,
  onTitleChange,
  onDescriptionChange,
  onSnapshot,
  onProblem,
  onDetails,
  onClose,
  testID,
}: EditViewProps) {
  const segments = location.length > 2 ? ['…', ...location.slice(-2)] : location;
  const spoken = `Filed in ${location.join(', ')}`;
  const eyebrow: ComposerEyebrow =
    segments.length === 0
      ? { kind: 'absent' }
      : move === null
        ? { kind: 'label', label: segments.join(' / '), spoken }
        : {
            kind: 'button',
            label: segments.join(' / '),
            spoken,
            hint: move.hint,
            disabled: move.disabled,
            onPress: move.onPress,
          };

  return (
    <ComposerShell
      barAbove={
        conflict === null ? null : (
          <ConflictBand onKeepMine={conflict.onKeepMine} onTakeServers={conflict.onTakeServers} />
        )
      }
      barLeading={
        <Chip
          // Still available while archived: the sheet opens read-only, and says so.
          accessibilityHint={readOnly ? READ_ONLY_DETAILS_HINT : details.hint}
          accessibilityLabel={details.spoken}
          icon={Tag}
          label={details.label}
          onPress={onDetails}
          style={{ flexShrink: 1 }}
          testID="edit-details"
        />
      }
      closeDisabled={false}
      description={description}
      document={document}
      documentId={documentId}
      editorRef={editorRef}
      eyebrow={eyebrow}
      locked={false}
      namespace="edit"
      onClose={onClose}
      onCommand={onCommand}
      onDescriptionChange={onDescriptionChange}
      onProblem={onProblem}
      onSelectionChange={onSelectionChange}
      onSnapshot={onSnapshot}
      onTitleChange={onTitleChange}
      readOnly={readOnly}
      selection={selection}
      status={status}
      statusTrailing={
        <ArchiveIconToggle
          busy={archive.busy}
          noun={archive.noun}
          onArchive={archive.onArchive}
          onRestore={archive.onRestore}
          testID="edit-archive"
          unavailable={archive.unavailable}
          view={archive.view}
        />
      }
      testID={testID}
      title={title}
      titleLabel="Title"
    />
  );
}
