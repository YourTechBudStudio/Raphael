import clsx from 'clsx';
import type { ReactNode } from 'react';
import {
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ReturnKeyTypeOptions,
} from 'react-native';

import { colors } from '../../../ui/theme';

export interface ConnectionFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  /** Fires when the person leaves the field, which is when an unusable value may say so. */
  onBlur?: (() => void) | undefined;
  secure?: boolean | undefined;
  /** Controls drawn at the right edge of the row: a character count, a reveal toggle. */
  trailing?: ReactNode | undefined;
  keyboardType?: KeyboardTypeOptions | undefined;
  returnKeyType?: ReturnKeyTypeOptions | undefined;
  onSubmitEditing?: (() => void) | undefined;
  editable?: boolean | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/**
 * One row of the connection form: the name of the thing on the left, its value on the right.
 *
 * Autocorrect, autocapitalisation and spellcheck are off and not configurable. Both fields here
 * carry an address or a credential, and a keyboard that capitalises the first letter of a URL or
 * turns a pasted quote into a curly one produces a validation failure the person did not cause and
 * cannot see.
 *
 * The value is right-aligned so the two rows read as a settings pair rather than two form boxes,
 * and so a long address scrolls from its most significant end.
 *
 * The row never colours itself for a bad value. The check below it owns that, and saying the same
 * thing twice in two places is how two places end up disagreeing.
 */
export function ConnectionField({
  label,
  value,
  onChangeText,
  placeholder,
  onBlur,
  secure = false,
  trailing,
  keyboardType,
  returnKeyType,
  onSubmitEditing,
  editable = true,
  accessibilityHint,
  testID,
}: ConnectionFieldProps) {
  return (
    <View
      className={clsx(
        'min-h-[54px] flex-row items-center gap-3 rounded-card border border-line bg-card pl-4 pr-2',
        !editable && 'opacity-60',
      )}
    >
      <Text className="font-body-medium text-[14px] text-ink-soft">{label}</Text>
      <TextInput
        accessibilityHint={accessibilityHint}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-[54px] flex-1 text-right font-body text-[16px] text-ink"
        editable={editable}
        keyboardType={keyboardType}
        onBlur={onBlur}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
        placeholder={placeholder}
        placeholderTextColor={colors.inkSoft}
        returnKeyType={returnKeyType}
        secureTextEntry={secure}
        spellCheck={false}
        testID={testID}
        value={value}
      />
      {trailing}
    </View>
  );
}
