import type { MarkKind } from '../../../ui';
import { Screen } from '../../../ui';
import { goBack, openCapture, openEditor, TitleTopBar, useSheetsStore } from '../../navigation';
import { discardUnsent, titleFor, useUnfinished, type UnsentRow } from '../../unsent';
import { useDestinationName } from '../client/destinations.ts';
import type { UnfinishedStanding } from '../copy.ts';
import { UnfinishedList, type UnfinishedItem } from './UnfinishedList';

const standingOf = (row: UnsentRow): UnfinishedStanding => {
  if (row.status === 'pending') return 'waiting';

  return row.status;
};

const markOf = (row: UnsentRow): MarkKind => (row.nodeType === 'resource' ? 'note' : row.nodeType);

/** A mark needs a number to pick its tilt; a draft has no server id yet, so one comes from its own. */
const markIdOf = (row: UnsentRow): number =>
  row.nodeId ?? [...row.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);

/**
 * Unfinished: writing that has not reached the server and needs the person, or is stuck. Rows that
 * are syncing normally are not here. Opening a row is how to resolve it.
 */
export function UnfinishedScreen() {
  const rows = useUnfinished();
  const nameOf = useDestinationName();
  const openContainerDraft = useSheetsStore((state) => state.openContainerDraft);

  const placeOf = (row: UnsentRow): string | undefined => {
    if (row.destination === null) return undefined;
    if ('root' in row.destination) return 'Areas';

    return nameOf(row.destination).leaf ?? undefined;
  };

  const items = rows.map((row): UnfinishedItem => ({
    key: row.id,
    mark: { kind: markOf(row), id: markIdOf(row) },
    title: titleFor(row) ?? 'Untitled',
    standing: standingOf(row),
    detail: row.status === 'refused' ? (row.error ?? undefined) : placeOf(row),
  }));

  return (
    <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Unfinished" />}>
      <UnfinishedList
        items={items}
        onDiscard={(item) => {
          void discardUnsent(item.key);
        }}
        onOpen={(item) => {
          const row = rows.find((candidate) => candidate.id === item.key);

          if (row === undefined) return;
          if (row.op === 'edit' && row.nodeId !== null) openEditor(row.nodeId);
          else if (row.nodeType === 'resource') openCapture(row.id);
          else openContainerDraft(row.nodeType, row.id);
        }}
      />
    </Screen>
  );
}
