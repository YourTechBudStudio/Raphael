import { Trash2 } from 'lucide-react-native';
import { View } from 'react-native';

import { confirmDiscard, IconButton, ListRow, StateLine, type MarkKind } from '../../../ui';
import {
  UNFINISHED_EMPTY,
  UNFINISHED_INTRO,
  UNFINISHED_OPEN_HINT,
  UNFINISHED_STATE,
  unfinishedDiscardPrompt,
  type UnfinishedStanding,
} from '../copy.ts';

export interface UnfinishedItem {
  readonly key: string;
  readonly mark: { readonly kind: MarkKind; readonly id: number };
  readonly title: string;
  readonly standing: UnfinishedStanding;
  /** After the state: where it lives, or the server's reason for a refusal. */
  readonly detail?: string | undefined;
}

export interface UnfinishedListProps {
  items: readonly UnfinishedItem[];
  onOpen: (item: UnfinishedItem) => void;
  /** Called once the person has confirmed. */
  onDiscard: (item: UnfinishedItem) => void;
}

/**
 * Everything that has not reached the server, as the same flat rows as Favorites and Search: the
 * mark, the title, and one plain line - the state, then where it lives. Opening a row resolves it;
 * the trash is a shortcut for rows nobody cares about, and waits while one is being sent.
 */
export function UnfinishedList({ items, onOpen, onDiscard }: UnfinishedListProps) {
  if (items.length === 0) return <StateLine>{UNFINISHED_EMPTY}</StateLine>;

  return (
    <View className="gap-4">
      <StateLine>{UNFINISHED_INTRO}</StateLine>
      <View>
        {items.map((item) => {
          const sending = item.standing === 'waiting';

          return (
            <ListRow
              accessibilityHint={UNFINISHED_OPEN_HINT[item.standing]}
              detail={item.detail}
              key={item.key}
              kindLabel={UNFINISHED_STATE[item.standing]}
              mark={item.mark}
              onPress={() => {
                onOpen(item);
              }}
              pending={sending}
              title={item.title}
              trailing={
                <IconButton
                  accessibilityHint={
                    sending
                      ? 'Available once Raphael stops sending it'
                      : 'Asks before removing it from this phone'
                  }
                  disabled={sending}
                  icon={Trash2}
                  iconSize={20}
                  label={`Discard ${item.title}`}
                  onPress={() => {
                    void confirmDiscard(unfinishedDiscardPrompt(item.standing)).then(
                      (confirmed) => {
                        if (confirmed) onDiscard(item);
                      },
                    );
                  }}
                />
              }
            />
          );
        })}
      </View>
    </View>
  );
}
