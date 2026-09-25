/**
 * Temporary: archive mock for story #8. The real edit screen shell over an invented note.
 *
 * The archive mark sits in the top bar after the status line. An archived note opens read-only in
 * the same layout: the fields stop accepting writing, Details still opens but changes nothing, and
 * the status line says why - including which container above it is archived.
 */

import { Tag } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Chip } from '../../../../ui';
import type { EditorSelectionState } from '../../../editor';
import { serverStatus } from '../../composer.ts';
import { detailsChip } from '../../edit-composer.ts';
import { ComposerShell, type ComposerEyebrow } from '../ComposerShell';
import { ArchiveMark } from './ArchiveMark';
import { isArchived, type MockWorld, NODES, originName } from './mock-state';
import { MockDetailsSheet } from './MockDetailsSheet';

const NO_SELECTION: EditorSelectionState = { active: [], available: [] };

const BODY = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Invented content. Rotate the key on staging first, then production, then revoke the old one after an hour.',
        },
      ],
    },
  ],
};

const DETAILS = detailsChip({
  nodeType: 'resource',
  kind: 'note',
  slug: 'credential-rotation-runbook',
  tagCount: 2,
});

const LOCATION = ['Work', 'Authentication rework'];

export interface NoteMockProps {
  world: MockWorld;
  onBack: () => void;
  controls: ReactNode;
}

export function NoteMock({ world, onBack, controls }: NoteMockProps) {
  const [title, setTitle] = useState(NODES.note.title);
  const [description, setDescription] = useState(
    'Steps for rotating the API key without downtime.',
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsSession, setDetailsSession] = useState(0);

  const standing = world.standing('note');
  const archived = isArchived(standing);
  const busy = world.busy === 'note';
  const failed = world.failed === 'note';
  const inherited = standing.origin;

  const label = LOCATION.join(' / ');
  const spoken = `Filed in ${LOCATION.join(', ')}`;
  // A note you archived yourself cannot move until it is restored, so its location is a label.
  const eyebrow: ComposerEyebrow = standing.mine
    ? { kind: 'label', label, spoken }
    : {
        kind: 'button',
        label,
        spoken,
        hint: 'Moves this somewhere else',
        disabled: false,
        onPress: () => {},
      };

  const status = busy
    ? { text: standing.mine ? 'Restoring…' : 'Archiving…', tone: 'quiet' as const }
    : failed
      ? { text: 'That did not stick. Tap Archive again.', tone: 'alert' as const }
      : !archived
        ? { text: serverStatus(4), tone: 'quiet' as const }
        : inherited !== null
          ? { text: `Archived with ${originName(inherited)} · read only`, tone: 'quiet' as const }
          : { text: 'Archived · read only', tone: 'quiet' as const };

  return (
    <View className="flex-1">
      <ComposerShell
        barLeading={
          <Chip
            accessibilityHint={
              archived ? 'Shows the ID and tags. Nothing can change while archived' : DETAILS.hint
            }
            accessibilityLabel={DETAILS.spoken}
            icon={Tag}
            label={DETAILS.label}
            onPress={() => {
              setDetailsSession((current) => current + 1);
              setDetailsOpen(true);
            }}
            style={{ flexShrink: 1 }}
          />
        }
        closeDisabled={false}
        description={description}
        document={BODY}
        documentId={`archive-mock:${archived ? 'read-only' : 'editable'}`}
        eyebrow={eyebrow}
        locked={archived}
        namespace="archive-mock"
        onClose={onBack}
        onCommand={() => {}}
        onDescriptionChange={setDescription}
        onSelectionChange={() => {}}
        onSnapshot={() => {}}
        onTitleChange={setTitle}
        selection={NO_SELECTION}
        status={status}
        statusTrailing={
          <ArchiveMark
            busy={busy}
            onToggle={() => {
              world.toggle('note');
            }}
            selected={standing.mine}
          />
        }
        title={title}
        titleLabel="Title"
        unprotected={false}
      />
      <MockDetailsSheet
        onClose={() => {
          setDetailsOpen(false);
        }}
        readOnly={archived}
        sessionId={detailsSession}
        visible={detailsOpen}
      />
      {controls}
    </View>
  );
}
