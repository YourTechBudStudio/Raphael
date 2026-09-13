import { useState, type Ref } from 'react';
import {
  TextInput,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputProps,
} from 'react-native';

import { colors } from '../theme';

/** Four lines at 22px line height, so a body field opens with room to write. */
const BODY_MIN_HEIGHT = 88;
/**
 * A body stops growing here and scrolls within itself, so the caret stays with the keyboard
 * rather than running off the end of the sheet's own scroll.
 */
const BODY_MAX_HEIGHT = 220;

export interface GrowingTextInputProps extends Omit<
  TextInputProps,
  'multiline' | 'onContentSizeChange' | 'style'
> {
  value: string;
  minHeight?: number | undefined;
  maxHeight?: number | undefined;
  /** Forwarded to the underlying input, for hosts that move focus into the body. */
  ref?: Ref<TextInput> | undefined;
}

/**
 * The multiline field a long-form body is written into: it grows with the writing to a cap, then
 * scrolls. Shared by the note sheet and the container creation sheet so a body is the same thing
 * to write into wherever one is written.
 *
 * It measures itself rather than asking its host to, and an emptied value returns to the opening
 * height, so a host that clears the field does not have to remember to reset a measurement.
 */
export function GrowingTextInput({
  value,
  minHeight = BODY_MIN_HEIGHT,
  maxHeight = BODY_MAX_HEIGHT,
  className,
  ref,
  ...props
}: GrowingTextInputProps) {
  const [measured, setMeasured] = useState(minHeight);
  const height = value === '' ? minHeight : measured;

  const handleContentSize = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ): void => {
    setMeasured(Math.min(Math.max(event.nativeEvent.contentSize.height, minHeight), maxHeight));
  };

  return (
    <TextInput
      className={['font-body text-[16px] leading-[22px] text-ink', className ?? ''].join(' ')}
      multiline
      onContentSizeChange={handleContentSize}
      placeholderTextColor={colors.inkSoft}
      ref={ref}
      style={{ height }}
      textAlignVertical="top"
      value={value}
      {...props}
    />
  );
}
