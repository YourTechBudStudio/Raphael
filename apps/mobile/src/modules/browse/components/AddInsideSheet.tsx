import { X } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { ContainerType } from '../../../infrastructure/api/contracts';
import { Emblem, IconButton, PressableFeedback, Sheet, SheetHeader } from '../../../ui';
import type { HierarchyNode } from '../../collections';

export interface AddInsideSheetProps {
  /** The area the plus was tapped on, or null while the sheet is closed. */
  area: HierarchyNode | null;
  onPick: (type: ContainerType, area: HierarchyNode) => void;
  onClose: () => void;
}

/**
 * The plus on an area row asks one question: an area inside it, or a project inside it. Two
 * rows, said in full, because "area" and "project" are the two nouns the whole product turns on
 * and a bare icon pair would make someone guess.
 */
export function AddInsideSheet({ area, onPick, onClose }: AddInsideSheetProps) {
  return (
    <Sheet className="px-5 pb-2" label="the add sheet" onClose={onClose} visible={area !== null}>
      <SheetHeader
        leading={
          <IconButton className="bg-primary-soft" icon={X} label="Close" onPress={onClose} />
        }
        subtitle={area === null ? undefined : `Inside ${area.title}`}
        title="Add"
        trailing={<View className="w-11" />}
      />
      <View className="mt-4">
        {(['area', 'project'] as const).map((type) => (
          <PressableFeedback
            accessibilityHint={`Creates ${type === 'area' ? 'an area' : 'a project'} inside ${area?.title ?? 'this area'}`}
            accessibilityLabel={type === 'area' ? 'New area' : 'New project'}
            className="flex-row items-center gap-3 rounded-card px-3"
            key={type}
            onPress={() => {
              if (area !== null) onPick(type, area);
            }}
            style={{ minHeight: 56 }}
          >
            <Emblem name={type === 'area' ? 'layers' : 'petals'} size={36} />
            <View className="flex-1 py-2">
              <Text className="font-body-semibold text-[16px] leading-[22px] text-ink">
                {type === 'area' ? 'New area' : 'New project'}
              </Text>
              <Text className="font-body text-[13px] leading-[18px] text-ink-soft">
                {type === 'area'
                  ? 'A subject that keeps going, divided from this one.'
                  : 'Something with an end in sight.'}
              </Text>
            </View>
          </PressableFeedback>
        ))}
      </View>
    </Sheet>
  );
}
