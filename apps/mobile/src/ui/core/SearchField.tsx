import clsx from 'clsx';
import { Search, X } from 'lucide-react-native';
import { TextInput, View } from 'react-native';

import { colors } from '../theme';
import { IconButton } from './IconButton';

export interface SearchFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
  /** Shows a clear button once there is something to clear. */
  onClear?: (() => void) | undefined;
  onSubmitEditing?: (() => void) | undefined;
  accessibilityLabel?: string | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/** The rounded search field used on the Search screen and inside the Browse sheet. */
export function SearchField({
  value,
  onChangeText,
  placeholder = 'Find an area or project',
  autoFocus = false,
  onClear,
  onSubmitEditing,
  accessibilityLabel = 'Search',
  className,
  testID,
}: SearchFieldProps) {
  const showClear = onClear !== undefined && value.length > 0;

  return (
    <View
      className={clsx(
        'min-h-12 flex-row items-center gap-2 rounded-card border border-line bg-card px-4',
        className,
      )}
    >
      <Search color={colors.inkSoft} size={20} strokeWidth={2} />
      <TextInput
        accessibilityLabel={accessibilityLabel}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        className="h-12 flex-1 font-body text-[16px] text-ink"
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
        placeholder={placeholder}
        placeholderTextColor={colors.inkSoft}
        returnKeyType="search"
        testID={testID}
        value={value}
      />
      {showClear ? (
        <IconButton icon={X} iconSize={18} label="Clear search" onPress={onClear} />
      ) : null}
    </View>
  );
}
