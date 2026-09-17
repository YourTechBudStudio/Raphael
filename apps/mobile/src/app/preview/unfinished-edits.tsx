/**
 * TEMPORARY PREVIEW for story #4. Presentation only: no store, no owner, no server.
 *
 * Home's one indicator for unfinished work, and Recovery's cards for unfinished edits, as settled
 * in the program design (§5.8, §5.10). Delete before merge.
 */

import { CloudOff, Layers, Search, Settings } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { goBack, TitleTopBar } from '../../modules/navigation';
import { NoteCardShell } from '../../modules/resources';
import { Card, Chip, confirmDiscard, IconButton, Screen, SectionHeading } from '../../ui';

type Standing = 'conflicted' | 'refused' | 'unconfirmed' | 'offline' | 'pending' | 'unusable';
type Kind = 'note' | 'area' | 'project';

interface Row {
  readonly key: string;
  readonly kind: Kind;
  readonly title: string;
  readonly standing: Standing;
  readonly ago: string;
}

const KIND_WORD: Record<Kind, string> = { note: 'Note', area: 'Area', project: 'Project' };

const SENTENCE: Record<Standing, string> = {
  conflicted:
    'Your server holds a newer version. The changes you made here are kept and are not being sent.',
  refused: 'Your server refused the last change · that note ID is already used.',
  unconfirmed: 'The last change may or may not have reached your server. Open it to check.',
  offline: 'Changes made here have not reached your server yet.',
  pending: 'Changes made here have not reached your server yet.',
  unusable: 'This build cannot read what was saved here. Nothing has been removed.',
};

const isAlarming = (standing: Standing): boolean =>
  standing === 'conflicted' || standing === 'refused' || standing === 'unconfirmed';

const ROWS: readonly Row[] = [
  {
    key: 'e1',
    kind: 'note',
    title: 'Autosave loop notes',
    standing: 'conflicted',
    ago: '2 hours ago',
  },
  { key: 'e2', kind: 'project', title: 'Mobile', standing: 'refused', ago: 'yesterday' },
  {
    key: 'e3',
    kind: 'note',
    title: 'Weekly review',
    standing: 'unconfirmed',
    ago: '10 minutes ago',
  },
  { key: 'e4', kind: 'area', title: 'Raphael', standing: 'offline', ago: '3 minutes ago' },
  { key: 'e5', kind: 'note', title: '', standing: 'unusable', ago: '' },
];

const displayTitle = (title: string): string => (title === '' ? 'Untitled' : title);

function RecoveryCard({ row }: { row: Row }) {
  const alarming = isAlarming(row.standing);

  return (
    <Card className="gap-3 p-4">
      <View className="gap-1">
        <Text
          className={`font-body-medium text-[14px] ${alarming ? 'text-danger' : 'text-ink-soft'}`}
        >
          {KIND_WORD[row.kind]}
          {row.ago === '' ? '' : ` · ${row.ago}`}
        </Text>
        <Text
          accessibilityRole="header"
          className="font-heading text-[18px] leading-[24px] text-ink"
        >
          {displayTitle(row.title)}
        </Text>
      </View>
      <Text className="font-body text-[15px] leading-[22px] text-ink">
        {SENTENCE[row.standing]}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {row.standing === 'unusable' ? null : (
          <Chip
            accessibilityHint="Opens this in the editor"
            label="Open"
            onPress={() => undefined}
          />
        )}
        <Chip
          accessibilityHint="Removes the changes kept on this phone"
          label="Discard"
          onPress={() => {
            void confirmDiscard({
              title: 'Discard your changes?',
              message:
                'The changes kept on this phone will be removed. What is on your server stays as it is.',
              keepLabel: 'Keep them',
            });
          }}
        />
      </View>
    </Card>
  );
}

export default function UnfinishedEditsPreview() {
  const [surface, setSurface] = useState<'home' | 'recovery'>('home');
  const openRecovery = () => {
    setSurface('recovery');
  };

  const picker = (
    <View className="flex-row flex-wrap gap-2 pb-3">
      <Chip
        className="h-8 px-3"
        label="Home"
        onPress={() => {
          setSurface('home');
        }}
        selected={surface === 'home'}
      />
      <Chip
        className="h-8 px-3"
        label="Recovery"
        onPress={openRecovery}
        selected={surface === 'recovery'}
      />
    </View>
  );

  if (surface === 'recovery') {
    return (
      <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Unfinished" />}>
        {picker}
        <View className="gap-5">
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            Notes Raphael has not been able to finish, and results it has not shown you yet. Nothing
            here is removed on its own.
          </Text>
          <View className="gap-3">
            <SectionHeading>Edits not on your server</SectionHeading>
            {ROWS.map((row) => (
              <RecoveryCard key={row.key} row={row} />
            ))}
          </View>
        </View>
      </Screen>
    );
  }

  const homeTopBar = (
    <View className="h-14 flex-row items-center justify-between">
      <Text className="font-heading text-[34px] leading-[42px] text-ink" numberOfLines={1}>
        raphael
      </Text>
      <View className="flex-row items-center gap-2">
        <Chip icon={Layers} label="Browse" onPress={() => undefined} />
        <IconButton icon={Search} label="Search" onPress={() => undefined} />
        <IconButton icon={Settings} label="Settings" onPress={() => undefined} />
      </View>
    </View>
  );

  return (
    <Screen header={homeTopBar}>
      {picker}
      <View className="gap-3">
        <View className="flex-row items-center justify-between">
          <SectionHeading>Notes</SectionHeading>
          {/* Everything Recovery lists, drawn only when there is something to list. */}
          <Chip
            accessibilityHint="Opens everything not yet on your server"
            className="h-9 px-3"
            icon={CloudOff}
            label={`${String(ROWS.length)} unfinished`}
            onPress={openRecovery}
          />
        </View>
        <NoteCardShell
          accessibilityLabel="Raphael, Sync notes. Release checklist. Everything before a build goes out"
          description="Everything before a build goes out"
          eyebrow={
            <Text className="font-body-medium text-[14px] text-ink-soft" numberOfLines={1}>
              Raphael / Sync notes
            </Text>
          }
          onPress={() => undefined}
          title="Release checklist"
        />
        <NoteCardShell
          accessibilityLabel="Raphael, Mobile. Editor bridge. What the WebView tells native"
          description="What the WebView tells native"
          eyebrow={
            <Text className="font-body-medium text-[14px] text-ink-soft" numberOfLines={1}>
              Raphael / Mobile
            </Text>
          }
          onPress={() => undefined}
          title="Editor bridge"
        />
      </View>
    </Screen>
  );
}
