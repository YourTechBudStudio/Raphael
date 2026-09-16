import { useCallback } from 'react';

import { openContainer, useSheetsStore } from '../../navigation';
import { NewContainerSheet } from './NewContainerSheet';

/**
 * The one mounted container sheet, at the root of the app.
 *
 * Mounted once rather than per screen so that opening it from Browse and from an area is the same
 * sheet with the same rules, and so the mutual exclusion the sheet store enforces is actually
 * enforceable.
 *
 * This host navigates on success, which is what the standalone entry points want. Capture's
 * create-here form does not come through here: it renders the same request session inside its own
 * destination sheet, because the person is choosing where a note goes and must not be carried off
 * to the new container instead.
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
      // Each opening is its own form and its own key. Kept mounted while closed so the sheet can
      // animate out, which is why the key matters: nothing from the last opening survives.
      key={session}
      onClose={close}
      onCreated={onCreated}
      parentAreaId={target?.parentAreaId ?? null}
      sessionId={session}
      visible={target !== null}
    />
  );
}
