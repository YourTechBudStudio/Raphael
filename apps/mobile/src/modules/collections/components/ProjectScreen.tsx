import { ChevronLeft, Search } from 'lucide-react-native';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { asClientFailure, isNotFound } from '../../../infrastructure/query/failure';
import {
  ACTIVE_MARK,
  Chip,
  EmptyState,
  FAVORITE_MARK,
  IconButton,
  Screen,
  SectionError,
  ToggleLabel,
} from '../../../ui';
import { RejectionNotice } from '../../connection';
import {
  goBack,
  openBrowse,
  openEditor,
  openHome,
  openSearch,
  LocationTopBar,
} from '../../navigation';
import {
  CONTAINER_NOTES_COPY,
  NoteSection,
  SessionMediaSection,
  useNotePages,
  useSessionMedia,
} from '../../resources';
import { useProjectActive } from '../client/active';
import { useFavoriteToggle } from '../client/favorites';
import { pathSegments } from '../client/hierarchy';
import {
  ancestorsOf,
  containerTitleLookup,
  useContainer,
  useContainerPath,
  useHierarchy,
} from '../client/queries';
import { ActiveVerdict } from './ActiveVerdict';
import { ContainerEditAction } from './ContainerEditAction';
import { ContainerHeader } from './ContainerHeader';
import { ProjectHeaderSkeleton } from './ProjectSkeleton';
import { ReadOnlyBody } from './ReadOnlyBody';

/** Stands in when there is no client failure to inspect, so the not-found check stays total. */
const NO_FAILURE = {
  kind: 'transport',
  mutationOutcome: 'not_applicable',
  message: '',
} as const;

export interface ProjectScreenProps {
  /** Null when the route parameter did not name a container. */
  projectId: number | null;
}

/**
 * A project: where it sits, what it is, and every note filed in it.
 *
 * The notes are the server's, in its default order, paged as the scroll reaches the end. Media
 * recorded in this session has no server operation at all and keeps its own heading below them.
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
  const notes = useNotePages(target);
  const media = useSessionMedia();

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
        <ProjectHeaderSkeleton />
      </Screen>
    );
  }

  const { title, description } = entity;
  // The write is guarded by the revision this screen actually read, and reports the state it read,
  // so a change made elsewhere since then is refused rather than silently overwritten.
  const activeTarget = { id: entity.id, revision: entity.revision, active: entity.active };
  // Disabled spans the write and the re-read that follows it. While it holds, the ring is the whole
  // message and no sentence is drawn beside it.
  const activeBusy = active.isDisabled(entity.id);
  const sessionMedia = (media.data ?? []).filter(
    (resource) => resource.parent.type === 'project' && resource.parent.id === projectId,
  );

  return (
    <View className="flex-1">
      <Screen
        header={header}
        onEndReached={notes.loadMore}
        // Everything this screen shows, reloaded together; the notes from their first page.
        onRefresh={() => {
          tree.refetch();
          void project.refetch();
          notes.refresh();
          void media.refetch();
        }}
        refreshing={tree.isFetching || project.isFetching || notes.isRefreshing}
      >
        <RejectionNotice className="mb-4" />
        <View>
          <ContainerHeader
            kind="project"
            title={title}
            toggles={
              <>
                <ToggleLabel
                  accessibilityLabel={
                    active.isActive(activeTarget)
                      ? `Mark ${title} as inactive`
                      : `Mark ${title} as active`
                  }
                  disabled={activeBusy}
                  label="Active"
                  mark={ACTIVE_MARK}
                  onToggle={() => {
                    active.toggle(activeTarget);
                  }}
                  selected={active.isActive(activeTarget)}
                />
                <ToggleLabel
                  accessibilityLabel={
                    target !== null && favorite.isFavorite(target)
                      ? `Remove ${title} from favorites`
                      : `Add ${title} to favorites`
                  }
                  label="Favorite"
                  mark={FAVORITE_MARK}
                  onToggle={() => {
                    if (target !== null) favorite.toggle(target);
                  }}
                  selected={target !== null && favorite.isFavorite(target)}
                />
                <ContainerEditAction id={projectId} kind="project" />
              </>
            }
          />
          <ActiveVerdict className="mt-2" failure={activeBusy ? null : active.failure} />
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
          description={description}
          kind="project"
        />

        <NoteSection
          className="mt-7"
          copy={CONTAINER_NOTES_COPY}
          locationFor={containerTitleLookup(tree)}
          onOpen={openEditor}
          testID="project-notes"
          view={notes.view}
        />

        <SessionMediaSection className="mt-7" items={sessionMedia} testID="project-session-media" />
      </Screen>
    </View>
  );
}
