import { CloudOff } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Chip, Screen, SectionHeading, Snackbar, SNACKBAR_GAP } from '../../../ui';
import { CaptureDock, useSaveNotice, useUnfinishedTally } from '../../capture';
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
  openEditor,
  openRecovery,
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
 * local is mixed into it and nothing is sorted here.
 *
 * What is local is counted instead of drawn. Home used to lead the grid with cards for the notes this
 * phone holds and the server does not; it now carries one chip beside the Notes heading saying how
 * many things are not on the server, and Recovery - which the chip opens - is where they are read and
 * acted on. The chip is absent at zero, so an ordinary Home says nothing about unfinished work at
 * all, and it counts everything Recovery lists, transient rows included, because a number that
 * disagreed with the screen it opens would be worse than either alone.
 *
 * It is drawn without a number when a store could not be read. This chip is the only way to reach
 * Recovery, so a failure that reported zero would hide the unsent work *and* the failure behind a
 * door nothing opens - and "none" is not what this phone knows in that moment.
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
  const unfinished = useUnfinishedTally();
  const notice = useSaveNotice();
  const [snackbarHeight, setSnackbarHeight] = useState(0);
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
            headingTrailing={
              // Drawn when there is something to say *or* when this phone could not find out, which
              // are different facts and only one of them is "nothing". A chip with no number is the
              // honest form of the second: Recovery is where what could not be read is named.
              unfinished.count === 0 && unfinished.complete ? undefined : (
                <Chip
                  accessibilityHint="Opens everything not yet on your server"
                  icon={CloudOff}
                  label={
                    unfinished.complete ? `${String(unfinished.count)} unfinished` : 'Unfinished'
                  }
                  onPress={openRecovery}
                  testID="home-unfinished-chip"
                />
              )
            }
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
