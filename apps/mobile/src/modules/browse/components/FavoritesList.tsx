import { View } from 'react-native';

import type { ContainerRef, ContainerType } from '../../../infrastructure/api/contracts';
import {
  Chip,
  FavoriteButton,
  ListRow,
  PrimaryButton,
  SectionError,
  StateLine,
  WaitingLine,
  type ListRowParent,
} from '../../../ui';
import { containerLookup, useHierarchy } from '../../collections';
import {
  favoriteFailureSentence,
  useFavoritePages,
  useFavoriteToggle,
  type FavoriteItem,
} from '../../favorites';

interface FavoritesListProps {
  query: string;
  onSelect: (ref: ContainerRef) => void;
}

const KIND_WORDS: Record<ContainerType, string> = { area: 'Area', project: 'Project' };

const OPEN_HINTS: Record<ContainerType, string> = {
  area: 'Opens this area',
  project: 'Opens this project',
};

/** A sentence with a Retry under it, for a read that did not come back. */
function RetryLine({
  sentence,
  hint,
  onRetry,
  testID,
}: {
  sentence: string;
  hint: string;
  onRetry: () => void;
  testID: string;
}) {
  return (
    <View className="gap-3" testID={testID}>
      <StateLine>{sentence}</StateLine>
      <View className="flex-row">
        <Chip accessibilityHint={hint} label="Retry" onPress={onRetry} />
      </View>
    </View>
  );
}

interface FavoriteRowProps {
  item: FavoriteItem;
  parent: ListRowParent | undefined;
  onSelect: (ref: ContainerRef) => void;
}

/**
 * One favorite, with its own star.
 *
 * One toggle per row, as `useProjectActive` requires: a mutation observer reports only its latest
 * dispatch, so a list-wide instance would lose row A's refusal as soon as row B was tapped. What is in
 * flight and what the server confirmed are still shared by every star, because they come from the
 * mutation cache and the confirmed-answer entry. Only the verdict belongs to the row, and a row that
 * leaves after a successful remove takes its verdict with it, which is right: that write succeeded.
 */
function FavoriteRow({ item, parent, onSelect }: FavoriteRowProps) {
  const favorite = useFavoriteToggle();
  const { node, read } = item;

  return (
    <ListRow
      accessibilityHint={OPEN_HINTS[node.type]}
      failure={favoriteFailureSentence(favorite.failure)}
      kindLabel={KIND_WORDS[node.type]}
      mark={{ kind: node.type, id: node.id }}
      onPress={() => {
        onSelect({ type: node.type, id: node.id });
      }}
      parent={parent}
      testID="favorite-row"
      title={node.title}
      trailing={
        <FavoriteButton
          busy={favorite.isBusy(node.id)}
          favorited={favorite.isFavorite(read)}
          label={node.title}
          onToggle={() => {
            favorite.toggle(read);
          }}
          size={22}
        />
      }
    />
  );
}

/**
 * Browse → Favorites: the server's favorites list, as one flat list of rows in its order.
 *
 * The server decides membership and order - favorites that are not archived, by title then id - and
 * each row is exactly what its page said. The hierarchy is read only for the parent pill, and it
 * never decides what is listed: while it is missing or stale the pill is simply left out, so a row
 * never names a parent that may have changed.
 *
 * The filter is the only one on the tab: a case-insensitive title match over the *complete* list. So
 * a non-empty filter first loads every page and says nothing about matches until it has; "No
 * favorite matches" is only ever said about every favorite, and a page that fails while filtering is
 * reported as that, never as no match.
 *
 * A failure is never shown as an empty list. The first page failing is an error with Retry; a
 * refresh failing over rows keeps them and says they may be out of date; a later page failing keeps
 * the rows above it and says so under them. More pages load from "Show more" rather than on scroll,
 * because `BrowseScreen` owns the scroll view and with 500 favorites to a page a second is rare.
 */
export function FavoritesList({ query, onSelect }: FavoritesListProps) {
  const needle = query.trim().toLowerCase();
  const filtering = needle !== '';
  const pages = useFavoritePages({ complete: filtering });
  const tree = useHierarchy();
  const containerOf = containerLookup(tree);

  const parentOf = (parentId: number | null): ListRowParent | undefined => {
    const parent = parentId === null ? undefined : containerOf(parentId);

    return parent === undefined
      ? undefined
      : { kind: parent.type, id: parent.id, title: parent.title };
  };

  if (pages.isError) {
    return (
      <SectionError
        onRetry={pages.retry}
        retrying={pages.isFetching}
        title="Favorites did not load."
      />
    );
  }

  if (pages.items === undefined) return <WaitingLine>Loading favorites…</WaitingLine>;

  // A failed refresh stops the loading too (see `useFavoritePages`), so it is reported the same way:
  // the filter cannot say what matches until Retry has reread the list.
  if (filtering && !pages.isComplete) {
    return pages.isMoreError || pages.isStale ? (
      <RetryLine
        hint="Asks for the rest of your favorites again"
        onRetry={pages.retry}
        sentence="Could not check every favorite, so the filter cannot say what matches."
        testID="favorites-filter-failed"
      />
    ) : (
      <WaitingLine>Checking every favorite…</WaitingLine>
    );
  }

  const rows = filtering
    ? pages.items.filter((item) => item.node.title.toLowerCase().includes(needle))
    : pages.items;

  const stale = pages.isStale ? (
    <RetryLine
      hint="Reads your favorites again"
      onRetry={pages.retry}
      sentence="Favorites may be out of date. The last refresh did not load."
      testID="favorites-stale"
    />
  ) : null;

  if (rows.length === 0) {
    return (
      <View className="gap-3">
        {stale}
        <StateLine>
          {filtering
            ? `No favorite matches “${query.trim()}”.`
            : 'No favorites yet. Star an area or project to keep a shortcut here.'}
        </StateLine>
      </View>
    );
  }

  return (
    <View className="gap-3">
      {stale}
      <View className="gap-0.5">
        {rows.map((item) => (
          // Keyed by node, so a refetch or a reorder keeps each row's toggle, and its verdict, with
          // the node it belongs to.
          <FavoriteRow
            item={item}
            key={item.node.id}
            onSelect={onSelect}
            parent={parentOf(item.node.parentId)}
          />
        ))}
      </View>
      {filtering ? null : pages.isMoreError ? (
        <RetryLine
          hint="Asks for the next favorites again"
          onRetry={pages.retry}
          sentence="More favorites did not load."
          testID="favorites-more-failed"
        />
      ) : pages.isComplete || pages.isStale ? null : (
        // Busy rather than hidden while any read runs, so the control stays where it was pressed;
        // `loadMore` asks for nothing while a read is in flight either way. Hidden while the list
        // is stale: the next page would follow pages that may have changed, so the notice's Retry
        // above the rows comes first.
        <PrimaryButton
          accessibilityHint="Loads the next favorites"
          busy={pages.isFetching}
          label="Show more"
          onPress={pages.loadMore}
          testID="favorites-show-more"
        />
      )}
    </View>
  );
}
