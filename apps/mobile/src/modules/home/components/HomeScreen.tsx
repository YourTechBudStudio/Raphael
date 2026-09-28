import { CloudOff } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Chip, Screen, SectionHeading, Snackbar, SNACKBAR_GAP } from '../../../ui';
import { CaptureDock } from '../../capture';
import {
  activeProjects,
  containerTitleLookup,
  HierarchyStale,
  useHierarchy,
} from '../../collections';
import { RejectionNotice } from '../../connection';
import {
  openBrowse,
  openEditor,
  openUnfinished,
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
import { useNotice, useUnfinished } from '../../unsent';
import { ActiveProjectCard } from './ActiveProjectCard';
import { ActiveSkeleton } from './Skeletons';

/**
 * Home orients first: deliberately active projects together, then every note on the server.
 *
 * Which projects are active is the server's own answer, and it arrives on the one hierarchy
 * traversal this app already performs - so the section costs no extra request and cannot disagree
 * with the tree Home draws from. It does depend on that traversal landing, and reports the
 * dependency honestly rather than showing an empty list when the server could not be reached.
 *
 * Each card holds its own toggle and its own verdict. Home neither writes the selection nor hears
 * about a write, which is why there is no section-level sentence about one any more.
 *
 * The Notes feed is the server's, newest edit first, paged as the scroll reaches its end. Nothing
 * local is mixed into it and nothing is sorted here.
 *
 * What is local is counted instead of drawn: one chip beside the Notes heading says how many things
 * in Unfinished need the person, and opens it. It is absent at zero. A sentence about what happened
 * to someone's writing - saved, or kept in Unfinished - is shown here once, by a snackbar.
 */
export function HomeScreen() {
  const tree = useHierarchy();
  const feed = useNoteFeed();
  const media = useSessionMedia();
  const unfinished = useUnfinished().length;
  const notice = useNotice();
  const [snackbarHeight, setSnackbarHeight] = useState(0);
  const hierarchy = tree.hierarchy;
  const projects = hierarchy === undefined ? undefined : activeProjects(hierarchy);
  const projectsFailed = tree.isError && hierarchy === undefined;

  return (
    <View className="flex-1">
      <Screen
        onEndReached={feed.loadMore}
        // Pull down reloads everything Home shows: the hierarchy the project cards are named and
        // selected from, and the notes - the notes from their first page, not by re-reading every
        // page that happens to be held. It is not a way to confirm a save; Retry is.
        onRefresh={() => {
          tree.refetch();
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
            {/* The hierarchy decides which cards exist, what each bolt shows, and the revision a
                write from a card is guarded by - not just their names. So a stale hierarchy is a
                stale section, which is why a card can briefly outlive a successful deactivate whose
                refresh then failed. */}
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
              projects.map((project) => <ActiveProjectCard key={project.id} project={project} />)
            )}
          </View>

          <NoteSection
            copy={HOME_NOTES_COPY}
            headingTrailing={
              unfinished === 0 ? undefined : (
                <Chip
                  accessibilityHint="Opens everything not yet on your server"
                  icon={CloudOff}
                  label={`${String(unfinished)} unfinished`}
                  onPress={openUnfinished}
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
        testID="home-snackbar"
      />
    </View>
  );
}
