import { FileText, Layers } from 'lucide-react-native';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { asClientFailure, isNotFound } from '../../../infrastructure/query/failure';
import {
  Chip,
  emblemFor,
  EmptyState,
  Eyebrow,
  SectionHeading,
  FavoriteButton,
  Screen,
  SectionError,
} from '../../../ui';
import { CaptureBar } from '../../capture';
import { RejectionNotice } from '../../connection';
import {
  goBack,
  openArea,
  openBrowse,
  openHome,
  openProject,
  openSearch,
  useSheetsStore,
  LocationTopBar,
} from '../../navigation';
import { ResourceGrid, useLocalResources } from '../../resources';
import { useFavoriteToggle } from '../client/favorites';
import { pathSegments } from '../client/hierarchy';
import {
  ancestorsOf,
  childrenOf,
  useContainer,
  useContainerPath,
  useHierarchy,
} from '../client/queries';
import { HierarchyError, HierarchyStale } from './HierarchyError';
import { areaNoteGridItems } from './noteSpans';
import { ReadOnlyBody } from './ReadOnlyBody';
import { TileGrid, type TileGridItem } from './TileGrid';

/** Stands in when there is no client failure to inspect, so the not-found check stays total. */
const NO_FAILURE = {
  kind: 'transport',
  mutationOutcome: 'not_applicable',
  message: '',
} as const;

export interface AreaScreenProps {
  /** Null when the route parameter did not name a container. */
  areaId: number | null;
}

/**
 * The Area screen: where it sits, what it holds, and what it is called.
 *
 * Two reads, and deliberately not three. Get supplies the area itself, because only Get carries a
 * body. What the area holds comes from the one shared hierarchy every screen reads, rather than a
 * List of its own: two reads of the same fact can disagree, and someone with the tree and this
 * screen both in front of them would see the disagreement.
 *
 * Notes here are kept on this device for the session. They sit under the same heading as before and
 * are not marked as different, which is a condition the owner accepted rather than an oversight.
 */
