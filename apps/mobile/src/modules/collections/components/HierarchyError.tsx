import { Text, View } from 'react-native';

import { Chip, SectionError } from '../../../ui';
import type { HierarchyQuery } from '../client/queries';
import { offersRetry, staleSentence } from './hierarchy-presentation';

/**
 * Why the hierarchy is not what it should be, said the same way everywhere.
 *
 * Six surfaces read the hierarchy, and each of them has to answer the same two questions about a
 * failure: does it carry a sentence of its own, and is trying again worth offering. Answering them
 * six times is six chances to answer differently, and the answers are not obvious - a refusal
 * carries a real explanation and may be settled for good, while an unreachable server carries
 * nothing useful and is always worth another go. Both components here exist so that reasoning lives
 * in one place.
 */

export interface HierarchyErrorProps {
  tree: HierarchyQuery;
  /** What this screen was trying to show, so the message is about this section. */
  title: string;
}

/** Nothing loaded at all. */
export function HierarchyError({ tree, title }: HierarchyErrorProps) {
  return (
    <SectionError
      description={tree.refusal?.message}
      retrying={tree.isFetching}
      title={title}
      {...(offersRetry(tree.refusal) ? { onRetry: tree.refetch } : {})}
    />
  );
}

export interface HierarchyStaleProps {
  tree: HierarchyQuery;
  className?: string | undefined;
}

/**
 * A complete reading is on screen and the most recent attempt to replace it failed.
 *
 * The wording used to be hardcoded on each screen as "the most recent check did not reach the
 * server", which is one of the three things that can have happened and the only one that is not a
 * refusal. A hierarchy that has outgrown what this app reads, or one whose pages contradicted each
 * other, both reached the server perfectly well - saying otherwise sends someone to check their
 * network over something their network had nothing to do with, and a Try again against the first of
 * those can only fail again.
 *
 * The data stays on screen in every case. It was complete when it was read, and throwing away a
 * good reading because the next one failed helps nobody.
 */
export function HierarchyStale({ tree, className }: HierarchyStaleProps) {
  if (!tree.isStale) return null;

  const retry = offersRetry(tree.refusal);

  return (
    <View
      className={['gap-2 rounded-card border border-line bg-card px-4 py-3', className ?? ''].join(
        ' ',
      )}
    >
      <Text
        accessibilityLiveRegion="polite"
        className="font-body text-[14px] leading-[20px] text-ink-soft"
      >
        {staleSentence(tree.refusal)}
      </Text>
      {retry ? (
        <View className="flex-row">
          <Chip
            accessibilityHint="Reads the hierarchy again"
            disabled={tree.isFetching}
            label={tree.isFetching ? 'Trying again…' : 'Try again'}
            onPress={tree.refetch}
          />
        </View>
      ) : null}
    </View>
  );
}
