import { MockUnfinishedScreen } from '../../modules/mock';
import { openMockDraft, openProject } from '../../modules/navigation';

/** THROWAWAY MOCK ROUTE. */
export default function MockUnfinishedRoute() {
  return <MockUnfinishedScreen onLookIn={openProject} onOpenDraft={openMockDraft} />;
}