export function AreaScreen({ areaId }: AreaScreenProps) {
  const target = useMemo<ContainerRef | null>(
    () => (areaId === null ? null : { type: 'area', id: areaId }),
    [areaId],
  );

  const favorite = useFavoriteToggle();
  const areaQuery = useContainer(target);
  const tree = useHierarchy();
  const notes = useLocalResources();

  const openNewNote = useSheetsStore((state) => state.openNewNote);
  const openVoiceCapture = useSheetsStore((state) => state.openVoiceCapture);

  const entity = areaQuery.data;
  // A route can name a real container of the wrong kind. Rendering a project as an area would
  // describe it with the wrong vocabulary and offer the wrong actions, so it is refused.
  const wrongType = entity !== undefined && entity.type !== 'area';
  // The server looking and finding nothing is not the same as not being able to ask. Only the
  // first is "this is gone"; the second is a read to try again, and offering the wrong one of the
  // two either loops someone forever or tells them their area was deleted because the wifi dropped.
  const gone = areaQuery.isError && isNotFound(asClientFailure(areaQuery.error) ?? NO_FAILURE);
  const notFound = areaId === null || wrongType || gone;
  const failed = areaQuery.isError && !gone;

  const ancestors = ancestorsOf(tree.hierarchy, areaId);
  // Titles are what a person wants to read, and the hierarchy has them - but only while it is a
  // current reading. A hierarchy that has not arrived, that failed, or that is known to be out of
  // date cannot be asked where something is, because the answer would be last week's answer.
  const namedHere = ancestors.length > 0 && !tree.isStale;
  // So the server is asked instead, and only then. This is the canonical current address, in slugs
  // rather than titles, which is less friendly and entirely true.
  const canonical = useContainerPath(namedHere || notFound ? null : areaId);
  const names = ancestors.map((step) => step.title);
  // A root area has only itself in the path, so the chip names the collection it belongs to.
  const chipPath = namedHere
    ? names.length > 1
      ? names
      : ['Areas', ...names]
    : pathSegments(canonical.data);
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
      path={notFound || failed ? [] : chipPath}
    />
  );

  if (notFound) {
    return (
      <Screen captureBar={false} header={header}>
        <EmptyState
          description={
            wrongType
              ? 'That link points at a project, not an area. Browse knows where everything is.'
              : gone
                ? 'Your server has no area with that id. It may have been removed since this link was made.'
                : 'The link may be old, or the area was removed. Browse still knows where everything is.'
          }
          icon={Layers}
          title={wrongType ? 'That is not an area.' : 'We could not find that area.'}
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
        <RejectionNotice className="mb-4" />
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

  const children = childrenOf(tree.hierarchy, areaId);
  const subareas = children?.subareas ?? [];
  const projects = children?.projects ?? [];
  const resources = (notes.data ?? []).filter(
    (resource) => resource.parent.type === 'area' && resource.parent.id === areaId,
  );
  // The boards give a project tile its description only when subareas are not using the space.
  const showProjectDescriptions = subareas.length === 0;

  const subareaTiles: TileGridItem[] = subareas.map((subarea) => ({
    id: String(subarea.id),
    name: subarea.title,
    emblem: emblemFor('area', subarea.id),
    onPress: () => {
      openArea(subarea.id);
    },
  }));

  const projectTiles: TileGridItem[] = projects.map((project) => ({
    id: String(project.id),
    name: project.title,
    emblem: emblemFor('project', project.id),
    description: showProjectDescriptions ? project.description : undefined,
    onPress: () => {
      openProject(project.id);
    },
  }));

  return (
    <View className="flex-1">
      <Screen header={header}>
        <RejectionNotice className="mb-4" />
        <Eyebrow>Area</Eyebrow>
        <Text
          accessibilityRole="header"
          className="mt-1 font-heading text-[40px] leading-[48px] text-ink"
        >
          {entity === undefined ? 'Loading…' : entity.title}
        </Text>
        {entity === undefined ? null : (
          <Text className="mt-2 font-body text-[16px] leading-[22px] text-ink">
            {entity.description}
          </Text>
        )}

        {entity === undefined || target === null ? null : (
          <View className="mt-3 flex-row flex-wrap items-center gap-x-3 gap-y-2">
            <View className="flex-row items-center gap-1">
              <FavoriteButton
                favorited={favorite.isFavorite(target)}
                label={entity.title}
                onToggle={() => {
                  favorite.toggle(target);
                }}
              />
              <Text className="font-body text-[15px] text-ink-soft">Favorite</Text>
            </View>
          </View>
        )}
        {favorite.isError ? (
          <Text accessibilityLiveRegion="polite" className="mt-2 font-body text-[15px] text-danger">
            Favorite did not update. Try again.
          </Text>
        ) : null}

        {entity === undefined ? null : (
          <ReadOnlyBody
            body={entity.body.format === 'markdown' ? entity.body.value : ''}
            kind="area"
          />
        )}

        {tree.isError && tree.hierarchy === undefined ? (
          <View className="mt-8">
            <HierarchyError title="What this area holds did not load." tree={tree} />
          </View>
        ) : tree.hierarchy === undefined ? (
          // Until the hierarchy arrives, say so. Empty sections here would claim the area is bare.
          <Text
            accessibilityRole="text"
            className="mt-8 font-body text-[16px] leading-[22px] text-ink-soft"
          >
            Loading what this area holds…
          </Text>
        ) : children === undefined ? (
          // The hierarchy loaded and this area is not in it, while Get answered for it. The two
          // reads disagree, which is a real possibility while someone is editing on the server.
          // Saying "loading" forever, or showing no subareas as though it had none, would both be
          // inventions; the honest move is to name the disagreement and offer a fresh read.
          <View className="mt-8">
            <SectionError
              onRetry={tree.refetch}
              retrying={tree.isFetching}
              title="This area was not in the hierarchy Raphael last read."
            />
          </View>
        ) : (
          <>
            <HierarchyStale className="mt-8" tree={tree} />

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
      <CaptureBar onNewNote={openNewNote} onVoice={openVoiceCapture} />
    </View>
  );
}
