import { ActivityIndicator, Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { emblemFor, EmptyState, SectionError, colors } from '../../../ui';
import {
  useFavoriteToggle,
  useFavorites,
  useHierarchy,
  CollectionTile,
  HierarchyError,
  HierarchyStale,
  type HierarchyNode,
} from '../../collections';

interface FavoritesListProps {
  query: string;
  onSelect: (ref: ContainerRef) => void;
}

/**
 * Favorites are shortcuts, independent from Home's active projects.
 *
 * A favorite is stored as a reference and nothing more, so its name has to be read out of the
 * hierarchy every time. That is the point: a container renamed on the server is renamed here at
 * once, and a star can never carry a title that stopped being true.
 *
 * It follows that this list needs the hierarchy, and inherits its loading and failure states. A
 * hierarchy that did not load is reported as a hierarchy that did not load - never as "you have no
 * favorites", which would be a claim about someone's data made from a network error.
 *
 * A star pointing at something the loaded hierarchy does not contain is not deleted and not
 * rendered as a broken row. It is counted, and the count is stated, because the star may be
 * pointing at something that was removed on the server and only the owner can decide about that.
 */
export function FavoritesList({ query, onSelect }: FavoritesListProps) {
  const favorites = useFavorites();
  const favorite = useFavoriteToggle();
  const tree = useHierarchy();

  if (tree.isError && tree.hierarchy === undefined) {
    return (
      <HierarchyError
        title="Your areas and projects did not load, so favorites cannot be named."
        tree={tree}
      />
    );
  }

  if (favorites.isError) {
    return (
      <SectionError
        onRetry={() => {
          void favorites.refetch();
        }}
        retrying={favorites.isFetching}
        title="Favorites did not load."
      />
    );
  }

  if (favorites.data === undefined || tree.hierarchy === undefined) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator accessibilityLabel="Loading favorites" color={colors.primary} />
      </View>
    );
  }

  const { hierarchy } = tree;
  const resolved = favorites.data
    .map((ref) => ({ ref, node: hierarchy.byId.get(ref.id) }))
    .filter(
      (entry): entry is { ref: ContainerRef; node: HierarchyNode } =>
        entry.node !== undefined && entry.node.type === entry.ref.type,
    );
  const missing = favorites.data.length - resolved.length;

  const needle = query.trim().toLowerCase();
  const matches = resolved.filter((entry) => entry.node.title.toLowerCase().includes(needle));

  return (
    <View className="gap-2">
      {/* Every row's name is read out of the hierarchy, so a stale hierarchy is stale names. */}
      <HierarchyStale tree={tree} />
      {matches.length === 0 ? (
        <EmptyState
          title={needle === '' ? 'No favorites yet.' : 'No matching favorites.'}
          description={
            needle === ''
              ? 'Star an area or project to keep a shortcut here.'
              : 'Try a different name or clear the filter.'
          }
        />
      ) : (
        matches.map((entry) => (
          <CollectionTile
            key={entry.node.id}
            name={entry.node.title}
            nameNumberOfLines={0}
            compact
            accessibilityHint={`Opens ${entry.node.type} ${entry.node.title}`}
            emblem={emblemFor(entry.node.type, entry.node.id)}
            trailing="favorite"
            favorited={favorite.isFavorite(entry.ref)}
            onToggleFavorite={() => {
              favorite.toggle(entry.ref);
            }}
            onPress={() => {
              onSelect(entry.ref);
            }}
          />
        ))
      )}
      {missing > 0 ? (
        <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
          {missing === 1
            ? 'One starred item is not in this hierarchy any more. It has not been removed from here.'
            : `${String(missing)} starred items are not in this hierarchy any more. They have not been removed from here.`}
        </Text>
      ) : null}
      {favorite.isError ? (
        <Text accessibilityLiveRegion="polite" className="font-body text-[15px] text-danger">
          Favorite did not update. Try again.
        </Text>
      ) : null}
    </View>
  );
}
