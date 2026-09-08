import { FileText, Image as ImageIcon, Mic } from 'lucide-react-native';
import { View } from 'react-native';

import type { ResourceKind } from '../../../infrastructure/api/contracts';
import { colors, GithubMark } from '../../../ui';

export interface KindBadgeProps {
  kind: ResourceKind;
  size?: number | undefined;
  /** Set false for the bare icon, with no pale square behind it. */
  background?: boolean | undefined;
  color?: string | undefined;
}

/** The resource-kind icon, on a soft square badge by default. */
export function KindBadge({
  kind,
  size = 34,
  background = true,
  color = colors.primary,
}: KindBadgeProps) {
  const iconSize = background ? Math.round(size * 0.56) : size;
  const icon =
    kind === 'github' ? (
      <GithubMark color={color} size={iconSize} />
    ) : kind === 'voice' ? (
      <Mic color={color} size={iconSize} strokeWidth={1.9} />
    ) : kind === 'image' ? (
      <ImageIcon color={color} size={iconSize} strokeWidth={1.9} />
    ) : (
      <FileText color={color} size={iconSize} strokeWidth={1.9} />
    );

  if (!background) {
    return icon;
  }

  return (
    <View
      className="items-center justify-center rounded-tile bg-primary-soft"
      style={{ height: size, width: size }}
    >
      {icon}
    </View>
  );
}
