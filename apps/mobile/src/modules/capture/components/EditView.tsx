import { AlertCircle, Tag } from 'lucide-react-native';
import type { Ref } from 'react';
import { Text, View } from 'react-native';

import { Chip, colors, PressableFeedback } from '../../../ui';
import type {
  EditorCommand,
  EditorPort,
  EditorProblem,
  EditorSelectionState,
  EditorSnapshot,
} from '../../editor';
import { ArchiveIconToggle, READ_ONLY_DETAILS_HINT, type LifecycleView } from '../../lifecycle';
import type { ComposerStatus } from '../composer.ts';
import { CONFLICT_NOTICE, type DetailsChip, type EditComposerView } from '../edit-composer.ts';
import { ComposerShell, type ComposerEyebrow } from './ComposerShell';

export interface EditViewProps {
  title: string;
  description: string;
  /** Identity of the document under edit. Changing it replaces the renderer. */
  documentId: string;
  document: unknown;
  view: EditComposerView;
  /**
   * Where this is filed, deepest last, exactly as the note screen named it.
   *
   * Empty means the location could not be established, and the eyebrow is then absent rather than
   * blank: a phone that could not read where something lives must not say it lives at the root.
   */
  location: readonly string[];
  /** What the Details chip says and how it is spoken. Composed by `detailsChip`, never here. */
  details: DetailsChip;
  /**
   * The Move control in the eyebrow, from `moveControl`. Null keeps the eyebrow a label: a location
   * that could not be read cannot be moved from.
   */
  move: { readonly onPress: () => void; readonly disabled: boolean; readonly hint: string } | null;
  /**
   * Leaving is waiting for the server, so Close is unavailable and visibly so.
   *
   * Separate from `view.locked`, which is a protection barrier settling and disables the writing
   * instead. The two are different facts about different things and are never merged.
   */
  leaving: boolean;
  /**
   * The entity is archived: the fields and the renderer take no writing, and Details opens read-only.
   * Derived from the lifecycle the owner holds, never from the record's standing.
   */
  readOnly: boolean;
  /** The Archive toggle at the end of the top bar, and what the status line says instead of saving. */
  lifecycle: EditLifecycleProps;
  editorRef?: Ref<EditorPort> | undefined;
  /** Sends one formatting command to the renderer. The screen above holds the port. */
  onCommand: (command: EditorCommand) => void;
  selection: EditorSelectionState;
  onSelectionChange: (state: EditorSelectionState) => void;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSnapshot: (snapshot: EditorSnapshot) => void;
  onProblem?: ((problem: EditorProblem) => void) | undefined;
  onLinkPress?: ((href: string) => void) | undefined;
  onDetails: () => void;
  /** The band's only action. Confirmation is the composition's, never this component's. */
  onDiscard: () => void;
  onClose: () => void;
  testID?: string | undefined;
}

export interface EditLifecycleProps {
  /** Null when the phone could not read the causes: the toggle is unselected and still archives. */
  readonly view: LifecycleView | null;
  /** A request is running. */
  readonly busy: boolean;
  /** What is being edited, lowercased, for the toggle's spoken label. */
  readonly noun: string;
  /**
   * Said on the status line in place of the save status: the running request, the last action's
   * outcome, or why the screen is read-only. Null leaves the save status standing.
   */
  readonly status: ComposerStatus | null;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
}

/**
 * Editing something the server already holds: the creation screen's shape, under the other policy.
 *
 * `ComposerShell` is the screen; this is the half of it that only an existing entity has. There is no
 * Save, because an existing entity autosaves and the status line beside the close cross carries the
 * whole sync state instead. Where a new note offers a destination, this names where the entity is,
 * and the same eyebrow is the one way to move it: a move is its own guarded write through the owner,
 * never a field of the autosave.
 *
 * **The conflict band is the first row of the bar stack**, above the formatting row, on the bar's own
 * surface. It is a band rather than a pill because it is the one state this screen says with more than
 * a status line, and it is where the alert colour appears - the status line goes quiet while it shows,
 * which `editComposerView` decides.
 */
export function EditView({
  title,
  description,
  documentId,
  document,
  view,
  location,
  details,
  move,
  leaving,
  readOnly,
  lifecycle,
  editorRef,
  onCommand,
  selection,
  onSelectionChange,
  onTitleChange,
  onDescriptionChange,
  onSnapshot,
  onProblem,
  onLinkPress,
  onDetails,
  onDiscard,
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
        view.notice === null ? null : (
          <View
            accessibilityLiveRegion="polite"
            className="flex-row items-center gap-3 border-b border-line py-2 pl-4 pr-2"
            testID="edit-conflict"
          >
            <AlertCircle color={colors.danger} size={20} strokeWidth={2} />
            <Text className="flex-1 font-body text-[15px] leading-[20px] text-ink">
              {CONFLICT_NOTICE}
            </Text>
            <PressableFeedback
              accessibilityHint="Removes the changes kept on this phone and reopens your server’s version"
              accessibilityLabel="Discard my changes"
              accessibilityRole="button"
              className="h-11 justify-center rounded-full px-3"
              onPress={onDiscard}
              testID="edit-discard"
              treatment="button"
            >
              <Text className="font-body-semibold text-[15px] text-danger">Discard</Text>
            </PressableFeedback>
          </View>
        )
      }
      barLeading={
        <Chip
          // Still available while archived: the sheet opens read-only, and says so.
          accessibilityHint={readOnly ? READ_ONLY_DETAILS_HINT : details.hint}
          accessibilityLabel={details.spoken}
          disabled={view.locked}
          icon={Tag}
          label={details.label}
          onPress={onDetails}
          style={{ flexShrink: 1 }}
          testID="edit-details"
        />
      }
      // Leaving waits for the server to answer, and a disabled control says so where a silently
      // ignored tap would not.
      closeDisabled={leaving}
      closeHint={leaving ? 'Available once your server has answered' : undefined}
      description={description}
      document={document}
      documentId={documentId}
      editorRef={editorRef}
      eyebrow={eyebrow}
      locked={view.locked}
      namespace="edit"
      onClose={onClose}
      onCommand={onCommand}
      onDescriptionChange={onDescriptionChange}
      onLinkPress={onLinkPress}
      onProblem={onProblem}
      onSelectionChange={onSelectionChange}
      onSnapshot={onSnapshot}
      onTitleChange={onTitleChange}
      readOnly={readOnly}
      selection={selection}
      status={lifecycle.status ?? view.status}
      statusTrailing={
        <ArchiveIconToggle
          busy={lifecycle.busy}
          noun={lifecycle.noun}
          onArchive={lifecycle.onArchive}
          onRestore={lifecycle.onRestore}
          testID="edit-archive"
          view={lifecycle.view}
        />
      }
      testID={testID}
      title={title}
      titleLabel="Title"
      unprotected={view.problem !== null}
    />
  );
}
