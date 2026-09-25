import { Pencil } from 'lucide-react-native';
import { Text } from 'react-native';

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
  /** Stays in place but cannot be used, and this says why; it becomes the spoken hint. */
  unavailable?: string | undefined;
}

/**
 * Edit, a compact pencil and word at the end of the "About this …" heading.
 *
 * It left the header's toggle row because that row holds states - Active, Favorite, Archive - and
 * Edit changes the content rather than describing a state. Beside the heading it sits next to the
 * content it changes, and it is not in the top bar, which is four controls already on an area.
 *
 * While the container is archived it stays where it is, drawn unavailable, because the server
 * refuses an edit then. Nothing moving is what keeps the Archive toggle under the same thumb.
 */
export function ContainerEditAction({ kind, id, unavailable }: ContainerEditActionProps) {
  if (id === null) return null;

  const off = unavailable !== undefined;

  return (
    <PressableFeedback
      accessibilityHint={unavailable ?? 'Changes the title, description, body, ID and tags'}
      accessibilityLabel={`Edit ${KIND_WORD[kind]}`}
      accessibilityRole="button"
      className={['h-11 flex-row items-center gap-1 pl-2', off ? 'opacity-40' : ''].join(' ')}
      disabled={off}
      onPress={() => {
        openEditor(id);
      }}
      testID="container-edit"
      treatment="button"
    >
      <Pencil color={colors.primary} size={18} strokeWidth={2} />
      <Text className="font-body-medium text-[16px] text-primary">Edit</Text>
    </PressableFeedback>
  );
}
