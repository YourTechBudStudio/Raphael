import { Text, View } from 'react-native';

import type { Resource } from '../../../infrastructure/api/contracts';
import { EmptyState, Screen, SectionError, SectionHeading, Chip } from '../../../ui';
import { CaptureBar } from '../../capture';
import {
  HierarchyStale,
  PendingSummary,
  useActiveProjectIds,
  useHierarchy,
  useProjectActive,
  type HierarchyNode,
} from '../../collections';
import { RejectionNotice } from '../../connection';
import { MockCaptureLift, MockHomeSnackbar, MockRecentNotes, useMockStore } from '../../mock';
import {
  openBrowse,
  openMockDraft,
  openMockGallery,
  openMockNote,
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
  const showMore = useMockStore((state) => state.showMore);
  const refreshing = useMockStore((state) => state.refreshing);
  const refreshFeed = useMockStore((state) => state.refresh);

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
        onEndReached={showMore}
        // Pull down reloads everything Home shows: the hierarchy the project cards are named from,
        // the active list, and the notes. The mock only pretends for the notes.
        onRefresh={() => {
          tree.refetch();
          void selected.refetch();
          void feed.refetch();
          refreshFeed();
        }}
        refreshing={refreshing || tree.isFetching}
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
          {/* THROWAWAY: temporary entry to the UI mocks. Remove with `modules/mock`. */}
          {__DEV__ ? (
            <View className="flex-row">
              <Chip label="UI mocks (temporary)" onPress={openMockGallery} />
            </View>
          ) : null}
          {/* Every unfinished creation, including the root-targeted ones that belong to no area and
              would otherwise be discoverable nowhere. Read from the local record, so it is here
              whether or not the server can be reached. */}
          <PendingSummary onOpen={openRecovery} />
          <View className="gap-3">
            <SectionHeading>Active projects</SectionHeading>
            {/* These cards are named from the hierarchy, so a stale hierarchy is stale names. */}
            <HierarchyStale tree={tree} />
            {/* A section that has nothing to show says so in one quiet line, not a card: the
                cards are for content, and an empty or failed section is not content. */}
            {projectsFailed ? (
              <Text
                accessibilityLiveRegion="polite"
                className="font-body text-[15px] leading-[22px] text-ink-soft"
              >
                Unable to load active projects.
              </Text>
            ) : projects === undefined ? (
              <ActiveSkeleton />
            ) : projects.length === 0 ? (
              <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
                No active projects. Mark one as Active from its page to keep it here.
              </Text>
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

          {/* THROWAWAY: the mock Recent notes section stands in for the session-only feed. */}
          {__DEV__ ? (
            <MockRecentNotes onOpen={openMockNote} onOpenDraft={openMockDraft} />
          ) : (
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
          )}
        </View>
      </Screen>
      {/* THROWAWAY: the wrapper lets the mock snackbar lift the capture pair. */}
      <MockCaptureLift>
        <CaptureBar onNewNote={openNewNote} onVoice={openVoiceCapture} />
      </MockCaptureLift>
      {__DEV__ ? <MockHomeSnackbar /> : null}
    </View>
  );
}
