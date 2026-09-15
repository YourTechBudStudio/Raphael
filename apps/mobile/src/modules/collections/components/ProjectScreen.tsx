import { ChevronLeft, Search } from 'lucide-react-native';
import { useMemo, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { ContainerRef, Resource } from '../../../infrastructure/api/contracts';
import { asClientFailure, isNotFound } from '../../../infrastructure/query/failure';
import {
  Chip,
  EmptyState,
  Eyebrow,
  SectionHeading,
  FavoriteButton,
  IconButton,
  Screen,
  SectionError,
  ActiveButton,
} from '../../../ui';
import { CaptureBar } from '../../capture';
import { RejectionNotice } from '../../connection';
import {
  goBack,
  openBrowse,
  openHome,
  openSearch,
  useSheetsStore,
  LocationTopBar,
} from '../../navigation';
import { ResourceGrid, useLocalResources, type ResourceGridItem } from '../../resources';
import { useProjectActive } from '../client/active';
import { useFavoriteToggle } from '../client/favorites';
import { pathSegments } from '../client/hierarchy';
import { ancestorsOf, useContainer, useContainerPath, useHierarchy } from '../client/queries';
import { ProjectHeaderSkeleton, ProjectNotesSkeleton } from './ProjectSkeleton';
import { ReadOnlyBody } from './ReadOnlyBody';

/** Stands in when there is no client failure to inspect, so the not-found check stays total. */
const NO_FAILURE = {
  kind: 'transport',
  mutationOutcome: 'not_applicable',
  message: '',
} as const;

/** The star beside the 40px title, sized to sit level with its cap height as on the board. */
const TITLE_STAR_SIZE = 22;

export interface ProjectScreenProps {
  /** Null when the route parameter did not name a container. */
  projectId: number | null;
}

/**
 * A project: where it sits, what it is, and every note captured into it.
 *
 * Notes here are kept on this device for the session; the project itself comes from the server.
 */
export function ProjectScreen({ projectId }: ProjectScreenProps) {
  const target = useMemo<ContainerRef | null>(
    () => (projectId === null ? null : { type: 'project', id: projectId }),
    [projectId],
  );

  const favorite = useFavoriteToggle();
  const active = useProjectActive();
  const project = useContainer(target);
  const tree = useHierarchy();
  const notes = useLocalResources();

  const openNewNote = useSheetsStore((state) => state.openNewNote);
  const openVoiceCapture = useSheetsStore((state) => state.openVoiceCapture);

  const entity = project.data;
  const wrongType = entity !== undefined && entity.type !== 'project';
  // A server that looked and found nothing is a project that is gone. A server that could not be
  // asked is a read to try again. Only the first may say "not here".
  const gone = project.isError && isNotFound(asClientFailure(project.error) ?? NO_FAILURE);

  // The chip names where the project lives, so it ends at the parent area, not the project.
  //
  // Titles come from the hierarchy while it is a current reading; otherwise the server is asked for
  // the canonical address. It used to fall back to "Areas", which said the project sat at the top
  // level - something that cannot happen, since every project has a parent area. A screen that
  // cannot name its location now says so rather than making one up, and because the fallback is a
  // live read rather than the hierarchy, there is no stale hierarchy state left on this screen to
  // report: nothing else here comes from it.
  const ancestors = ancestorsOf(tree.hierarchy, projectId);
  const namedHere = ancestors.length > 0 && !tree.isStale;
  const canonical = useContainerPath(namedHere || projectId === null ? null : projectId);
  const parentPath = namedHere
    ? ancestors.slice(0, -1).map((step) => step.title)
    : pathSegments(canonical.data).slice(0, -1);

  const header = (
    <LocationTopBar
      onBack={goBack}
      onOpenBrowse={() => {
        openBrowse(target);
      }}
      onSearch={() => {
        openSearch(target);
      }}
      path={parentPath}
    />
  );

  // Without a project there is no location to name, so the bar drops the path chip and
  // searches everything instead of a node that is not there.
  const bareHeader = (
    <View className="h-14 flex-row items-center justify-between">
      <IconButton icon={ChevronLeft} label="Back" onPress={goBack} />
      <IconButton
        icon={Search}
        label="Search"
        onPress={() => {
          openSearch(null);
        }}
      />
    </View>
  );

  // Absent and failed read differently: one is a project that is gone, the other a read that
  // can be tried again. Saying "not here" about a failed read would be a claim about the data.
  if (projectId === null || wrongType || gone) {
    return (
      <Screen captureBar={false} header={bareHeader}>
        <EmptyState
          description={
            wrongType
              ? 'That link points at an area, not a project.'
              : gone
                ? 'Your server has no project with that id. It may have been removed since this link was made.'
                : 'It may have been removed, or the link is out of date.'
          }
          title={wrongType ? 'That is not a project.' : 'This project is not here.'}
        />
        <View className="mt-4 flex-row">
          <Chip accessibilityHint="Opens the home screen" label="Go to home" onPress={openHome} />
        </View>
      </Screen>
    );
  }

  if (project.isError) {
    return (
      <Screen captureBar={false} header={bareHeader}>
        <RejectionNotice className="mb-4" />
        <SectionError
          onRetry={() => {
            void project.refetch();
          }}
          retrying={project.isFetching}
          title="This project did not load."
        />
      </Screen>
    );
  }

  if (entity === undefined) {
    return (
      <Screen captureBar={false} header={header}>
        <View className="gap-7">
          <ProjectHeaderSkeleton />
          <ProjectNotesSkeleton />
        </View>
      </Screen>
    );
  }

  const { title, description } = entity;
  const resources = (notes.data ?? []).filter(
    (resource) => resource.parent.type === 'project' && resource.parent.id === projectId,
  );

  return (
    <View className="flex-1">
      <Screen
        header={header}
        onRefresh={() => {
          tree.refetch();
          void project.refetch();
        }}
        refreshing={tree.isFetching || project.isFetching}
      >
        <RejectionNotice className="mb-4" />
        <View>
          <Eyebrow>Project</Eyebrow>
          <View className="mt-1 flex-row items-center gap-3">
            <Text
              accessibilityRole="header"
              className="shrink font-heading text-[40px] leading-[48px] text-ink"
            >
              {title}
            </Text>
          </View>
          <Text className="mt-2 font-body text-[16px] leading-[22px] text-ink">{description}</Text>
          <View className="mt-3 flex-row flex-wrap items-center gap-x-5 gap-y-2">
            <View className="flex-row items-center gap-1">
              <ActiveButton
                active={active.isActive(projectId)}
                disabled={active.isDisabled(projectId)}
                label={title}
                onToggle={() => {
                  active.toggle(projectId);
                }}
              />
              <Text className="font-body text-[15px] text-ink-soft">Active</Text>
            </View>
            <View className="flex-row items-center gap-1">
              <FavoriteButton
                favorited={target !== null && favorite.isFavorite(target)}
                label={title}
                onToggle={() => {
                  if (target !== null) favorite.toggle(target);
                }}
                size={TITLE_STAR_SIZE}
              />
              <Text className="font-body text-[15px] text-ink-soft">Favorite</Text>
            </View>
          </View>
          {active.isError ? (
            <Text
              accessibilityLiveRegion="polite"
              className="mt-2 font-body text-[15px] text-danger"
            >
              Active status is unavailable. Reopen this project to try again.
            </Text>
          ) : null}
          {favorite.isError ? (
            <Text
              accessibilityLiveRegion="polite"
              className="mt-2 font-body text-[15px] leading-[22px] text-danger"
            >
              That star did not stick. Tap it again.
            </Text>
          ) : null}
        </View>

        <ReadOnlyBody
          body={entity.body.format === 'markdown' ? entity.body.value : ''}
          kind="project"
        />

        <View className="mt-7 gap-3">
          <SectionHeading>Notes</SectionHeading>
          <ProjectNotes isError={notes.isError} isPending={notes.isPending} resources={resources} />
        </View>
      </Screen>
      <CaptureBar onNewNote={openNewNote} onVoice={openVoiceCapture} />
    </View>
  );
}

/** The grid, its loading shape, and the line that stands in for an empty project. */
function ProjectNotes({
  resources,
  isPending,
  isError,
}: {
  resources: readonly Resource[];
  isPending: boolean;
  isError: boolean;
}): ReactNode {
  if (isError) {
    return (
      <Text
        accessibilityLiveRegion="polite"
        className="font-body text-[16px] leading-[22px] text-ink-soft"
      >
        Unable to load notes.
      </Text>
    );
  }

  if (isPending) {
    return <ProjectNotesSkeleton />;
  }

  if (resources.length === 0) {
    return (
      <Text className="font-body text-[16px] leading-[22px] text-ink-soft">No notes found.</Text>
    );
  }

  // The newest note leads at full width, the way the board opens the section; the rest pair up.
  const items: ResourceGridItem[] = resources.map((resource, index) => ({
    resource,
    ...(index === 0 ? { span: 'full' as const } : {}),
  }));

  return <ResourceGrid items={items} noteVariant="lilac" />;
}
