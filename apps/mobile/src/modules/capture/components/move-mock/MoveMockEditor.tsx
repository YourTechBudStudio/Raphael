/**
 * Temporary: move mock for story #7. The real edit screen shell, with the eyebrow as the move button.
 *
 * `ComposerShell` is the production component, unchanged: it already has the `button` eyebrow form
 * the new-note screen uses. Nothing here reaches an owner or a server; the body is a local document.
 */

import { Tag } from 'lucide-react-native';
import { useState } from 'react';

import { Chip } from '../../../../ui';
import type { EditorSelectionState } from '../../../editor';
import { goBack } from '../../../navigation';
import { serverStatus } from '../../composer.ts';
import { detailsChip } from '../../edit-composer.ts';
import { ComposerShell, type ComposerEyebrow } from '../ComposerShell';
import { MockMoveSheet } from './MockMoveSheet';
import { MOCK_NOTE, mockAncestors, mockNode } from './move-mock-data';

const NO_SELECTION: EditorSelectionState = { active: [], available: [] };

const BODY = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Invented content. Tap the eyebrow above the title to move this.' },
      ],
    },
  ],
};

const DETAILS = detailsChip({
  nodeType: 'resource',
  kind: 'note',
  slug: MOCK_NOTE.slug,
  tagCount: 2,
});

export function MoveMockEditor() {
  const [title, setTitle] = useState(MOCK_NOTE.title);
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState(MOCK_NOTE.parentId);
  const [revision, setRevision] = useState(4);
  const [moved, setMoved] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSession, setMoveSession] = useState(0);

  const location = mockAncestors(parentId).map((step) => step.title);
  const segments = location.length > 2 ? ['…', ...location.slice(-2)] : location;
  const eyebrow: ComposerEyebrow = {
    kind: 'button',
    label: segments.join(' / '),
    spoken: `Filed in ${location.join(', ')}`,
    hint: 'Moves this somewhere else',
    disabled: false,
    onPress: () => {
      setMoveSession((current) => current + 1);
      setMoveOpen(true);
    },
  };

  const status = moved
    ? `Moved to ${mockNode(parentId)?.title ?? ''} · revision ${String(revision)}`
    : serverStatus(revision);

  return (
    <>
      <ComposerShell
        barLeading={
          <Chip
            accessibilityHint={DETAILS.hint}
            accessibilityLabel={DETAILS.spoken}
            icon={Tag}
            label={DETAILS.label}
            style={{ flexShrink: 1 }}
          />
        }
        closeDisabled={false}
        description={description}
        document={BODY}
        documentId="move-mock"
        eyebrow={eyebrow}
        locked={false}
        namespace="move-mock"
        onClose={goBack}
        onCommand={() => {}}
        onDescriptionChange={setDescription}
        onSelectionChange={() => {}}
        onSnapshot={() => {}}
        onTitleChange={setTitle}
        selection={NO_SELECTION}
        status={{ text: status, tone: 'quiet' }}
        title={title}
        titleLabel="Title"
        unprotected={false}
      />
      <MockMoveSheet
        onClose={() => {
          setMoveOpen(false);
        }}
        onMoved={(next) => {
          setMoveOpen(false);
          setParentId(next);
          setRevision((current) => current + 1);
          setMoved(true);
        }}
        parentId={parentId}
        sessionId={moveSession}
        visible={moveOpen}
      />
    </>
  );
}
