/**
 * Temporary: archive mock for story #8. An Area or Project screen with Archive as a state toggle.
 *
 * The toggle row holds states only: Active, Favorite, Archive. Edit changes the content, so it sits
 * beside "About this …", which is the content it changes. Nothing moves when a container is
 * archived: Active, Favorite, Edit, the add button and the capture pair stay where they are and
 * become unavailable. Active and Favorite keep showing their saved value, because archiving clears
 * neither. Archive is filled while your own cause is there. An archive inherited from a container
 * above is said in one quiet line that opens that container.
 */

import { Archive, ChevronLeft, Layers, Pencil, Plus, Search } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import {
  ACTIVE_MARK,
  Chip,
  colors,
  emblemFor,
  Eyebrow,
  FAVORITE_MARK,
  IconButton,
  PressableFeedback,
  Screen,
  SectionHeading,
  ToggleLabel,
} from '../../../../ui';
import { CollectionTile } from '../../../collections';
import { NoteGrid } from '../../../resources';
import { CaptureBar } from '../CaptureBar';
import {
  ARCHIVE_MARK,
  AREA_NOTES,
  isArchived,
  type MockNode,
  type MockWorld,
  NODES,
  originName,
  PROJECT_NOTES,
} from './mock-state';

export interface ContainerMockProps {
  node: Exclude<MockNode, 'note'>;
  world: MockWorld;
  favorite: boolean;
  onFavorite: () => void;
  onBack: () => void;
  onOpen: (node: MockNode) => void;
  onSearch: () => void;
  /** Where the mock's pill and sheet go; drawn by the owner so every screen shares them. */
  controls: ReactNode;
}

const UNAVAILABLE = 'Unavailable while this is archived';

/** Drawn, spoken and pressed as unavailable, without the busy ring `ToggleLabel` uses for in-flight. */
function Unavailable({
  off,
  children,
  fill = false,
}: {
  off: boolean;
  children: ReactNode;
  fill?: boolean;
}) {
  if (!off) return <>{children}</>;
  return (
    <View
      accessibilityHint={UNAVAILABLE}
      accessibilityState={{ disabled: true }}
      pointerEvents="none"
      style={fill ? { position: 'absolute', inset: 0, opacity: 0.38 } : { opacity: 0.38 }}
    >
      {children}
    </View>
  );
}

