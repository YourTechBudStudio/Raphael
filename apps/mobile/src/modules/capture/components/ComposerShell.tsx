import { ChevronRight, X } from 'lucide-react-native';
import { useRef, useState, type ReactNode, type Ref } from 'react';
import { ScrollView, TextInput, useWindowDimensions, View } from 'react-native';

import {
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
import type { ComposerStatus as StatusLine } from '../composer.ts';
import { singleLineTitle, titleMaxHeight } from '../title.ts';

/**
 * The row above the title, in its three forms.
 *
 * `absent` is not "blank": a phone that could not establish where something lives must say nothing
 * rather than imply it lives at the root. `label` and `button` differ in whether pressing it can
 * achieve anything, which is a fact about the record and never about layout.
 */
export type ComposerEyebrow =
  | { readonly kind: 'absent' }
  | { readonly kind: 'label'; readonly label: string; readonly spoken: string }
  | {
      readonly kind: 'button';
      readonly label: string;
      readonly spoken: string;
      readonly hint: string;
      /** Temporarily unavailable. A disabled control promises it comes back, so this must be true. */
      readonly disabled: boolean;
      readonly onPress: () => void;
    };

export interface ComposerShellProps {
  /** Prefixes the shell's testIDs: `<ns>-title`, `-description`, `-status`, `-bar`, `-close`. */
  namespace: string;
  /** What a screen reader calls the title field. A new note is "Note title"; an entity is "Title". */
  titleLabel: string;
  title: string;
  description: string;
  eyebrow: ComposerEyebrow;
  /** Identity of the document under edit. Changing it replaces the renderer. */
  documentId: string;
  document: unknown;
  status: StatusLine;
  /** A barrier is settling: every field and the toolbar are disabled. */
  locked: boolean;
  /**
   * Nothing here can change: the entity is archived. The same layout, with the fields and the
   * renderer not accepting writing. Separate from `locked`, which is a barrier that ends: the renderer
   * reads this once, when it is created, so a screen that flips it remounts the shell.
   */
  readOnly?: boolean | undefined;
  /** The writing on screen is not safely on this phone, so the renderer is drawn unprotected. */
  unprotected: boolean;
  /** Close is unavailable, and visibly so. Separate from `locked`, which is about the writing. */
  closeDisabled: boolean;
  closeHint?: string | undefined;
  /** The first row of the bar stack, above the formatting row. The conflict band, or nothing. */
  barAbove?: ReactNode | undefined;
  /** The chips on the left of the bar. */
  barLeading: ReactNode;
  /** The pill on the right of the bar, where a screen has one. */
  barTrailing?: ReactNode | undefined;
  /**
   * A control at the end of the top bar, after the status line: the edit screen's Archive toggle. It
   * sits beside the status because the status is where an archived screen says why it is read-only.
   */
  statusTrailing?: ReactNode | undefined;
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
  onClose: () => void;
  testID?: string | undefined;
}

/**
 * Writing, whether or not the server already holds it: one shape, two policies.
 *
 * Presentation and deliberately nothing else - no owner, no navigation, no decision about what may be
 * sent. Every sentence and every enabled control is a value passed in by something that asked an
 * owner, which is what makes this testable and what makes it honest.
 *
 * Creating a note and editing one are the same screen to a person, so they are one component here.
 * What differs is what the epic says must, and it arrives through the slots: a new note has a Save
 * pill and a destination that can still be chosen, an existing one autosaves and can carry a conflict
 * band. Neither policy lives in this file; `composerView` and `editComposerView` decide them, and a
 * reader looking for "why does it say that" goes to one of those two rather than here.
 *
 * **The eyebrow row is one height on both screens.** The pressable form needs a 44pt target and the
 * label form needs none, and letting them differ would put the title at a different height depending
 * on which screen you were on - which is precisely the drift this shell exists to remove.
 */
export function ComposerShell({
  namespace,
  titleLabel,
  title,
  description,
  eyebrow,
  documentId,
  document,
  status,
  locked,
  readOnly = false,
  unprotected,
  closeDisabled,
  closeHint,
  barAbove,
  barLeading,
  barTrailing,
  statusTrailing,
  editorRef,
  onCommand,
  selection,
  onSelectionChange,
  onTitleChange,
  onDescriptionChange,
  onSnapshot,
  onProblem,
  onLinkPress,
  onClose,
  testID,
}: ComposerShellProps) {
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

  return (
    <ComposerFrame
      bar={
        <View>
          {barAbove}
          <ComposerBar
            above={
              bodyActive && !locked && !readOnly ? (
                <EditorToolbar
                  active={selection.active}
                  available={selection.available}
                  locked={locked}
                  onCommand={onCommand}
                />
              ) : undefined
            }
            testID={`${namespace}-bar`}
          >
            {barLeading}
            <View style={{ flex: 1 }} />
            {barTrailing}
          </ComposerBar>
        </View>
      }
      leading={
        <IconButton
          accessibilityHint={closeHint}
          disabled={closeDisabled}
          icon={X}
          label="Close"
          onPress={onClose}
          testID={`${namespace}-close`}
        />
      }
      status={
        statusTrailing === undefined ? (
          <ComposerStatus testID={`${namespace}-status`} tone={status.tone}>
            {status.text}
          </ComposerStatus>
        ) : (
          <View className="flex-row items-center">
            <View className="flex-1">
              <ComposerStatus testID={`${namespace}-status`} tone={status.tone}>
                {status.text}
              </ComposerStatus>
            </View>
            {statusTrailing}
          </View>
        )
      }
      testID={testID}
    >
      <View className="flex-1">
        <ScrollView
          className="flex-none"
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8 }}
          keyboardShouldPersistTaps="handled"
        >
          <EyebrowRow eyebrow={eyebrow} namespace={namespace} />
          <TextInput
            accessibilityLabel={titleLabel}
            className="font-heading text-[26px] leading-[32px] text-ink"
            editable={!locked && !readOnly}
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
            testID={`${namespace}-title`}
            value={title}
          />
          {/* Always visible, never behind a control. A description is part of writing a note, and
              a note nobody described is the ordinary case rather than an incomplete one. */}
          <TextInput
            accessibilityLabel="Description"
            className="mt-1 font-body text-[15px] leading-[22px] text-ink"
            editable={!locked && !readOnly}
            onChangeText={onDescriptionChange}
            onFocus={() => {
              setBodyActive(false);
            }}
            placeholder="Add a description"
            ref={descriptionInput}
            testID={`${namespace}-description`}
            value={description}
          />
        </ScrollView>

        <EditorHost
          document={document}
          documentId={documentId}
          // Read once, when the host is created, and `false` is permanent for that host. A live lock
          // goes through the lock protocol instead; only read-only decides what a host is born as.
          editable={!readOnly}
          onLinkPress={onLinkPress}
          onProblem={onProblem}
          onSelectionChange={(state) => {
            onSelectionChange(state);
            setBodyActive(true);
          }}
          onSnapshot={onSnapshot}
          ref={editorRef}
          style={{ flex: 1, marginTop: 8 }}
          unprotected={unprotected}
        />
      </View>
    </ComposerFrame>
  );
}

