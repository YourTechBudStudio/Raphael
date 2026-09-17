import { AlertCircle, Tag, X } from 'lucide-react-native';
import { useRef, useState, type Ref } from 'react';
import { ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';

import {
  Chip,
  colors,
  ComposerBar,
  ComposerFrame,
  ComposerStatus,
  Eyebrow,
  IconButton,
  PressableFeedback,
} from '../../../ui';
import {
  EditorHost,
  EditorToolbar,
  type EditorCommand,
  type EditorPort,
  type EditorProblem,
  type EditorSelectionState,
  type EditorSnapshot,
} from '../../editor';
import { CONFLICT_NOTICE, type DetailsChip, type EditComposerView } from '../edit-composer.ts';
import { singleLineTitle, titleMaxHeight } from '../title.ts';

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
   * Leaving is waiting for the server, so Close is unavailable and visibly so.
   *
   * Separate from `view.locked`, which is a protection barrier settling and disables the writing
   * instead. The two are different facts about different things and are never merged.
   */
  leaving: boolean;
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

/**
 * Editing something the server already holds: the whole screen, one bar above the keyboard.
 *
 * Presentation and nothing else - no owner, no navigation, no decision about what may be sent. Every
 * sentence and every enabled control is a value passed in by something that asked the owner, which is
 * what makes this testable and what makes it honest.
 *
 * It is the same frame as writing a new note, because to a person it is the same screen. What differs
 * is what the epic says must: there is no Save, because an existing entity autosaves, and the status
 * line beside the close cross carries the whole sync state instead.
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
  leaving,
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
  /**
   * Whether the body is where writing is going.
   *
   * The body lives in a WebView, so its focus is not a native fact this screen can read. What it can
   * read is that the editor reported a selection and that neither native field has taken focus since,
   * which is the same thing from the person's side.
   */
  const [bodyActive, setBodyActive] = useState(false);
  const descriptionInput = useRef<TextInput>(null);
  const { fontScale } = useWindowDimensions();

  const segments = location.length > 2 ? ['…', ...location.slice(-2)] : location;

  return (
    <ComposerFrame
      bar={
        <View>
          {view.notice === null ? null : (
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
          )}
          <ComposerBar
            above={
              bodyActive && !view.locked ? (
                <EditorToolbar
                  active={selection.active}
                  available={selection.available}
                  locked={view.locked}
                  onCommand={onCommand}
                />
              ) : undefined
            }
            testID="edit-bar"
          >
            <Chip
              accessibilityHint={details.hint}
              accessibilityLabel={details.spoken}
              disabled={view.locked}
              icon={Tag}
              label={details.label}
              onPress={onDetails}
              style={{ flexShrink: 1 }}
              testID="edit-details"
            />
            <View style={{ flex: 1 }} />
          </ComposerBar>
        </View>
      }
      leading={
        <IconButton
          // Leaving waits for the server to answer, and a disabled control says so where a silently
          // ignored tap would not.
          accessibilityHint={leaving ? 'Available once your server has answered' : undefined}
          disabled={leaving}
          icon={X}
          label="Close"
          onPress={onClose}
          testID="edit-close"
        />
      }
      status={
        <ComposerStatus testID="edit-status" tone={view.status.tone}>
          {view.status.text}
        </ComposerStatus>
      }
      testID={testID}
    >
      <View className="flex-1">
        <ScrollView
          className="flex-none"
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Read-only, and there is nothing beside it that offers to move this: moving an entity is
              a different operation with different rules, and it is not in this story. */}
          {segments.length === 0 ? null : (
            <Eyebrow accessibilityLabel={`Filed in ${location.join(', ')}`} className="mb-1">
              {segments.join(' / ')}
            </Eyebrow>
          )}
          <TextInput
            accessibilityLabel="Title"
            className="font-heading text-[26px] leading-[32px] text-ink"
            editable={!view.locked}
            multiline
            onChangeText={(value) => {
              onTitleChange(singleLineTitle(value));
            }}
            onFocus={() => {
              setBodyActive(false);
            }}
            onSubmitEditing={() => {
              descriptionInput.current?.focus();
            }}
            placeholder="Title"
            returnKeyType="next"
            submitBehavior="blurAndSubmit"
            style={{ maxHeight: titleMaxHeight(fontScale) }}
            testID="edit-title"
            value={title}
          />
          <TextInput
            accessibilityLabel="Description"
            className="mt-1 font-body text-[15px] leading-[22px] text-ink"
            editable={!view.locked}
            onChangeText={onDescriptionChange}
            onFocus={() => {
              setBodyActive(false);
            }}
            placeholder="Add a description"
            ref={descriptionInput}
            testID="edit-description"
            value={description}
          />
        </ScrollView>

        <EditorHost
          document={document}
          documentId={documentId}
          editable={!view.locked}
          onLinkPress={onLinkPress}
          onProblem={onProblem}
          onSelectionChange={(state) => {
            onSelectionChange(state);
            setBodyActive(true);
          }}
          onSnapshot={onSnapshot}
          ref={editorRef}
          style={{ flex: 1, marginTop: 8 }}
          unprotected={view.problem !== null}
        />
      </View>
    </ComposerFrame>
  );
}
