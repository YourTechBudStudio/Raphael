/**
 * The formatting row, in React Native rather than HTML.
 *
 * This is a deliberate accessibility decision: `UIAutomator` could not see inner editor nodes in the
 * epic's prototype, so a native control row gives TalkBack and VoiceOver real, labelled, focusable
 * targets regardless of what the WebView exposes. Commands travel over the bridge; active and
 * available state come back over it.
 *
 * Unavailable commands stay visible, disabled and labelled rather than disappearing, so "undo is
 * exhausted" and "there is nothing to outdent" are things the surface says rather than things a
 * person discovers by pressing.
 */

import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Undo2,
  type LucideIcon,
} from 'lucide-react-native';
import { Platform, ScrollView, View } from 'react-native';

import { colors, PressableFeedback } from '../../../ui';
import { commandForAction, type EditorActionId, type EditorCommand } from '../bridge.ts';

interface Tool {
  readonly action: EditorActionId;
  readonly icon: LucideIcon;
  readonly label: string;
}

/**
 * Seventeen controls for fifteen commands: the three heading levels are three controls, and
 * paragraph is how a block returns to ordinary text.
 */
const TOOLS: readonly Tool[] = [
  { action: 'paragraph', icon: Pilcrow, label: 'Paragraph' },
  { action: 'heading1', icon: Heading1, label: 'Heading 1' },
  { action: 'heading2', icon: Heading2, label: 'Heading 2' },
  { action: 'heading3', icon: Heading3, label: 'Heading 3' },
  { action: 'bulletList', icon: List, label: 'Bulleted list' },
  { action: 'orderedList', icon: ListOrdered, label: 'Numbered list' },
  { action: 'nest', icon: ListIndentIncrease, label: 'Nest' },
  { action: 'outdent', icon: ListIndentDecrease, label: 'Outdent' },
  { action: 'codeBlock', icon: SquareCode, label: 'Code block' },
  { action: 'blockquote', icon: Quote, label: 'Quote' },
  { action: 'bold', icon: Bold, label: 'Bold' },
  { action: 'italic', icon: Italic, label: 'Italic' },
  { action: 'strike', icon: Strikethrough, label: 'Strikethrough' },
  { action: 'code', icon: Code, label: 'Inline code' },
  { action: 'horizontalRule', icon: Minus, label: 'Divider' },
  { action: 'undo', icon: Undo2, label: 'Undo' },
  { action: 'redo', icon: Redo2, label: 'Redo' },
];

/** 44 pt on iOS, 48 dp on Android: each platform's own minimum, not one number for both. */
const TARGET = Platform.OS === 'android' ? 48 : 44;

export interface EditorToolbarProps {
  readonly active: readonly EditorActionId[];
  readonly available: readonly EditorActionId[];
  /** True while the host has stopped sending: every control reads as disabled and busy. */
  readonly locked?: boolean | undefined;
  readonly onCommand: (command: EditorCommand) => void;
}

export function EditorToolbar({
  active,
  available,
  locked = false,
  onCommand,
}: EditorToolbarProps) {
  const activeSet = new Set(active);
  const availableSet = new Set(available);

  return (
    <View className="border-line/60 border-t bg-card">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 4, gap: 2 }}
        horizontal
        // The body keeps focus and the keyboard stays up: a formatting tap is not a dismissal.
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
      >
        {TOOLS.map(({ action, icon: Icon, label }) => {
          const on = activeSet.has(action);
          const unavailable = locked || !availableSet.has(action);

          return (
            <PressableFeedback
              accessibilityLabel={label}
              accessibilityState={{ selected: on, disabled: unavailable, busy: locked }}
              className={[
                'h-full w-full items-center justify-center rounded-full',
                on ? 'bg-wave' : '',
              ].join(' ')}
              disabled={unavailable}
              key={action}
              onPress={() => {
                onCommand(commandForAction(action));
              }}
              style={{ width: TARGET, height: TARGET, opacity: unavailable ? 0.4 : 1 }}
              treatment="icon"
            >
              <Icon color={on ? colors.primary : colors.ink} size={20} strokeWidth={2} />
            </PressableFeedback>
          );
        })}
      </ScrollView>
    </View>
  );
}
