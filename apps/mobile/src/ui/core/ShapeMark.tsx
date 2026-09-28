import { FileText, Layers } from 'lucide-react-native';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors } from '../theme';
import { Emblem } from './Emblem';
import { emblemFor } from './emblem-for';
import { lobedPath } from './lobed-path';

/** What a mark can stand for. A note is the one resource kind the app draws. */
export type MarkKind = 'area' | 'project' | 'note';

export interface ShapeMarkProps {
  kind: MarkKind;
  /** The node's id. It picks the tilt, and a project's emblem, so one node always looks the same. */
  id: number;
  /** The box the shape fills, in points. A list row's is 54. */
  size?: number | undefined;
}

/** A small, stable tilt from the id, in degrees: the same node always leans the same way. */
const tiltFor = (id: number) => ((id * 37) % 30) - 15;

/**
 * The kind mark on an M3 Expressive shape.
 *
 * Areas sit on a scalloped cookie, projects on a four-leaf clover, notes on a warm soft square. The
 * shape says the kind before the word does, and each mark is turned by a small angle derived from
 * its id, so a list of them reads as a scattered handful rather than a stamped column. A note's
 * square turns half as far, because a square leans visibly where a round shape barely does.
 *
 * Decorative and static at rest. It carries no accessibility label: the row it sits in names the
 * title and the kind, and a second voice would repeat them.
 */
export function ShapeMark({ kind, id, size = 54 }: ShapeMarkProps) {
  const tilt = tiltFor(id);
  const icon =
    kind === 'area' ? (
      <Layers color={colors.primary} size={Math.round(size * 0.44)} strokeWidth={1.9} />
    ) : kind === 'project' ? (
      <Emblem name={emblemFor('project', id)} size={Math.round(size * 0.56)} />
    ) : (
      <FileText color={colors.primary} size={Math.round(size * 0.42)} strokeWidth={1.9} />
    );

  return (
    <View
      accessibilityElementsHidden
      className="items-center justify-center"
      importantForAccessibility="no-hide-descendants"
      style={{ height: size, width: size }}
      testID="shape-mark"
    >
      {kind === 'note' ? (
        <View
          className="absolute inset-0 rounded-[14px] border border-peach bg-card-warm"
          style={{ transform: [{ rotate: `${String(tilt / 2)}deg` }] }}
        />
      ) : (
        <View
          className="absolute inset-0"
          style={{ transform: [{ rotate: `${String(tilt)}deg` }] }}
        >
          <Svg height={size} width={size}>
            <Path
              d={kind === 'area' ? lobedPath(size, 9, 0.07) : lobedPath(size, 4, 0.11)}
              fill={kind === 'area' ? colors.wave : colors.primarySoft}
            />
          </Svg>
        </View>
      )}
      {icon}
    </View>
  );
}
