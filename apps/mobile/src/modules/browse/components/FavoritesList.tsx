import { ActivityIndicator, Text, View } from 'react-native';

import type { ParentRef } from '../../../infrastructure/api/contracts';
import { EmptyState, SectionError, colors } from '../../../ui';
import { useFavoriteToggle, useFavorites, CollectionTile } from '../../collections';

interface FavoritesListProps {
  query: string;
  onSelect: (ref: ParentRef) => void;
}

/** Favorites are shortcuts, independent from Home's active projects. */
export function FavoritesList({ query, onSelect }: FavoritesListProps) {
  const favorites = useFavorites();
  const favorite = useFavoriteToggle();

  if (favorites.isError) {
    return (
      <SectionError
        title="Favorites did not load."
        retrying={favorites.isFetching}
        onRetry={() => {
          void favorites.refetch();
        }}
      />
    );
  }

  if (favorites.data === undefined) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator accessibilityLabel="Loading favorites" color={colors.primary} />
      </View>
    );
  }

  const needle = query.trim().toLowerCase();
  const matches = favorites.data.filter((collection) =>
    collection.name.toLowerCase().includes(needle),
  );

  return (
    <View className="gap-2">
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
        matches.map((collection) => (
          <CollectionTile
            key={`${collection.type}:${collection.id}`}
            name={collection.name}
            nameNumberOfLines={0}
            compact
            accessibilityHint={`Opens ${collection.type} ${collection.name}`}
            emblem={collection.emblem}
            trailing="favorite"
            favorited={favorite.isFavorite(collection)}
            onToggleFavorite={() => {
              favorite.toggle(collection);
            }}
            onPress={() => {
              onSelect(collection);
            }}
          />
        ))
      )}
      {favorite.isError ? (
        <Text accessibilityLiveRegion="polite" className="font-body text-[15px] text-danger">
          Favorite did not update. Try again.
        </Text>
      ) : null}
    </View>
  );
}
