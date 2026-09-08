import { FileText, Layers } from 'lucide-react-native';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import type { ParentRef } from '../../../infrastructure/api/contracts';
import {
  Chip,
  EmptyState,
  Eyebrow,
  SectionHeading,
  FavoriteButton,
  Screen,
  SectionError,
} from '../../../ui';
import { CaptureBar } from '../../capture';
import {
  goBack,
  openArea,
  openHome,
  openProject,
  openSearch,
  useSheetsStore,
  LocationTopBar,
} from '../../navigation';
import { ResourceGrid } from '../../resources';
import { useFavoriteToggle } from '../client/favorites';
import { useArea, useAreaContents, useLocationPath } from '../client/queries';
import { areaNoteGridItems } from './noteSpans';
import { TileGrid, type TileGridItem } from './TileGrid';

export interface AreaScreenProps {
  areaId: string;
}

/** The Area screen: where it sits, what it holds, and what it is called. */
export function AreaScreen({ areaId }: AreaScreenProps) {
  const known = areaId !== '';
  const target = useMemo<ParentRef>(() => ({ type: 'area', id: areaId }), [areaId]);

  const favorite = useFavoriteToggle();
  const areaQuery = useArea(areaId);
  const contentsQuery = useAreaContents(areaId);
  const { data: path } = useLocationPath(target);

  const area = areaQuery.data;
  const contents = contentsQuery.data;

  const openBrowse = useSheetsStore((state) => state.openBrowse);
  const openNewNote = useSheetsStore((state) => state.openNewNote);
  const openVoiceCapture = useSheetsStore((state) => state.openVoiceCapture);

  const names = (path ?? []).map((step) => step.name);
  // A root area has only itself in the path, so the chip names the collection it belongs to.
  const chipPath = names.length > 1 ? names : ['Areas', ...names];

  // A screen that cannot name its location browses and searches everything instead of a dead node.
  const notFound = !known || (area === null && !areaQuery.isPending);
  // A failed read is not a missing area, but neither one can name a location for the chip.
  const failed = areaQuery.isError;
  const scope = notFound || failed ? null : target;

  const header = (
    <LocationTopBar
      onBack={goBack}
      onOpenBrowse={() => {
        openBrowse(scope);
      }}
      onSearch={() => {
        openSearch(scope);
      }}
      path={notFound || failed ? ['Areas'] : chipPath}
    />
  );

  if (notFound) {
    return (
      <Screen captureBar={false} header={header}>
        <EmptyState
          description="The link may be old, or the area was removed. Home still knows where everything is."
          icon={Layers}
          title="We could not find that area."
        />
        <View className="mt-4 flex-row">
          <Chip accessibilityHint="Opens the home screen" label="Go to home" onPress={openHome} />
        </View>
      </Screen>
    );
  }

  if (failed) {
    return (
      <Screen captureBar={false} header={header}>
        <SectionError
          onRetry={() => {
            void areaQuery.refetch();
          }}
          retrying={areaQuery.isFetching}
          title="This area did not load."
        />
      </Screen>
    );
  }

  const subareas = contents?.subareas ?? [];
  const projects = contents?.projects ?? [];
  const resources = contents?.resources ?? [];
  // The boards give a project tile its description only when subareas are not using the space.
  const showProjectDescriptions = subareas.length === 0;

  const subareaTiles: TileGridItem[] = subareas.map((subarea) => ({
    id: subarea.id,
    name: subarea.name,
    emblem: subarea.emblem,
    onPress: () => {
      openArea(subarea.id);
    },
  }));

  const projectTiles: TileGridItem[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    emblem: project.emblem,
    description: showProjectDescriptions ? project.description : undefined,
    onPress: () => {
      openProject(project.id);
    },
  }));

  return (
    <View className="flex-1">
      <Screen header={header}>
        <Eyebrow>Area</Eyebrow>
        <Text
          accessibilityRole="header"
          className="mt-1 font-heading text-[40px] leading-[48px] text-ink"
        >
          {area === undefined || area === null ? 'Loading…' : area.name}
        </Text>
        {area === undefined || area === null ? null : (
          <Text className="mt-2 font-body text-[16px] leading-[22px] text-ink">
            {area.description}
          </Text>
        )}

        {area === undefined || area === null ? null : (
          <View className="mt-3 flex-row items-center gap-1">
            <FavoriteButton
              favorited={favorite.isFavorite(target)}
              label={area.name}
              onToggle={() => {
                favorite.toggle(target);
              }}
            />
            <Text className="font-body text-[15px] text-ink-soft">Favorite</Text>
          </View>
        )}
        {favorite.isError ? (
          <Text accessibilityLiveRegion="polite" className="mt-2 font-body text-[15px] text-danger">
            Favorite did not update. Try again.
          </Text>
        ) : null}

        {contentsQuery.isError ? (
          <View className="mt-8">
            <SectionError
              onRetry={() => {
                void contentsQuery.refetch();
              }}
              retrying={contentsQuery.isFetching}
              title="What this area holds did not load."
            />
          </View>
        ) : contents === undefined ? (
          // Until the contents arrive, say so. Empty sections here would claim the area is bare.
          <Text
            accessibilityRole="text"
            className="mt-8 font-body text-[16px] leading-[22px] text-ink-soft"
          >
            Loading what this area holds…
          </Text>
        ) : (
          <>
            {subareas.length > 0 ? (
              <View className="mt-8 gap-4">
                <SectionHeading>Subareas</SectionHeading>
                <TileGrid items={subareaTiles} />
              </View>
            ) : null}

            <View className="mt-8 gap-4">
              <SectionHeading>Projects</SectionHeading>
              {projectTiles.length > 0 ? (
                <TileGrid items={projectTiles} />
              ) : (
                <EmptyState
                  description="Projects with an end in sight belong here. This area has none yet."
                  title="No projects in this area."
                />
              )}
            </View>

            <View className="mt-8 gap-4">
              <SectionHeading>Notes in this area</SectionHeading>
              {resources.length > 0 ? (
                <ResourceGrid items={areaNoteGridItems(resources)} noteVariant="lilac" />
              ) : (
                <EmptyState
                  description="Notes kept here, rather than in one of its projects, show up in this list."
                  icon={FileText}
                  title="Nothing kept here yet."
                />
              )}
            </View>
          </>
        )}
      </Screen>
      <CaptureBar
        onNewNote={() => {
          openNewNote(target);
        }}
        onVoice={() => {
          openVoiceCapture(target);
        }}
        targetName={area?.name}
      />
    </View>
  );
}
