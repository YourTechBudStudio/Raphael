import { Text, View } from 'react-native';

import { Screen, SectionHeading } from '../../../ui';
import { CaptureBar } from '../../capture';
import {
  containerTitleLookup,
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
  openResource,
  openSearch,
  openSettings,
  useSheetsStore,
  HomeTopBar,
} from '../../navigation';
import {
  HOME_NOTES_COPY,
  NoteSection,
  SessionMediaSection,
  useNoteFeed,
  useSessionMedia,
} from '../../resources';
import { ActiveProjectCard } from './ActiveProjectCard';
import { ActiveSkeleton } from './Skeletons';

/**
 * Home orients first: deliberately active projects together, then every note on the server.
 *
 * An active project is stored as an id, so the card's title and description are read out of the
 * hierarchy. That makes this section depend on the hierarchy loading, and it reports that
 * dependency honestly rather than showing an empty list when the server could not be reached.
 *
 * The Notes feed is the server's, newest edit first, paged as the scroll reaches its end. It is not
 * a list of recent activity on this phone: nothing local is mixed into it, nothing is sorted here,
 * and no body is fetched to draw a card. Media recorded in this session keeps its own section below,
 * because it has no server operation and saying otherwise by putting it under the same heading would
 * be the one thing this screen must not do.
 *
 * New note is deliberately absent until the durable capture owner is wired to it.
 */
export function HomeScreen() {
  const selected = useActiveProjectIds();
  const tree = useHierarchy();
  const active = useProjectActive();
  const feed = useNoteFeed();
  const media = useSessionMedia();
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
        onEndReached={feed.loadMore}
        // Pull down reloads everything Home shows: the hierarchy the project cards are named from,
        // the active list, and the notes - the notes from their first page, not by re-reading every
        // page that happens to be held.
        onRefresh={() => {
          tree.refetch();
          void selected.refetch();
          feed.refresh();
          void media.refetch();
        }}
        refreshing={feed.isRefreshing || tree.isFetching}
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

          <NoteSection
            copy={HOME_NOTES_COPY}
            locationFor={containerTitleLookup(tree)}
            onOpen={openResource}
            testID="home-notes"
            view={feed.view}
          />

          <SessionMediaSection items={media.data ?? []} testID="home-session-media" />
        </View>
      </Screen>
      <CaptureBar onVoice={openVoiceCapture} />
    </View>
  );
}
