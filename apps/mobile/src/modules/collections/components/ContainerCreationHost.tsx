import { useCallback } from 'react';

import { openContainer, useSheetsStore } from '../../navigation';
import { NewContainerSheet } from './NewContainerSheet';

/**
 * The one mounted container sheet, at the root of the app, so every entry point gets the same sheet
 * and the sheet store's one-at-a-time rule holds. It opens what it created.
 */
export function ContainerCreationHost() {
  const open = useSheetsStore((state) => state.open);
  const session = useSheetsStore((state) => state.session);
  const close = useSheetsStore((state) => state.close);

  const onCreated = useCallback(
    (container: Parameters<typeof openContainer>[0]) => {
      close();
      openContainer(container);
    },
    [close],
  );

  const target = open?.kind === 'new-container' ? open : null;

  return (
    <NewContainerSheet
      containerType={target?.containerType ?? 'area'}
      draftId={target?.draftId ?? null}
      // Each opening is its own form and its own draft. Kept mounted while closed so the sheet can
      // animate out.
      key={session}
      onClose={close}
      onCreated={onCreated}
      parentAreaId={target?.parentAreaId ?? null}
      visible={target !== null}
    />
  );
}
