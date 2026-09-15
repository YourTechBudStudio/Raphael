/**
 * THROWAWAY MOCK. Leaving the editor while some writing exists only in it. Two causes, one
 * sheet: the phone could not write the draft, or the editor refused to hand the document over
 * because it is past the size Raphael can keep. Nothing leaves until the writing is safe or
 * explicitly given up.
 */

import { Text, View } from 'react-native';

import { Chip, PrimaryButton, Sheet } from '../../../ui';
import type { MockStorage } from '../state';

export interface ProtectSheetProps {
  storage: MockStorage;
  visible: boolean;
  onRepair: () => void;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

export function ProtectSheet({
  storage,
  visible,
  onRepair,
  onKeepEditing,
  onDiscard,
}: ProtectSheetProps) {
  const tooLarge = storage === 'editor_refuses';

  return (
    <Sheet
      className="gap-4 px-5 pb-2 pt-1"
      label="unprotected writing"
      onClose={onKeepEditing}
      visible={visible}
    >
      <Text accessibilityRole="header" className="font-heading text-[24px] leading-[30px] text-ink">
        {tooLarge ? 'This note is too large to keep' : 'This writing is not protected yet'}
      </Text>
      <Text className="font-body text-[16px] leading-[24px] text-ink">
        {tooLarge
          ? 'It is past the size Raphael can store on this phone, so everything since the last small version exists only on this screen. Undo the last change or trim it down, and it is kept again.'
          : 'Raphael could not write the last change to this phone. Leaving now would lose it. Everything before that change is safe.'}
      </Text>
      <View className="gap-3">
        <PrimaryButton
          label={tooLarge ? 'Undo the last change' : 'Try writing it again'}
          onPress={onRepair}
        />
        <View className="flex-row flex-wrap gap-2">
          <Chip label="Keep editing" onPress={onKeepEditing} />
          <Chip label={tooLarge ? 'Discard the note' : 'Discard the change'} onPress={onDiscard} />
        </View>
      </View>
    </Sheet>
  );
}
