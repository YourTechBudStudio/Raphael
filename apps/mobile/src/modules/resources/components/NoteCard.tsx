import { Archive, Layers } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { colors, StatePill } from '../../../ui';
import { ARCHIVED_LABEL } from '../../lifecycle';
import type { NoteSummaryItem } from '../client/summary';
import { KindLabel } from './KindLabel';
import { NoteCardShell } from './NoteCardShell';

export interface NoteCardProps {
  note: NoteSummaryItem;
  /**
   * The title of the container this note sits in, or undefined when it is not known right now.
   *
   * Presentation only. It is read from the hierarchy the screen already loaded and is never stored,
   * because a title copied onto a note is a second copy of something the server owns, and it goes
   * wrong silently the moment someone renames the container.
   */
  location?: string | undefined;
  onOpen?: (() => void) | undefined;
  /**
   * Draw the Archived pill when the note is archived. Only Search asks: an archived container's own
   * notes are all archived with it, and the toggle above them already says so.
   */
  markArchived?: boolean | undefined;
  testID?: string | undefined;
}

/**
 * A note the server holds, on the lilac surface, no wave.
 *
 * Where it is filed stands as the eyebrow: on a board of notes the kind is already known, and where
 * a note lives is the more useful thing to read first. When the location is not known the kind label
 * takes its place rather than an empty row or a guess - and "not known" genuinely means not known,
 * including a hierarchy that has been read but is no longer current. A plausible title is not an
 * authoritative one, and a card has no room to say which it is showing.
 */
export function NoteCard({ note, location, onOpen, markArchived = false, testID }: NoteCardProps) {
  const archived = markArchived && note.archived;
  const spokenState = archived ? `${ARCHIVED_LABEL}. ` : '';
  const spokenLocation = location === undefined ? '' : `. In ${location}`;
  const spokenDescription = note.description === '' ? '' : `. ${note.description}`;
  const pill = archived ? (
    <StatePill icon={Archive} label={ARCHIVED_LABEL} testID="archived-pill" />
  ) : null;

  return (
    <NoteCardShell
      accessibilityLabel={`Note. ${spokenState}${note.title}${spokenDescription}${spokenLocation}`}
      description={note.description}
      eyebrow={
        location === undefined ? (
          pill === null ? (
            <KindLabel background={false} kind="note" size={22} />
          ) : (
            <View className="flex-row items-center gap-1.5">
              <View className="flex-1">
                <KindLabel background={false} kind="note" size={22} />
              </View>
              {pill}
            </View>
          )
        ) : (
          <View className="flex-row items-center gap-1.5">
            <Layers color={colors.primary} size={16} strokeWidth={2} />
            <Text className="flex-1 font-body-medium text-[14px] text-primary" numberOfLines={1}>
              {location}
            </Text>
            {pill}
          </View>
        )
      }
      onPress={onOpen}
      testID={testID}
      title={note.title}
    />
  );
}
