import { Text, View } from 'react-native';

import type { Resource } from '../../../infrastructure/api/contracts';
import { EmptyState, Screen, SectionError, SectionHeading, Chip } from '../../../ui';
import { CaptureBar } from '../../capture';
import { useActiveProjects, useProjectActive } from '../../collections';
import { openSearch, useSheetsStore, HomeTopBar } from '../../navigation';
import { ResourceGrid, type ResourceGridItem } from '../../resources';
import { useHomeFeed } from '../client/queries';
import { ActiveProjectCard } from './ActiveProjectCard';
import { ActiveSkeleton, NotesSkeleton } from './Skeletons';

/** Home captures into the inbox: nothing is chosen yet, so the note lands there. */
const HOME_TARGET = { type: 'home' } as const;

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

/** Home orients first: deliberately active projects together, then recent captures. */
export function HomeScreen() {
  const projects = useActiveProjects();
  const active = useProjectActive();
  const feed = useHomeFeed();
  const openBrowse = useSheetsStore((state) => state.openBrowse);
  const openNewNote = useSheetsStore((state) => state.openNewNote);
  const openVoiceCapture = useSheetsStore((state) => state.openVoiceCapture);

  return (
    <View className="flex-1">
      <Screen
        header={
          <HomeTopBar
            onBrowse={() => {
              openBrowse(null);
            }}
            onSearch={() => {
              openSearch(null);
            }}
          />
        }
      >
        <View className="gap-7">
          <View className="gap-3">
            <SectionHeading>Active projects</SectionHeading>
            {projects.isError ? (
              <SectionError
                onRetry={() => {
                  void projects.refetch();
                }}
                retrying={projects.isFetching}
                title="Active projects did not load."
              />
            ) : projects.data === undefined ? (
              <ActiveSkeleton />
            ) : projects.data.length === 0 ? (
              <View className="gap-3">
                <EmptyState
                  description="Open a project from Browse and mark it as Active to keep it here."
                  title="What deserves your attention?"
                />
                <Chip
                  label="Browse projects"
                  onPress={() => {
                    openBrowse(null);
                  }}
                />
              </View>
            ) : (
              projects.data.map((project) => (
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
            {active.isError && !projects.isError ? (
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
      <CaptureBar
        onNewNote={() => {
          openNewNote(HOME_TARGET);
        }}
        onVoice={() => {
          openVoiceCapture(HOME_TARGET);
        }}
      />
    </View>
  );
}
