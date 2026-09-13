import { Text, View } from 'react-native';

import { Card, Chip } from '../../../ui';
import { useAttemptViews, useCreationOwner } from '../client/creation';

export interface PendingSummaryProps {
  /**
   * Limits the summary to attempts aimed at one area. Omitted, it covers everything - including
   * attempts aimed at the root, which belong to no area and would otherwise be discoverable
   * nowhere.
   */
  parentAreaId?: number | null | undefined;
  onOpen: () => void;
}

/**
 * A standing notice that something was left unfinished, wherever someone is likely to be.
 *
 * It survives a hierarchy that will not load and a parent that is missing, because it is drawn
 * entirely from the local record. That is the point: the moment someone most needs to know a
 * creation was left in the air is the moment the server is being unhelpful.
 */
export function PendingSummary({ parentAreaId, onOpen }: PendingSummaryProps) {
  const status = useCreationOwner((state) => state.status);
  const views = useAttemptViews();

  if (status !== 'ready') return null;

  const relevant =
    parentAreaId === undefined
      ? views
      : views.filter((view) => view.record.parentAreaId === parentAreaId);

  if (relevant.length === 0) return null;

  // Read off the view, never recomputed from the row: the view is the only thing that knows about
  // a server success this process is holding because its local write failed.
  const unresolved = relevant.filter((view) => view.logical === 'unresolved').length;
  const created = relevant.filter((view) => view.logical === 'created').length;
  const refused = relevant.length - unresolved - created;

  return (
    <Card className="gap-3" variant="warm">
      <Text
        accessibilityLiveRegion="polite"
        className="font-body text-[15px] leading-[22px] text-ink"
      >
        {describe({ unresolved, created, refused })}
      </Text>
      <View className="flex-row">
        <Chip
          accessibilityHint="Opens everything left unfinished"
          label="Review"
          onPress={onOpen}
        />
      </View>
    </Card>
  );
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/**
 * One sentence naming what is actually there.
 *
 * A generic "you have unfinished work" would put a creation that definitely succeeded and one whose
 * outcome nobody knows behind the same words, and only one of those is worth interrupting someone
 * for. The counts are listed in order of how much they ask of the reader.
 */
const describe = (counts: {
  readonly unresolved: number;
  readonly created: number;
  readonly refused: number;
}): string => {
  const parts: string[] = [];

  if (counts.unresolved > 0) {
    parts.push(
      `${plural(counts.unresolved, 'creation', 'creations')} Raphael cannot confirm either way`,
    );
  }
  if (counts.refused > 0) parts.push(`${plural(counts.refused, 'that was', 'that were')} refused`);
  if (counts.created > 0) parts.push(`${plural(counts.created, 'result', 'results')} to look at`);

  return `${parts.join(', and ')}.`;
};
