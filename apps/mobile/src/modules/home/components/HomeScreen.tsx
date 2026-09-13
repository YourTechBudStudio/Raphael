import { Text, View } from 'react-native';

import type { Resource } from '../../../infrastructure/api/contracts';
import { EmptyState, Screen, SectionError, SectionHeading, Chip } from '../../../ui';
import { CaptureBar } from '../../capture';
import {
  HierarchyError,
  HierarchyStale,
  PendingSummary,
  useActiveProjectIds,
  useHierarchy,
  useProjectActive,
  type HierarchyNode,
} from '../../collections';
import { RejectionNotice } from '../../connection';
import {
  openBrowse,
  openRecovery,
  openSearch,
  openSettings,
  useSheetsStore,
  HomeTopBar,
} from '../../navigation';
import { ResourceGrid, type ResourceGridItem } from '../../resources';
import { useHomeFeed } from '../client/queries';
import { ActiveProjectCard } from './ActiveProjectCard';
import { ActiveSkeleton, NotesSkeleton } from './Skeletons';

/**
 * The feed reads as the board does: the first voice note takes the full width so its waveform
 * and play button have room, and everything after it pairs up into columns.
 */
function toGridItems(feed: readonly Resource[]): ResourceGridItem[] {
  let voiceSpanned = false;

  return feed.map((resource) => {
    if (resource.kind === 'voice' && !voiceSpanned) {
      voiceSpanned = true;

      return { resource, span: 'full' };
    }

    return { resource };
  });
}

/**
 * Home orients first: deliberately active projects together, then recent captures.
 *
 * An active project is stored as an id, so the card's title and description are read out of the
 * hierarchy. That makes this section depend on the hierarchy loading, and it reports that
 * dependency honestly rather than showing an empty list when the server could not be reached.
 *
 * The notes here are kept on this device for the session.
 */
export function HomeScreen() {
  const selected = useActiveProjectIds();
  const tree = useHierarchy();
  const active = useProjectActive();
  const feed = useHomeFeed();
  const openNewNote = useSheetsStore((state) => state.openNewNote);
  const openVoiceCapture = useSheetsStore((state) => state.openVoiceCapture);

  const hierarchy = tree.hierarchy;
  const projects: readonly HierarchyNode[] | undefined =
    selected.data === undefined || hierarchy === undefined
      ? undefined
      : selected.data
          .map((id) => hierarchy.byId.get(id))
          .filter((node): node is HierarchyNode => node !== undefined && node.type === 'project');
  const projectsFailed = selected.isError || (tree.isError && hierarchy === undefined);

  return (
    <View className="flex-1">
      <Screen
        header={
          <HomeTopBar
            onBrowse={openBrowse}
            onSearch={() => {
              openSearch(null);
            }}
            onSettings={openSettings}
          />
        }
      >
        <View className="gap-7">
          <RejectionNotice />
          {/* Every unfinished creation, including the root-targeted ones that belong to no area and
              would otherwise be discoverable nowhere. Read from the local record, so it is here
              whether or not the server can be reached. */}
          <PendingSummary onOpen={openRecovery} />
          <View className="gap-3">
            <SectionHeading>Active projects</SectionHeading>
            {/* These cards are named from the hierarchy, so a stale hierarchy is stale names. */}
            <HierarchyStale tree={tree} />
            {projectsFailed && !selected.isError ? (
              // Only the hierarchy failed, so it gets to explain itself - and to decline a retry
              // when trying again cannot help.
              <HierarchyError title="Active projects did not load." tree={tree} />
            ) : projectsFailed ? (
              <SectionError
                onRetry={() => {
                  if (selected.isError) void selected.refetch();
                  if (tree.isError) tree.refetch();
                }}
                retrying={selected.isFetching || tree.isFetching}
                title="Active projects did not load."
              />
            ) : projects === undefined ? (
              <ActiveSkeleton />
            ) : projects.length === 0 ? (
              <View className="gap-3">
                <EmptyState
                  description="Open a project from Browse and mark it as Active to keep it here."
                  title="What deserves your attention?"
                />
                <Chip label="Browse projects" onPress={openBrowse} />
              </View>
            ) : (
              projects.map((project) => (
                <ActiveProjectCard
                  key={project.id}
                  project={project}
                  active={active.isActive(project.id)}
                  disabled={active.isDisabled(project.id)}
                  onToggle={() => {
                    active.toggle(project.id);
                  }}
                />
              ))
            )}
            {active.isError && !projectsFailed ? (
              <Text accessibilityLiveRegion="polite" className="font-body text-[15px] text-danger">
                Active status did not update. Try again.
              </Text>
            ) : null}
          </View>

          <View className="gap-3">
            <SectionHeading>Notes</SectionHeading>
            {feed.isError ? (
              <SectionError
                onRetry={() => {
                  void feed.refetch();
                }}
                retrying={feed.isFetching}
                title="Notes did not load."
              />
            ) : feed.data === undefined ? (
              <NotesSkeleton />
            ) : feed.data.length === 0 ? (
              <EmptyState
                description="Start one with New note, or hold the thought with the mic."
                title="No notes yet."
              />
            ) : (
              <ResourceGrid items={toGridItems(feed.data)} />
            )}
          </View>
        </View>
      </Screen>
      <CaptureBar onNewNote={openNewNote} onVoice={openVoiceCapture} />
    </View>
  );
}
