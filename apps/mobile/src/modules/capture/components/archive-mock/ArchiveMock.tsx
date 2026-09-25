/**
 * Temporary: archive mock for story #8. One route, one invented world, three kinds of screen.
 *
 * The screens share the world, so a round trip can be walked: archive Work, open the project inside
 * it, see how the inherited archive is explained, find the note again through Search, and restore.
 * Delete this folder, its export, its route, the Settings chip and the `ComposerShell` status slot.
 */

import { useState } from 'react';
import { Text, View } from 'react-native';

import { Chip, Screen, SectionHeading } from '../../../../ui';
import { goBack, TitleTopBar } from '../../../navigation';
import { ContainerMock } from './ContainerMock';
import { type MockNode, NODES, SCENARIOS, scenarioKey, useMockWorld } from './mock-state';
import { MockControls, type MockControlGroup } from './MockControls';
import { NoteMock } from './NoteMock';
import { SearchMock } from './SearchMock';

type View_ = { screen: 'node'; node: MockNode } | { screen: 'search' };

const NEXT_TAP = [
  { key: 'ok', label: 'Succeeds' },
  { key: 'fail', label: 'Fails' },
];

export function ArchiveMock() {
  const world = useMockWorld();
  const [stack, setStack] = useState<readonly View_[]>([]);
  const [favorites, setFavorites] = useState<Record<string, boolean>>({ project: true });

  const push = (next: View_) => {
    setStack((current) => [...current, next]);
  };
  const pop = () => {
    setStack((current) => current.slice(0, -1));
  };
  const open = (node: MockNode) => {
    push({ screen: 'node', node });
  };

  const scenarioGroup = (node: MockNode): MockControlGroup => ({
    title: `Standing of ${NODES[node].title}`,
    options: SCENARIOS.filter((s) => NODES[node].parent !== null || !s.life.parent),
    value: scenarioKey(world.standing(node)),
    onChange: (key) => {
      const scenario = SCENARIOS.find((s) => s.key === key);
      if (scenario !== undefined) world.force(node, scenario.life);
    },
  });
  const nextTapGroup: MockControlGroup = {
    title: 'Next Archive tap',
    options: NEXT_TAP,
    value: world.failNext ? 'fail' : 'ok',
    onChange: (key) => {
      world.setFailNext(key === 'fail');
    },
  };

  const top = stack.at(-1);

  if (top === undefined) {
    return (
      <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Archive mock" />}>
        <View className="gap-7 pt-2">
          <Text className="font-body text-[16px] leading-[24px] text-ink">
            Story #8, presentation only. The screens share one invented tree, so archiving Work
            archives everything inside it until Work is restored. Use the Mock pill on the area,
            project and note screens to jump to a standing or make the next save fail.
          </Text>
          <View className="gap-3">
            <SectionHeading>Open</SectionHeading>
            <View className="flex-row flex-wrap gap-2">
              <Chip
                label="Area: Work"
                onPress={() => {
                  open('work');
                }}
              />
              <Chip
                label="Area: Backend"
                onPress={() => {
                  open('backend');
                }}
              />
              <Chip
                label="Project: Authentication rework"
                onPress={() => {
                  open('project');
                }}
              />
              <Chip
                label="Note: Credential rotation runbook"
                onPress={() => {
                  open('note');
                }}
              />
              <Chip
                label="Search"
                onPress={() => {
                  push({ screen: 'search' });
                }}
              />
            </View>
          </View>
          <View className="gap-3">
            <SectionHeading>Try</SectionHeading>
            <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
              Archive Work, then open the project inside it. Archive the project too, then restore
              Work. Search for the note with and without “Include archived”.
            </Text>
          </View>
        </View>
      </Screen>
    );
  }

  if (top.screen === 'search') {
    return <SearchMock onBack={pop} onOpen={open} world={world} />;
  }

  const { node } = top;

  if (node === 'note') {
    return (
      <NoteMock
        controls={
          <MockControls
            bottom={84}
            groups={[scenarioGroup('note'), nextTapGroup]}
            note="Details still opens while the note is archived; nothing in it can change."
          />
        }
        onBack={pop}
        world={world}
      />
    );
  }

  return (
    <ContainerMock
      controls={
        <MockControls
          bottom={84}
          groups={[scenarioGroup(node), nextTapGroup]}
          note="Archive stays live while archived: with a container above, tapping it adds your own archive so this stays archived when that container comes back."
        />
      }
      favorite={favorites[node] === true}
      key={node}
      node={node}
      onBack={pop}
      onFavorite={() => {
        setFavorites((current) => ({ ...current, [node]: current[node] !== true }));
      }}
      onOpen={open}
      onSearch={() => {
        push({ screen: 'search' });
      }}
      world={world}
    />
  );
}
