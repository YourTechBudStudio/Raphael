import { router } from 'expo-router';

import { SetupScreen, useConnectionStore } from '../../modules/connection';
import { MockUnfinishedNotes } from '../../modules/mock';
import { openMockDraft, openProject } from '../../modules/navigation';

/** THROWAWAY MOCK ROUTE. The setup screen as it looks with unfinished notes waiting. */
export default function MockSetupRoute() {
  const phase = useConnectionStore((state) => state.phase);
  const replacing = phase.kind === 'active' ? phase.session.connection : undefined;

  return (
    <SetupScreen
      footer={
        <MockUnfinishedNotes connected={false} onLookIn={openProject} onOpenDraft={openMockDraft} />
      }
      onCancel={() => {
        router.back();
      }}
      replacing={replacing}
    />
  );
}
