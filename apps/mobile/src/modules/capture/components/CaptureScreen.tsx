import { useEffect, useRef, useState } from 'react';
import { BackHandler, Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { PrimaryButton } from '../../../ui';
import type { EditorPort, EditorSelectionState } from '../../editor';
import { goBack, openHome } from '../../navigation';
import {
  announce,
  createProblem,
  leaveDraft,
  saveDraft,
  useUnsentRow,
  writeDraft,
  type UnsentRow,
} from '../../unsent';
import { useDestinationName } from '../client/destinations.ts';
import { useRowWriting } from '../client/writing.ts';
import {
  KEPT_DRAFT_NOTICE,
  KEPT_RETRYING_NOTICE,
  NOT_KEPT_STATUS,
  createStatus,
  destinationEyebrow,
  detailsChip,
  saveLabel,
  savedIn,
  type CreateStanding,
} from '../copy.ts';
import { CaptureView } from './CaptureView';
import { DestinationSheet } from './DestinationSheet';
import { DetailsSheet } from './DetailsSheet';

/** How long Save waits for the server before saying it will keep trying. */
const SAVE_WAIT_MS = 10_000;

export interface CaptureScreenProps {
  draftId: string;
}

const placeOf = (row: UnsentRow): ContainerRef | null =>
  row.destination === null || 'root' in row.destination ? null : row.destination;

/** The composer over one `unsent` create row. */
export function CaptureScreen({ draftId }: CaptureScreenProps) {
  const row = useUnsentRow(draftId);
  const nameOf = useDestinationName();
  const last = useRef<UnsentRow | null>(null);
  const draft = row !== undefined && row.op === 'create' ? row : null;

  // A pending row goes (or becomes an edit of what it created) when the server has it: this is where
  // a save that landed, even in the background while the composer stayed open, closes it.
  useEffect(() => {
    const before = last.current;

    last.current = draft;
    if (draft !== null || before?.status !== 'pending') return;

    const place = placeOf(before);

    announce(savedIn(place === null ? null : nameOf(place).leaf));
    goBack();
  }, [draft, nameOf]);

  if (draft === null) return last.current === null ? <Missing /> : null;

  return <Composer key={draftId} row={draft} />;
}

function Missing() {
  return (
    <View className="flex-1 justify-center gap-4 bg-canvas px-6">
      <Text accessibilityRole="header" className="font-heading text-[24px] leading-[30px] text-ink">
        That note is no longer on this phone.
      </Text>
      <PrimaryButton label="Back to Home" onPress={openHome} />
    </View>
  );
}

function Composer({ row }: { row: UnsentRow }) {
  const id = row.id;
  const nameOf = useDestinationName();
  const port = useRef<EditorPort>(null);
  const [title, setTitle] = useState(row.title);
  const [description, setDescription] = useState(row.description);
  // What the sheets committed is shown from here and flushed with the fields, so a sheet's write that
  // did not land is written again before Save or Close rather than lost.
  const [tags, setTags] = useState(row.tags);
  const [chosen, setChosen] = useState(row.destination);
  const writing = useRowWriting(
    (patch) => writeDraft(id, patch),
    port,
    () => ({ title, description, tags, destination: chosen }),
  );
  const [document] = useState<unknown>(() => row.body);
  const [selection, setSelection] = useState<EditorSelectionState>({ active: [], available: [] });
  const [saving, setSaving] = useState(false);
  const [unwritable, setUnwritable] = useState(false);
  const [sheet, setSheet] = useState<'destination' | 'details' | null>(null);
  const [sheetSession, setSheetSession] = useState(0);
  const leaving = useRef(false);

  const shown = { ...row, title, description, tags, destination: chosen };
  const destination = placeOf(shown);
  const name = nameOf(destination);

  const standing: CreateStanding = saving
    ? { kind: 'saving' }
    : row.status === 'refused'
      ? { kind: 'refused', message: row.error ?? '' }
      : row.status === 'pending'
        ? { kind: 'retrying' }
        : { kind: 'draft', problem: createProblem(shown) };
  const problem = createProblem(shown);

  const save = () => {
    if (saving || leaving.current) return;
    setSaving(true);

    void (async () => {
      // What is on screen is what gets saved, so it has to be on this phone first.
      if (!(await writing.flush())) {
        setSaving(false);

        return;
      }

      const result = await Promise.race([
        saveDraft(id),
        new Promise<null>((done) => setTimeout(() => done(null), SAVE_WAIT_MS)),
      ]);

      // A save that landed closes the composer through `CaptureScreen`, which watches the row.
      setSaving(false);
      setUnwritable(result?.kind === 'unwritable');
    })();
  };

  const close = () => {
    if (saving || leaving.current) return;
    leaving.current = true;

    void (async () => {
      // Writing that did not reach this phone stays on screen, with the status saying so.
      if (!(await writing.flush())) {
        leaving.current = false;

        return;
      }

      if (await leaveDraft(id)) {
        announce(row.status === 'pending' ? KEPT_RETRYING_NOTICE : KEPT_DRAFT_NOTICE);
      }
      goBack();
    })();
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();

      return true;
    });

    return () => {
      subscription.remove();
    };
  });

  // A swipe back skips `close`; an empty draft still should not be kept.
  useEffect(
    () => () => {
      void leaveDraft(id);
    },
    [id],
  );

  const openSheet = (which: 'destination' | 'details') => {
    setSheetSession((value) => value + 1);
    setSheet(which);
  };

  const closeSheet = () => {
    setSheet(null);
  };

  return (
    <>
      <CaptureView
        action={{
          label: saveLabel(standing),
          enabled: !saving && (problem === null || standing.kind === 'retrying'),
        }}
        description={description}
        destination={destinationEyebrow(name)}
        details={detailsChip({
          nodeType: 'resource',
          kind: 'note',
          slug: null,
          tagCount: tags.length,
        })}
        document={document}
        documentId={id}
        editorRef={port}
        onClose={close}
        onCommand={(command) => {
          port.current?.send(command);
        }}
        onDescriptionChange={(value) => {
          setDescription(value);
          writing.write({ description: value });
        }}
        onDestination={() => {
          openSheet('destination');
        }}
        onDetails={() => {
          openSheet('details');
        }}
        onSave={save}
        onSelectionChange={setSelection}
        onSnapshot={writing.onSnapshot}
        onTitleChange={(value) => {
          setTitle(value);
          writing.write({ title: value });
        }}
        saving={saving}
        selection={selection}
        status={writing.failed || unwritable ? NOT_KEPT_STATUS : createStatus(standing)}
        testID="capture-screen"
        title={title}
      />

      <DestinationSheet
        onClose={closeSheet}
        onSelect={(place) => {
          setChosen(place);
          writing.write({ destination: place });
          closeSheet();
        }}
        selected={destination}
        sessionId={sheetSession}
        visible={sheet === 'destination'}
      />

      <DetailsSheet
        idLabel="note ID"
        onClose={closeSheet}
        onDone={(details) => {
          setTags(details.tags);
          writing.write({ tags: details.tags });
          closeSheet();
        }}
        sessionId={sheetSession}
        slug={null}
        tags={tags}
        visible={sheet === 'details'}
      />
    </>
  );
}
