import { useState } from 'react';
import { Text, View } from 'react-native';

import { Screen, SectionHeading, Snackbar, SNACKBAR_GAP } from '../../../ui';
import {
  CaptureDock,
  UnfinishedGridCard,
  useHomeUnfinishedNotes,
  useSaveNotice,
} from '../../capture';
import {
  containerTitleLookup,
  HierarchyStale,
  useActiveProjectIds,
  useHierarchy,
  useProjectActive,
  type HierarchyNode,
} from '../../collections';
import { RejectionNotice } from '../../connection';
import {
  openBrowse,
  openCapture,
  openEditor,
  openSearch,
  openSettings,
  HomeTopBar,
} from '../../navigation';
import {
  HOME_NOTES_COPY,
  NoteSection,
  SessionMediaSection,
  useNoteFeed,
  useSessionMedia,
  type NoteGridLeadingItem,
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
 * The Notes feed is the server's, newest edit first, paged as the scroll reaches its end. Nothing
 * local is mixed into it and nothing is sorted here. What *is* local leads it: the notes this phone
 * holds and the server does not, as cards in the same grid, most pressing first. They are drawn
 * above whatever the feed is doing - including its empty and failed lines - because they are on this
 * phone whatever the server is up to.
 *
 * A save that landed is told here, once, by a snackbar, and the receipt that made it appear is spent
 * only when it has actually been shown. That is why a success survives a crash: the record is
 * retained precisely so it can be reported on the next launch rather than disappearing with the
 * process that earned it.
 */
export function HomeScreen() {
  const selected = useActiveProjectIds();
  const tree = useHierarchy();
  const active = useProjectActive();
  const feed = useNoteFeed();
  const media = useSessionMedia();
  const unfinished = useHomeUnfinishedNotes();
  const notice = useSaveNotice();
  const [snackbarHeight, setSnackbarHeight] = useState(0);
  // Sampled once per render: a grid of cards should read one clock, and none of these labels
  // changes second by second.
  const [now] = useState(() => Date.now());

  const hierarchy = tree.hierarchy;
  const projects: readonly HierarchyNode[] | undefined =
    selected.data === undefined || hierarchy === undefined
      ? undefined
      : selected.data
          .map((id) => hierarchy.byId.get(id))
          .filter((node): node is HierarchyNode => node !== undefined && node.type === 'project');
  const projectsFailed = selected.isError || (tree.isError && hierarchy === undefined);

  const leading: readonly NoteGridLeadingItem[] = unfinished.map((note) => {
    const draftId = note.draftId;

    return {
      key: note.key,
      card: (
        <UnfinishedGridCard
          note={note}
          now={now}
          // An attempt whose draft is gone has nothing to open. It stays reachable in recovery,
          // where its evidence can be read without pretending there is a note behind it.
          onOpen={
            draftId === null
              ? undefined
              : () => {
                  openCapture(draftId);
                }
          }
        />
      ),
    };
  });

  return (
    <View className="flex-1">
      <Screen
        onEndReached={feed.loadMore}
        // Pull down reloads everything Home shows: the hierarchy the project cards are named from,
        // the active list, and the notes - the notes from their first page, not by re-reading every
        // page that happens to be held. It is not a way to confirm a save; Retry is.
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
            leading={leading}
            locationFor={containerTitleLookup(tree)}
            onOpen={openEditor}
            testID="home-notes"
            view={feed.view}
          />

          <SessionMediaSection items={media.data ?? []} testID="home-session-media" />
        </View>
      </Screen>

      <CaptureDock lift={notice.message === null ? 0 : snackbarHeight + SNACKBAR_GAP} />

      <Snackbar
        message={notice.message}
        onHeight={setSnackbarHeight}
        onHidden={notice.onHidden}
        onShown={notice.onShown}
        testID="home-snackbar"
      />
    </View>
  );
}
