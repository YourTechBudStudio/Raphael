import { Pencil } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { ContainerType } from '../../../infrastructure/api/contracts';
import { colors, PressableFeedback } from '../../../ui';
import { openEditor } from '../../navigation';

const KIND_WORD: Record<ContainerType, string> = { area: 'this area', project: 'this project' };

export interface ContainerEditActionProps {
  kind: ContainerType;
  /**
   * The entity's id, or null while it has not loaded.
   *
   * The gate is the prop rather than the caller's `&&`, because "absent until there is something to
   * edit" is one rule and both screens must follow it identically. A pencil that opens an editor over
   * an id the screen has not read yet would be an editor over nothing.
   */
  id: number | null;
}

/**
 * Edit, in the header's toggle row beside Favorite.
 *
 * A pencil and the word, in the same 44pt shape as `ToggleLabel`, so the row reads as one set of
 * things you can do to this container. It is not in the top bar - that is four controls already on an
 * area, and a fifth would squeeze the location chip - and it is not beside "About this area", which
 * would read as editing the prose while the editor changes the whole container.
 */
export function ContainerEditAction({ kind, id }: ContainerEditActionProps) {
  if (id === null) return null;

  return (
    <PressableFeedback
      accessibilityHint="Changes the title, description, body, ID and tags"
      accessibilityLabel={`Edit ${KIND_WORD[kind]}`}
      accessibilityRole="button"
      className="h-11 flex-row items-center gap-1 pr-2"
      onPress={() => {
        openEditor(id);
      }}
      testID="container-edit"
    >
      <View className="items-center justify-center" style={{ height: 44, width: 44 }}>
        <Pencil color={colors.primary} size={20} strokeWidth={2} />
      </View>
      <Text className="font-body-medium text-[16px] text-ink">Edit</Text>
    </PressableFeedback>
  );
}
