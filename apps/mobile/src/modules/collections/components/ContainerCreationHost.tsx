import { useCallback, useMemo } from 'react';

import { openContainer, useSheetsStore } from '../../navigation';
import { useAttemptViews, useCreationOwner } from '../client/creation';
import {
  correctionAllowed,
  emptyDraft,
  INCOMPLETE_RECOVERY_NOTICE,
  NewContainerSheet,
  recoverInput,
  recoveredDraft,
  SEPARATE_CREATION_NOTICE,
  type ContainerTarget,
  type Draft,
} from '../creation';

/**
 * The one mounted creation sheet, at the root of the app.
 *
 * Mounted once rather than per screen so that opening it from Browse, from an area, and from the
 * recovery list are the same sheet with the same draft rules - and so the mutual exclusion the
 * sheet store enforces is actually enforceable.
 *
 * Resuming is by durable attempt id, resolved here against the owner's records. A route that
 * carried the payload instead would be holding a copy of a record that is deliberately immutable,
 * and the copy is what would be stale.
 */
export function ContainerCreationHost() {
  const open = useSheetsStore((state) => state.open);
  const session = useSheetsStore((state) => state.session);
  const close = useSheetsStore((state) => state.close);
  const views = useAttemptViews();

  const resumed = useMemo(() => {
    if (open?.kind !== 'resume-container') return null;

    const record = views.find((view) => view.record.attemptId === open.attemptId)?.record;

    if (record === undefined) return null;

    const input = recoverInput(record.request, record.title);
    // A refusal is corrected under a new key and the old record is replaced, because it is known to
    // have created nothing. Anything else starts a separate creation and the earlier record stays
    // exactly where it is, so the evidence that something may exist is not thrown away by the act
    // of trying again.
    //
    // Replacement additionally requires that the input came back whole. A record this build could
    // only read leniently is the one record that must not be deleted on the way to a new one: the
    // part that did not come back would exist nowhere afterwards.
    const replaceable = correctionAllowed(record) && input.complete;
    const notice = input.complete
      ? replaceable
        ? null
        : SEPARATE_CREATION_NOTICE
      : INCOMPLETE_RECOVERY_NOTICE;

    return {
      target: { type: record.type, parentAreaId: record.parentAreaId } satisfies ContainerTarget,
      prefill: {
        draft: recoveredDraft(input, notice),
        ...(replaceable ? { replaces: record } : {}),
      },
    };
  }, [open, views]);

  const consume = useCreationOwner((state) => state.consume);

  const onCreated = useCallback(
    (container: { type: ContainerTarget['type']; id: number }, attemptId: string) => {
      close();
      openContainer(container);
      // The record has been shown, so it is spent. `consume` removes it only if its acknowledgement
      // was actually written - a success still held in memory keeps its row and its warning, and a
      // cleanup that fails leaves a row that can be dismissed by hand and is never resent.
      void consume(attemptId);
    },
    [close, consume],
  );

  if (open?.kind === 'new-container') {
    return (
      <NewContainerSheet
        key={session}
        onClose={close}
        onCreated={onCreated}
        target={{ type: open.containerType, parentAreaId: open.parentAreaId }}
        visible
      />
    );
  }

  if (open?.kind === 'resume-container' && resumed !== null) {
    return (
      <NewContainerSheet
        key={session}
        onClose={close}
        onCreated={onCreated}
        prefill={resumed.prefill}
        target={resumed.target}
        visible
      />
    );
  }

  // Kept mounted and invisible so the sheet can animate out; the key above gives each opening its
  // own form, so nothing from the last one survives into the next.
  return (
    <NewContainerSheet
      key={session}
      onClose={close}
      onCreated={onCreated}
      prefill={{ draft: emptyDraft() satisfies Draft }}
      target={{ type: 'area', parentAreaId: null }}
      visible={false}
    />
  );
}