/**
 * The row, spelled once for both forms.
 *
 * `h-11` is the 44pt target the pressable form needs; the label form takes it too, because a title
 * that sat at a different height depending on which screen you were on is exactly the drift this
 * shell exists to remove. It is one constant rather than two equal literals so it cannot drift.
 */
const EYEBROW_ROW = 'h-11 flex-row items-center';

/** The eyebrow, at one row height whichever form it takes. */
function EyebrowRow({ eyebrow, namespace }: { eyebrow: ComposerEyebrow; namespace: string }) {
  if (eyebrow.kind === 'absent') return null;

  const testID = `${namespace}-eyebrow`;

  if (eyebrow.kind === 'label') {
    return (
      <View className={EYEBROW_ROW} testID={testID}>
        <Eyebrow accessibilityLabel={eyebrow.spoken}>{eyebrow.label}</Eyebrow>
      </View>
    );
  }

  return (
    <PressableFeedback
      accessibilityHint={eyebrow.hint}
      accessibilityLabel={eyebrow.spoken}
      accessibilityRole="button"
      accessibilityState={{ disabled: eyebrow.disabled }}
      className={`${EYEBROW_ROW} gap-1 ${eyebrow.disabled ? 'opacity-60' : ''}`}
      disabled={eyebrow.disabled}
      onPress={eyebrow.onPress}
      stateLayerColor={colors.primary}
      testID={testID}
      treatment="button"
    >
      <Eyebrow>{eyebrow.label}</Eyebrow>
      <ChevronRight color={colors.primary} size={18} strokeWidth={2} />
    </PressableFeedback>
  );
}
