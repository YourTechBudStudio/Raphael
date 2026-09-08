import { ChevronLeft, Search } from 'lucide-react-native';
import { useMemo, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { ParentRef, Resource } from '../../../infrastructure/api/contracts';
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
import { goBack, openHome, openSearch, useSheetsStore, LocationTopBar } from '../../navigation';
import { ResourceGrid, type ResourceGridItem } from '../../resources';
import { useProjectActive } from '../client/active';
import { useFavoriteToggle } from '../client/favorites';
import { useLocationPath, useProject, useProjectContents } from '../client/queries';
import { ProjectHeaderSkeleton, ProjectNotesSkeleton } from './ProjectSkeleton';

/** Stands in for the ancestor chain for the ~120 ms before it arrives. */
const FALLBACK_PATH = ['Areas'];

/** The star beside the 40px title, sized to sit level with its cap height as on the board. */
const TITLE_STAR_SIZE = 22;

export interface ProjectScreenProps {
  projectId: string;
}

/**
 * A project: where it sits, what it is, and every note captured into it. The location chip
 * carries the parent area chain, and the capture bar writes here rather than to the inbox.
 */
export function ProjectScreen({ projectId }: ProjectScreenProps) {
  // A route without an id names no project, so the queries never run and nothing is on its way.
  const known = projectId !== '';
  const target = useMemo<ParentRef>(() => ({ type: 'project', id: projectId }), [projectId]);

  const favorite = useFavoriteToggle();
  const active = useProjectActive();
  const project = useProject(projectId);
  const contents = useProjectContents(projectId);
  const locationPath = useLocationPath(target);

  const openBrowse = useSheetsStore((state) => state.openBrowse);
  const openNewNote = useSheetsStore((state) => state.openNewNote);
  const openVoiceCapture = useSheetsStore((state) => state.openVoiceCapture);

  // The chip names where the project lives, so it ends at the parent area, not the project.
  const parentPath = (locationPath.data ?? []).slice(0, -1).map((step) => step.name);

  const goToSearch = () => {
    openSearch(target);
  };

  const header = (
    <LocationTopBar
      onBack={goBack}
      onOpenBrowse={() => {
        openBrowse(target);
      }}
      onSearch={goToSearch}
      path={parentPath.length > 0 ? parentPath : FALLBACK_PATH}
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
  if (!known || project.data === null) {
    return (
      <Screen captureBar={false} header={bareHeader}>
        <EmptyState
          description="It may have been removed, or the link is out of date."
          title="This project is not here."
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

  if (project.isPending || project.data === undefined) {
    return (
      <Screen captureBar={false} header={header}>
        <View className="gap-7">
          <ProjectHeaderSkeleton />
          <ProjectNotesSkeleton />
        </View>
      </Screen>
    );
  }

  const { name, description } = project.data;

  return (
    <View className="flex-1">
      <Screen header={header}>
        <View>
          <Eyebrow>Project</Eyebrow>
          <View className="mt-1 flex-row items-center gap-3">
            <Text
              accessibilityRole="header"
              className="shrink font-heading text-[40px] leading-[48px] text-ink"
            >
              {name}
            </Text>
          </View>
          <Text className="mt-2 font-body text-[16px] leading-[22px] text-ink">{description}</Text>
          <View className="mt-3 flex-row flex-wrap items-center gap-x-5 gap-y-2">
            <View className="flex-row items-center gap-1">
              <ActiveButton
                active={active.isActive(projectId)}
                disabled={active.isDisabled(projectId)}
                label={name}
                onToggle={() => {
                  active.toggle(projectId);
                }}
              />
              <Text className="font-body text-[15px] text-ink-soft">Active</Text>
            </View>
            <View className="flex-row items-center gap-1">
              <FavoriteButton
                favorited={favorite.isFavorite(target)}
                label={name}
                onToggle={() => {
                  favorite.toggle(target);
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

        <View className="mt-7 gap-3">
          <SectionHeading>Project notes</SectionHeading>
          <ProjectNotes
            isError={contents.isError}
            isPending={contents.isPending}
            onRetry={() => {
              void contents.refetch();
            }}
            resources={contents.data?.resources ?? []}
            retrying={contents.isFetching}
          />
        </View>
      </Screen>
      <CaptureBar
        onNewNote={() => {
          openNewNote(target);
        }}
        onVoice={() => {
          openVoiceCapture(target);
        }}
        targetName={name}
      />
    </View>
  );
}

/** The grid, its loading shape, and the line that stands in for an empty project. */
function ProjectNotes({
  resources,
  isPending,
  isError,
  retrying,
  onRetry,
}: {
  resources: readonly Resource[];
  isPending: boolean;
  isError: boolean;
  retrying: boolean;
  onRetry: () => void;
}): ReactNode {
  if (isError) {
    return <SectionError onRetry={onRetry} retrying={retrying} title="These notes did not load." />;
  }

  if (isPending) {
    return <ProjectNotesSkeleton />;
  }

  if (resources.length === 0) {
    return (
      <EmptyState
        description="Even a half-finished thought counts."
        title="No notes in this project yet."
      />
    );
  }

  // The newest note leads at full width, the way the board opens the section; the rest pair up.
  const items: ResourceGridItem[] = resources.map((resource, index) => ({
    resource,
    ...(index === 0 ? { span: 'full' as const } : {}),
  }));

  return <ResourceGrid items={items} noteVariant="lilac" />;
}
