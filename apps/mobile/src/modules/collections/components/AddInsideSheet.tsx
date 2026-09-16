import { X } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { ContainerType } from '../../../infrastructure/api/contracts';
import { Emblem, IconButton, PressableFeedback, Sheet, SheetHeader } from '../../../ui';
import { useSheetsStore } from '../../navigation';

/** Long enough for this sheet's exit before the creation sheet's modal takes the window. */
const CHOICE_CLOSE_MS = 240;

/** Everything the sheet needs about the area it is adding into. */
export interface AddInsideTarget {
  readonly id: number;
  readonly title: string;
}

export interface AddInsideSheetProps {
  /** The area the plus was pressed on, or null while the sheet is closed. */
  area: AddInsideTarget | null;
  onClose: () => void;
}

/**
 * The one question a plus on an area asks: an area inside it, or a project inside it.
 *
 * Two rows, said in full, because "area" and "project" are the two nouns the whole product turns on
 * and a bare icon pair would make someone guess. The same two sentences answer it wherever the
 * question is asked - the plus on a Browse row, and the plus in an area's top bar - so the sheet
 * lives with the capability that owns containers rather than with either screen.
 *
 * Picking is the sheet's own business, down to opening the creation sheet afterwards. Every caller
 * was doing the identical three steps, including the delay, and a caller that got the delay wrong
 * would open a modal into a window the outgoing sheet still holds.
 */
export function AddInsideSheet({ area, onClose }: AddInsideSheetProps) {
  const openNewContainer = useSheetsStore((state) => state.openNewContainer);

  const pick = (type: ContainerType, parentAreaId: number) => {
    onClose();
    // The creation sheet is its own modal; it opens once this one has left the screen.
    setTimeout(() => {
      openNewContainer(type, parentAreaId);
    }, CHOICE_CLOSE_MS);
  };

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
              if (area !== null) pick(type, area.id);
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
