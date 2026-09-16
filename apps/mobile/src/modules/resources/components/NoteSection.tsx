import clsx from 'clsx';
import { Text, View } from 'react-native';

import { SectionHeading, SkeletonBlock, SkeletonGroup } from '../../../ui';
import type { NoteFeedView } from '../client/feed-state';
import { NoteGrid, type NoteGridLeadingItem } from './NoteGrid';
import type { NoteSectionCopy } from './notes-copy';

/**
 * The Notes section, once.
 *
 * Home and the container screens show the same six states with two words different between them, so
 * they are one component taking its copy rather than two components that happen to agree today. The
 * states it has to keep apart are in `feed-state.ts`; what this file owns is which of them puts a
 * line on screen, which puts cards on screen, and which does both.
 *
 * A quiet line, never a card. A section with nothing to show is not content.
 */

export interface NoteSectionProps {
  view: NoteFeedView;
  copy: NoteSectionCopy;
  /** Cards drawn before the server's, in order. Phase 06 fills this from capture. */
  leading?: readonly NoteGridLeadingItem[] | undefined;
  locationFor?: ((parentId: number) => string | undefined) | undefined;
  onOpen?: ((id: number) => void) | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/** The grid shape while the first page is on its way. */
function NotesSkeleton() {
  return (
    <SkeletonGroup className="gap-4" label="Loading notes">
      <View className="flex-row gap-4">
        <SkeletonBlock height={200} />
        <SkeletonBlock height={148} />
      </View>
      <View className="flex-row gap-4">
        <SkeletonBlock height={132} />
        <SkeletonBlock height={188} />
      </View>
    </SkeletonGroup>
  );
}

/** A soft line on the canvas, for the states that are not content. */
function Line({ children, live }: { children: string; live?: boolean | undefined }) {
  return (
    <Text
      accessibilityLiveRegion={live === true ? 'polite' : 'none'}
      className="font-body text-[16px] leading-[22px] text-ink-soft"
    >
      {children}
    </Text>
  );
}

export function NoteSection({
  view,
  copy,
  leading,
  locationFor,
  onOpen,
  className,
  testID,
}: NoteSectionProps) {
  const leadingCards = leading ?? [];
  const hasCards = view.items.length > 0 || leadingCards.length > 0;

  return (
    <View className={clsx('gap-3', className)} testID={testID}>
      <SectionHeading>Notes</SectionHeading>

      {/* Nothing has arrived and nothing has failed. Cards already on this phone still show:
          they are here whatever the server is doing. */}
      {view.isLoading && !hasCards ? <NotesSkeleton /> : null}

      {/* Cards first, always, and that order is the point rather than a layout preference.
          What leads this grid is writing that is on this phone and is not on the server, and a
          server that is empty or unreachable must never be allowed to precede it - let alone hide
          it. Everything below this is a statement about the server's half of the section. */}
      {hasCards ? (
        <NoteGrid
          items={view.items}
          leading={leadingCards}
          locationFor={locationFor}
          onOpen={onOpen}
        />
      ) : null}

      {/* The read failed. Beside cards this says what is not known about an earlier reading;
          with no cards it is the whole answer. Either way it is the same sentence, because the
          thing that went wrong is the same thing. */}
      {view.isUnavailable || view.isStale ? <Line live>{copy.failed}</Line> : null}

      {/* Read successfully, and the server holds nothing here.
          It is said even while unfinished cards are on screen, because the two report different
          facts: what is on this phone, and what is filed on the server. Suppressing it would leave
          a person unable to tell an empty account from one that had not answered. */}
      {view.isEmpty ? <Line>{copy.empty}</Line> : null}

      {/* The only statement of incompleteness. Nothing implies the list has ended while another
          page is on its way. */}
      {view.isLoadingMore ? <Line>Loading more…</Line> : null}

      {/* One page failed; the cards above it are untouched and still true. The automatic walk
          stops here rather than asking the same refused question on every scroll. */}
      {view.nextPageFailed ? (
        <Line live>More notes did not load. Pull down to try again.</Line>
      ) : null}
    </View>
  );
}
