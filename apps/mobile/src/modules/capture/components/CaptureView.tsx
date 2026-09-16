import { Layers, X } from 'lucide-react-native';
import { useRef, useState, type Ref } from 'react';
import { ScrollView, TextInput, useWindowDimensions, View } from 'react-native';

import {
  Chip,
  ComposerBar,
  ComposerFrame,
  ComposerStatus,
  IconButton,
  SavePill,
} from '../../../ui';
import {
  EditorHost,
  EditorToolbar,
  type EditorPort,
  type EditorProblem,
  type EditorSelectionState,
  type EditorSnapshot,
  type EditorCommand,
} from '../../editor';
import type { ComposerView } from '../composer.ts';
import { singleLineTitle, titleMaxHeight } from '../title.ts';

export interface CaptureViewProps {
  title: string;
  description: string;
  /** Identity of the document under edit. Changing it replaces the renderer. */
  documentId: string;
  document: unknown;
  view: ComposerView;
  /** `parent / leaf`, elided above that, or null until somewhere has been chosen. */
  destinationLabel: string | null;
  /** The whole path, spoken. The chip shows two segments; a screen reader gets all of them. */
  destinationSpoken: string | null;
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
  onClose: () => void;
  testID?: string | undefined;
}

/**
 * Writing a note: the whole screen, one bar above the keyboard.
 *
 * Presentation, and deliberately nothing else - no owner, no navigation, no decision about what may
 * be sent. That is what makes it testable, and it is also what makes it honest: every sentence and
 * every enabled control on this screen is a value passed in by something that asked the owner.
 *
 * It is the same frame as a saved note, because to a person it is the same screen. What it adds is
 * the things you can only do to writing that is still yours: a title and description you can type
 * into, a body you can format, a place to choose, and one action.
 */
export function CaptureView({
  title,
  description,
  documentId,
  document,
  view,
  destinationLabel,
  destinationSpoken,
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
  onClose,
  testID,
}: CaptureViewProps) {
  /**
   * Whether the body is where writing is going.
   *
   * The body lives in a WebView, so its focus is not a native fact this screen can read. What it can
   * read is that the editor reported a selection and that neither native field has taken focus
   * since - which is the same thing from the person's side, and is what decides whether the
   * formatting row is there.
   */
  const [bodyActive, setBodyActive] = useState(false);
  const descriptionInput = useRef<TextInput>(null);
  // Two lines of the title, at whatever size this person reads at. A fixed cap is two lines only at
  // the default scale, and clips the second line for exactly those who asked for larger text.
  const { fontScale } = useWindowDimensions();

  const chipLabel = destinationLabel ?? 'Where?';
  const chipSpoken =
    destinationSpoken === null ? 'Choose where this note goes' : `Filed in ${destinationSpoken}`;

  return (
    <ComposerFrame
      bar={
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
          testID="capture-bar"
        >
          <Chip
            accessibilityHint="Chooses the area or project this note goes in"
            accessibilityLabel={chipSpoken}
            // Frozen once a request answers for it: changing where a note goes after asking a
            // server to create it there would make the frozen request mean something else.
            disabled={view.locked || view.destinationFrozen}
            icon={Layers}
            label={chipLabel}
            onPress={onDestination}
            style={{ flexShrink: 1 }}
            testID="capture-destination"
          />
          <View style={{ flex: 1 }} />
          {view.action.kind === 'none' ? null : (
            <SavePill
              accessibilityHint={view.action.hint}
              disabled={!view.action.enabled}
              label={view.action.label}
              onPress={onAction}
              testID="capture-action"
            />
          )}
        </ComposerBar>
      }
      leading={
        <IconButton
          // Unavailable while a request is in the air, and visibly so. Leaving then would take the
          // lock a save is holding and leave the screen its outcome has nowhere to appear on - and
          // a disabled control says that, where a silently ignored tap would not.
          accessibilityHint={
            view.locked ? 'Available once this note has finished saving' : undefined
          }
          disabled={view.locked}
          icon={X}
          label="Close"
          onPress={onClose}
        />
      }
      status={
        <ComposerStatus testID="capture-status" tone={view.status.tone}>
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
          <TextInput
            accessibilityLabel="Note title"
            className="font-heading text-[26px] leading-[32px] text-ink"
            editable={!view.locked}
            multiline
            // Return already moves on rather than inserting a break; this is the other way one
            // arrives. A pasted break becomes a space here, where it is still visible and
            // changeable, rather than at the freeze boundary, where it is refused instead.
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
            // Return moves on rather than inserting a line break: a title is one line of text that
            // happens to wrap, not a place to write paragraphs.
            submitBehavior="blurAndSubmit"
            style={{ maxHeight: titleMaxHeight(fontScale) }}
            testID="capture-title"
            value={title}
          />
          {/* Always visible, never behind a control. A description is part of writing a note, and
              a note nobody described is the ordinary case rather than an incomplete one. */}
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
            testID="capture-description"
            value={description}
          />
        </ScrollView>

        <EditorHost
          document={document}
          documentId={documentId}
          editable={!view.locked}
          onProblem={onProblem}
          onLinkPress={onLinkPress}
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
