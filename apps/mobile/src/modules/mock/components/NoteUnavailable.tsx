/**
 * THROWAWAY MOCK. A saved note whose body could not be read from the server. There is nothing
 * to edit, so there is no editor: one screen that says so and goes back to Home.
 */

import { X } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, PrimaryButton } from '../../../ui';

export interface NoteUnavailableProps {
  title: string;
  onHome: () => void;
}

export function MockNoteUnavailable({ title, onHome }: NoteUnavailableProps) {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-canvas">
      <View className="h-14 flex-row items-center px-3" style={{ marginTop: insets.top + 4 }}>
        <IconButton icon={X} label="Close" onPress={onHome} />
      </View>
      <View className="flex-1 justify-center px-5 pb-24">
        <Text
          accessibilityRole="header"
          className="font-heading text-[26px] leading-[32px] text-ink"
        >
          This note could not be opened
        </Text>
        <Text className="mt-3 font-body text-[16px] leading-[24px] text-ink">
          Raphael could not read “{title}” from your server. Nothing about the note has changed; try
          again once the server is reachable.
        </Text>
        <PrimaryButton className="mt-6" label="Back to Home" onPress={onHome} />
      </View>
    </View>
  );
}
