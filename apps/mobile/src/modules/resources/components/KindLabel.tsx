import { Text, View } from 'react-native';

import type { ResourceKind } from '../../../infrastructure/api/contracts';
import { KindBadge } from './KindBadge';

const KIND_LABELS: Record<ResourceKind, string> = {
  note: 'Note',
  voice: 'Voice',
  image: 'Image',
  github: 'GitHub',
};

export interface KindLabelProps {
  kind: ResourceKind;
  /** Badge size in logical pixels. */
  size?: number | undefined;
  /** Set false for a bare icon next to the label, as the image and note cards use. */
  background?: boolean | undefined;
  className?: string | undefined;
}

/** The kind icon and its word, the pair that opens every resource card. */
export function KindLabel({ kind, size = 32, background = true, className }: KindLabelProps) {
  return (
    <View className={['flex-row items-center gap-2', className ?? ''].join(' ')}>
      <KindBadge background={background} kind={kind} size={size} />
      <Text className="font-body-medium text-[15px] text-primary">{KIND_LABELS[kind]}</Text>
    </View>
  );
}
