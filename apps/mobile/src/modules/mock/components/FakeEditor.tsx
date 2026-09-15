/**
 * THROWAWAY MOCK. Stands in for the TipTap WebView and the native toolbar so the layout around
 * them can be judged. The body is a plain multiline input; the toolbar only toggles its own look.
 */

import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Undo2,
  type LucideIcon,
} from 'lucide-react-native';
import { useState, type Ref } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import { colors, PressableFeedback } from '../../../ui';

const TOOLS: readonly {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly label: string;
}[] = [
  { key: 'h1', icon: Heading1, label: 'Heading 1' },
  { key: 'h2', icon: Heading2, label: 'Heading 2' },
  { key: 'h3', icon: Heading3, label: 'Heading 3' },
  { key: 'bullet', icon: List, label: 'Bulleted list' },
  { key: 'ordered', icon: ListOrdered, label: 'Numbered list' },
  { key: 'indent', icon: IndentIncrease, label: 'Nest' },
  { key: 'outdent', icon: IndentDecrease, label: 'Outdent' },
  { key: 'code', icon: Code, label: 'Code block' },
  { key: 'bold', icon: Bold, label: 'Bold' },
  { key: 'italic', icon: Italic, label: 'Italic' },
  { key: 'undo', icon: Undo2, label: 'Undo' },
  { key: 'redo', icon: Redo2, label: 'Redo' },
];

export interface FormattingBarProps {
  disabled?: boolean | undefined;
}

/** The native formatting row: a horizontal strip of 44pt icon targets on the lilac surface. */
export function FormattingBar({ disabled = false }: FormattingBarProps) {
  const [active, setActive] = useState<string | null>(null);

  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: 12, gap: 2 }}
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
    >
      {TOOLS.map(({ key, icon: Icon, label }) => {
        const on = active === key;
        // Undo is exhausted in the mock and the outdent has nothing to lift: both read as unavailable.
        const unavailable = disabled || key === 'undo' || key === 'redo' || key === 'outdent';

        return (
          <PressableFeedback
            accessibilityLabel={label}
            accessibilityState={{ selected: on, disabled: unavailable }}
            className={[
              'h-11 w-11 items-center justify-center rounded-full',
              on ? 'bg-wave' : '',
            ].join(' ')}
            disabled={unavailable}
            key={key}
            onPress={() => {
              setActive(on ? null : key);
            }}
            style={{ opacity: unavailable ? 0.4 : 1 }}
            treatment="icon"
          >
            <Icon color={on ? colors.primary : colors.ink} size={20} strokeWidth={2} />
          </PressableFeedback>
        );
      })}
    </ScrollView>
  );
}

export interface FakeBodyProps {
  value: string;
  onChangeText: (value: string) => void;
  onFocus?: (() => void) | undefined;
  onBlur?: (() => void) | undefined;
  editable?: boolean | undefined;
  minHeight?: number | undefined;
  ref?: Ref<TextInput> | undefined;
}

/** The writing area. Grows with the text; the page scrolls, not the field. */
export function FakeBody({
  value,
  onChangeText,
  onFocus,
  onBlur,
  editable = true,
  minHeight = 200,
  ref,
}: FakeBodyProps) {
  return (
    <View style={{ minHeight }}>
      <TextInput
        accessibilityLabel="Note"
        className="font-body text-[17px] leading-[26px] text-ink"
        editable={editable}
        multiline
        onBlur={onBlur}
        onChangeText={onChangeText}
        onFocus={onFocus}
        placeholder="Start writing…"
        placeholderTextColor={colors.inkSoft}
        ref={ref}
        scrollEnabled={false}
        style={{ minHeight }}
        textAlignVertical="top"
        value={value}
      />
    </View>
  );
}
