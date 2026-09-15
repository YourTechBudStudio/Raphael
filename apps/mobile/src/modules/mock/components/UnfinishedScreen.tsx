/**
 * THROWAWAY MOCK. Every note with no confirmed copy on the server. Areas and projects are not
 * here: creating one is a plain request that either lands or is refused in its sheet. Reachable
 * without a connection in the real app; the mock only draws it.
 */

import { CircleAlert, CircleHelp, PenLine } from 'lucide-react-native';
import { Text, View } from 'react-native';

import {
  Card,
  Chip,
  colors,
  confirmDiscard,
  PrimaryButton,
  Screen,
  SectionHeading,
} from '../../../ui';
import { goBack, TitleTopBar } from '../../navigation';
import type { MockDraft } from '../data';
import { useMockStore } from '../state';

export interface UnfinishedNotesProps {
  /** False on the setup screen: nothing can be sent, and every server is "another server". */
  connected: boolean;
  onOpenDraft: (id: number) => void;
  onLookIn: (destinationId: number) => void;
}

/** The notes list alone, for the screen and for the setup screen's footer. */
export function MockUnfinishedNotes({ connected, onOpenDraft, onLookIn }: UnfinishedNotesProps) {
  const drafts = useMockStore((state) => state.drafts);
  const here = connected ? drafts.filter((draft) => draft.endpoint === undefined) : [];
  const elsewhere = connected ? drafts.filter((draft) => draft.endpoint !== undefined) : drafts;

  return (
    <View className="gap-8">
      {connected ? (
        <View className="gap-3">
          <SectionHeading>Notes</SectionHeading>
          {here.length === 0 ? (
            <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
              Every note is on your server.
            </Text>
          ) : (
            here.map((draft) => (
              <UnfinishedNote
                connected
                draft={draft}
                key={draft.id}
                onLookIn={onLookIn}
                onOpen={onOpenDraft}
              />
            ))
          )}
        </View>
      ) : null}
      {elsewhere.length === 0 ? null : (
        <View className="gap-3">
          <SectionHeading>{connected ? 'From another server' : 'Unfinished notes'}</SectionHeading>
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            {connected
              ? 'Written for a server this phone is no longer connected to. Connect to it to send them again, or copy the writing into a note here.'
              : 'Kept on this phone. Nothing can be sent until this phone has a server; reading, copying, and discarding need none.'}
          </Text>
          {elsewhere.map((draft) => (
            <UnfinishedNote
              connected={false}
              draft={draft}
              key={draft.id}
              onLookIn={onLookIn}
              onOpen={onOpenDraft}
            />
          ))}
        </View>
      )}
    </View>
  );
}

export interface UnfinishedScreenProps {
  onOpenDraft: (id: number) => void;
  onLookIn: (destinationId: number) => void;
}

export function MockUnfinishedScreen({ onOpenDraft, onLookIn }: UnfinishedScreenProps) {
  return (
    <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Unfinished" />}>
      <Text className="mb-5 font-body text-[15px] leading-[22px] text-ink-soft">
        Writing that has no confirmed copy on your server. Nothing here is removed on its own.
      </Text>
      <MockUnfinishedNotes connected onLookIn={onLookIn} onOpenDraft={onOpenDraft} />
    </Screen>
  );
}

const EYEBROW = {
  draft: { icon: PenLine, label: 'Draft', color: colors.inkSoft, text: 'text-ink-soft' },
  unconfirmed: {
    icon: CircleHelp,
    label: 'Save not confirmed',
    color: colors.danger,
    text: 'text-danger',
  },
  refused: { icon: CircleAlert, label: 'Not saved', color: colors.danger, text: 'text-danger' },
} as const;

const explain = (draft: MockDraft): string => {
  const where = draft.destination === null ? 'nowhere yet' : draft.destination.title;

  switch (draft.kind) {
    case 'unconfirmed':
      return `Sent to ${where}, but no answer came back. Trying again sends exactly the same request, so it cannot make a second copy.`;
    case 'refused':
      return `Your server refused this: ${draft.reason ?? 'no reason was given.'} Nothing was created, and everything you wrote is still here.`;
    case 'draft':
      return draft.destination === null
        ? 'Kept on this phone. It has no home yet.'
        : `Kept on this phone, filed under ${where} once it is saved.`;
  }
};

function UnfinishedNote({
  connected,
  draft,
  onOpen,
  onLookIn,
}: {
  connected: boolean;
  draft: MockDraft;
  onOpen: (id: number) => void;
  onLookIn: (destinationId: number) => void;
}) {
  const retry = useMockStore((state) => state.retryDraft);
  const discard = useMockStore((state) => state.discardDraft);
  const eyebrow = EYEBROW[draft.kind];
  const Icon = eyebrow.icon;
  const untitled = draft.title === '';

  return (
    <Card className="gap-3 p-4">
      <View className="flex-row items-center gap-1.5">
        <Icon color={eyebrow.color} size={16} strokeWidth={2} />
        <Text className={`flex-1 font-body-medium text-[14px] ${eyebrow.text}`} numberOfLines={1}>
          {eyebrow.label} · {draft.when}
          {draft.endpoint === undefined ? '' : ` · ${draft.endpoint}`}
        </Text>
      </View>
      <Text
        accessibilityRole="header"
        className={`font-heading text-[18px] leading-[24px] ${untitled ? 'text-ink-soft' : 'text-ink'}`}
        numberOfLines={2}
      >
        {untitled ? 'Untitled note' : draft.title}
      </Text>
      <Text className="font-body text-[15px] leading-[22px] text-ink">{explain(draft)}</Text>

      {draft.kind === 'unconfirmed' && connected ? (
        <PrimaryButton
          label="Try the same save again"
          onPress={() => {
            retry(draft.id);
          }}
        />
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {draft.kind === 'unconfirmed' && draft.destination !== null && connected ? (
          <Chip
            accessibilityHint="Opens where this was going, without creating anything"
            label={`Look in ${draft.destination.title}`}
            onPress={() => {
              onLookIn(draft.destination?.id ?? 0);
            }}
          />
        ) : null}
        <Chip
          accessibilityHint={
            draft.kind === 'unconfirmed'
              ? 'Starts a separate note with this writing'
              : 'Opens this note in the editor'
          }
          label={draft.kind === 'unconfirmed' || !connected ? 'Copy into a new note' : 'Open'}
          onPress={() => {
            onOpen(draft.id);
          }}
        />
        <Chip
          accessibilityHint="Removes this writing from the phone"
          label="Discard"
          onPress={() => {
            void confirmDiscard({
              title: 'Discard this note?',
              message:
                draft.kind === 'unconfirmed'
                  ? 'This removes the writing from this phone. It cannot undo a note the server may already have made.'
                  : 'It exists only on this phone. What you wrote will be removed.',
              keepLabel: 'Keep it',
            }).then((yes) => {
              if (yes) discard(draft.id);
            });
          }}
        />
      </View>
    </Card>
  );
}
