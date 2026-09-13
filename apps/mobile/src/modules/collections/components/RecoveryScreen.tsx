import { Text } from 'react-native';

import { Screen } from '../../../ui';
import {
  goBack,
  openBrowse,
  openContainer,
  openArea,
  TitleTopBar,
  useSheetsStore,
} from '../../navigation';
import { PendingAttempts } from '../creation';

/**
 * Everything unfinished, with a connection.
 *
 * A thin host: the list itself carries no router dependency so the setup screen can show it too, and
 * this is where the actions that need somewhere to go get supplied. Navigating from an attempt is
 * only offered here because only here is there a connection whose ids mean anything.
 */
export function RecoveryScreen() {
  const resume = useSheetsStore((state) => state.resumeContainer);

  return (
    <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Unfinished" />}>
      <Text className="mb-5 font-body text-[15px] leading-[22px] text-ink-soft">
        Creations Raphael has not been able to finish, and results it has not shown you yet. Nothing
        here is removed on its own.
      </Text>
      <PendingAttempts
        actions={{
          openCreated: (record) => {
            const created = record.acknowledged;

            if (created !== null) openContainer({ type: created.type, id: created.id });
          },
          openDestination: (record) => {
            // The root is not a container, so an attempt aimed at it opens Browse instead of
            // pretending there is a screen for the place areas live.
            if (record.parentAreaId === null) openBrowse();
            else openArea(record.parentAreaId);
          },
          recoverInput: (record) => {
            resume(record.attemptId);
          },
        }}
        heading={null}
      />
    </Screen>
  );
}