export function ContainerMock({
  node,
  world,
  favorite,
  onFavorite,
  onBack,
  onOpen,
  onSearch,
  controls,
}: ContainerMockProps) {
  const { title, kind, parent } = NODES[node];
  const standing = world.standing(node);
  const archived = isArchived(standing);
  const busy = world.busy === node;
  const inherited = standing.origin;

  return (
    <View className="flex-1">
      <Screen
        header={
          <View className="h-14 flex-row items-center gap-2">
            <IconButton icon={ChevronLeft} label="Back" onPress={onBack} />
            <Chip
              icon={Layers}
              label={parent === null ? 'All areas' : NODES[parent].title}
              onPress={() => {
                if (parent !== null) onOpen(parent);
              }}
              style={{ flex: 1 }}
            />
            <IconButton icon={Search} label="Search" onPress={onSearch} />
            {kind === 'area' ? (
              <IconButton
                accessibilityHint={archived ? UNAVAILABLE : undefined}
                className="bg-primary-soft"
                disabled={archived}
                icon={Plus}
                label="Add"
              />
            ) : null}
          </View>
        }
      >
        <View>
          <Eyebrow>{kind === 'area' ? 'Area' : 'Project'}</Eyebrow>
          <Text
            accessibilityRole="header"
            className="mt-1 font-heading text-[28px] leading-[34px] text-ink"
            numberOfLines={2}
          >
            {title}
          </Text>
          <View className="mt-4 flex-row flex-wrap items-center gap-x-5 gap-y-1">
            {kind === 'project' ? (
              <Unavailable off={archived}>
                <ToggleLabel
                  accessibilityLabel={`Mark ${title} as active`}
                  label="Active"
                  mark={ACTIVE_MARK}
                  onToggle={() => {}}
                  selected
                />
              </Unavailable>
            ) : null}
            <Unavailable off={archived}>
              <ToggleLabel
                accessibilityLabel={
                  favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`
                }
                label="Favorite"
                mark={FAVORITE_MARK}
                onToggle={onFavorite}
                selected={favorite}
              />
            </Unavailable>
            <ToggleLabel
              accessibilityHint={
                standing.mine
                  ? 'Brings it back to lists and search'
                  : 'Hides it from lists and search. Nothing is deleted'
              }
              accessibilityLabel={standing.mine ? `Restore ${title}` : `Archive ${title}`}
              disabled={busy}
              label="Archive"
              mark={ARCHIVE_MARK}
              onToggle={() => {
                world.toggle(node);
              }}
              selected={standing.mine}
            />
          </View>

          {world.failed === node ? (
            <Text
              accessibilityLiveRegion="polite"
              className="mt-2 font-body text-[15px] leading-[22px] text-danger"
            >
              That did not stick. Tap Archive again.
            </Text>
          ) : null}

          {inherited === null ? null : (
            <PressableFeedback
              accessibilityHint={`Opens ${NODES[inherited].title}`}
              accessibilityLabel={`Archived with ${originName(inherited)}`}
              accessibilityRole="button"
              className="mt-2 min-h-11 flex-row items-center gap-2 self-start pr-2"
              onPress={() => {
                onOpen(inherited);
              }}
              treatment="button"
            >
              <Archive color={colors.inkSoft} size={16} strokeWidth={2} />
              <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
                {standing.mine ? 'Also archived with ' : 'Archived with '}
                <Text className="font-body-medium text-primary">{originName(inherited)}</Text>
              </Text>
            </PressableFeedback>
          )}
        </View>

        <View className="mt-7 gap-3">
          <View className="flex-row items-center">
            <View className="flex-1">
              <SectionHeading>{`About this ${kind}`}</SectionHeading>
            </View>
            <Unavailable off={archived}>
              <PressableFeedback
                accessibilityHint="Changes the title, description, body, ID and tags"
                accessibilityLabel={`Edit this ${kind}`}
                accessibilityRole="button"
                className="h-11 flex-row items-center gap-1 pl-2"
                treatment="button"
              >
                <Pencil color={colors.primary} size={18} strokeWidth={2} />
                <Text className="font-body-medium text-[16px] text-primary">Edit</Text>
              </PressableFeedback>
            </Unavailable>
          </View>
          {/* Backend has no prose, so the heading stays and says so: Edit must not vanish with it. */}
          {node === 'backend' ? (
            <Text className="font-body text-[16px] leading-[24px] text-ink-soft">
              Nothing written about this area yet.
            </Text>
          ) : (
            <Text className="font-body text-[16px] leading-[24px] text-ink">
              {kind === 'area'
                ? 'Everything that keeps the servers up, and the notes about why they went down.'
                : 'Move sessions to signed tokens and rotate the credential store.'}
            </Text>
          )}
        </View>

        {node === 'work' ? (
          <View className="mt-7 gap-3">
            <SectionHeading>Inside</SectionHeading>
            <CollectionTile
              emblem={emblemFor('area', 5)}
              name={NODES.backend.title}
              onPress={() => {
                onOpen('backend');
              }}
            />
            <CollectionTile
              emblem={emblemFor('project', 12)}
              name={NODES.project.title}
              onPress={() => {
                onOpen('project');
              }}
            />
          </View>
        ) : null}

        <View className="mt-7 gap-3">
          <SectionHeading>Notes</SectionHeading>
          <NoteGrid
            items={node === 'project' ? PROJECT_NOTES : node === 'backend' ? AREA_NOTES : []}
            onOpen={(id) => {
              if (id === 41) onOpen('note');
            }}
          />
        </View>
      </Screen>
      {/* The capture pair would file into this container, which the server refuses while it is
          archived, so it stays in place and is drawn unavailable rather than removed. */}
      {archived ? (
        <Unavailable fill off>
          <CaptureBar onNewNote={() => {}} onVoice={() => {}} />
        </Unavailable>
      ) : (
        <CaptureBar onNewNote={() => {}} onVoice={() => {}} />
      )}
      {controls}
    </View>
  );
}
