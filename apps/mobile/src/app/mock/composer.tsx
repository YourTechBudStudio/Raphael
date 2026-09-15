import { router, useLocalSearchParams } from 'expo-router';

import { CaptureComposer, MockNoteUnavailable } from '../../modules/mock';
import { useMockStore } from '../../modules/mock';

/** THROWAWAY MOCK ROUTE. With `id` a saved note, with `draft` an unfinished one; else a new capture. */
export default function CaptureComposerRoute() {
  const { id, draft: draftId } = useLocalSearchParams<{ id?: string; draft?: string }>();
  const note = useMockStore((state) =>
    id === undefined ? undefined : state.notes.find((candidate) => candidate.id === Number(id)),
  );
  const draft = useMockStore((state) =>
    draftId === undefined
      ? undefined
      : state.drafts.find((candidate) => candidate.id === Number(draftId)),
  );

  const noteOpens = useMockStore((state) => state.noteOpens);

  if (note !== undefined && !noteOpens) {
    return (
      <MockNoteUnavailable
        onHome={() => {
          router.dismissTo('/');
        }}
        title={note.title}
      />
    );
  }

  return (
    <CaptureComposer
      draft={draft}
      note={note}
      onClose={() => {
        router.back();
      }}
      onSaved={() => {
        router.dismissTo('/');
      }}
    />
  );
}
