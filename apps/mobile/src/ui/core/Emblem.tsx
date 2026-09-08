import { Layers } from 'lucide-react-native';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { colors } from '../theme';

/** The GitHub mark, drawn by hand: lucide does not ship brand marks. */
const GITHUB_MARK_PATH =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z';

export interface GithubMarkProps {
  size?: number | undefined;
  color?: string | undefined;
}

/** The bare GitHub mark, for badges and inline labels. */
export function GithubMark({ size = 20, color = colors.primary }: GithubMarkProps) {
  return (
    <Svg height={size} viewBox="0 0 16 16" width={size}>
      <Path d={GITHUB_MARK_PATH} fill={color} />
    </Svg>
  );
}

export type EmblemName = 'petals' | 'arch' | 'layers' | 'github';

export interface EmblemProps {
  name: EmblemName;
  size?: number | undefined;
  /** Set false for the bare `layers` mark, with no pale tile behind it, as in the Browse tree. */
  background?: boolean | undefined;
}

/**
 * The small lilac forms that stand in for collections: `petals` and `arch` for projects,
 * `layers` for areas, `github` for a repository. Decorative only, so it carries no
 * accessibility label; the row around it supplies the name.
 */
export function Emblem({ name, size = 40, background = true }: EmblemProps) {
  if (name === 'layers') {
    if (!background) {
      return <Layers color={colors.primary} size={size} strokeWidth={1.9} />;
    }

    return (
      <View
        className="items-center justify-center rounded-tile bg-primary-soft"
        style={{ height: size, width: size }}
      >
        <Layers color={colors.primary} size={Math.round(size * 0.52)} strokeWidth={1.9} />
      </View>
    );
  }

  if (name === 'github') {
    return (
      <Svg height={size} viewBox="0 0 16 16" width={size}>
        <Circle cx={8} cy={8} fill={colors.ink} r={8} />
        <Path
          d={GITHUB_MARK_PATH}
          fill={colors.onPrimary}
          transform="translate(2.4 2.4) scale(0.7)"
        />
      </Svg>
    );
  }

  if (name === 'arch') {
    return (
      <Svg height={size} viewBox="0 0 48 48" width={size}>
        <Path d="M10 40 L10 24 A14 14 0 0 1 38 24 L38 40 Z" fill={colors.lilac} />
        <Path d="M16 40 L16 24 A8 8 0 0 1 32 24 L32 40 Z" fill={colors.peachDeep} />
      </Svg>
    );
  }

  return (
    <Svg height={size} viewBox="0 0 48 48" width={size}>
      <Circle cx={17} cy={17} fill={colors.lilac} r={9.5} />
      <Circle cx={31} cy={17} fill={colors.lilac} r={9.5} />
      <Circle cx={17} cy={31} fill={colors.lilac} r={9.5} />
      <Circle cx={31} cy={31} fill={colors.lilac} r={9.5} />
      <Circle cx={24} cy={24} fill={colors.lilacDeep} r={4} />
    </Svg>
  );
}
