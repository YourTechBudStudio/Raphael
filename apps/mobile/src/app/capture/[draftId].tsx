import { useLocalSearchParams } from 'expo-router';

import { CaptureScreen } from '../../modules/capture';

export default function Capture() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();

  return <CaptureScreen draftId={draftId} />;
}
