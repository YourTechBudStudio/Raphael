/**
 * Temporary: favorites mock for story #14. The kind mark on an M3 Expressive shape.
 *
 * Areas sit on a scalloped cookie, projects on a four-leaf clover, notes on a soft square. The shape
 * says the kind before the word does, and each item is turned by a small angle derived from its id,
 * so a list of them reads as a scattered handful rather than a stamped column. Static at rest.
 */

import { FileText, Layers } from 'lucide-react-native';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors, Emblem } from '../../../../ui';
import { projectEmblem, type MockItem } from './mock-data';

/** A closed, smooth outline whose radius swells `lobes` times around the circle. */
function lobedPath(size: number, lobes: number, depth: number): string {
  const centre = size / 2;
  const base = centre / (1 + depth);
  const steps = 120;
  const points: string[] = [];

  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    const radius = base * (1 + depth * Math.cos(lobes * angle));
    const x = centre + radius * Math.cos(angle);
    const y = centre + radius * Math.sin(angle);
    points.push(`${step === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }

  return `${points.join(' ')} Z`;
}

/** A small, stable tilt from the id: the same item always leans the same way. */
const tilt = (id: number) => ((id * 37) % 30) - 15;

export interface ShapeMarkProps {
  item: MockItem;
  size: number;
}

export function ShapeMark({ item, size }: ShapeMarkProps) {
  const shape =
    item.kind === 'area'
      ? { fill: colors.wave, path: lobedPath(size, 9, 0.07) }
      : item.kind === 'project'
        ? { fill: colors.primarySoft, path: lobedPath(size, 4, 0.11) }
        : null;
  const icon =
    item.kind === 'area' ? (
      <Layers color={colors.primary} size={Math.round(size * 0.44)} strokeWidth={1.9} />
    ) : item.kind === 'project' ? (
      <Emblem name={projectEmblem(item)} size={Math.round(size * 0.56)} />
    ) : (
      <FileText color={colors.primary} size={Math.round(size * 0.42)} strokeWidth={1.9} />
    );

  return (
    <View className="items-center justify-center" style={{ height: size, width: size }}>
      {shape === null ? (
        <View
          className="absolute inset-0 rounded-[14px] border border-peach bg-card-warm"
          style={{ transform: [{ rotate: `${String(tilt(item.id) / 2)}deg` }] }}
        />
      ) : (
        <View
          className="absolute inset-0"
          style={{ transform: [{ rotate: `${String(tilt(item.id))}deg` }] }}
        >
          <Svg height={size} width={size}>
            <Path d={shape.path} fill={shape.fill} />
          </Svg>
        </View>
      )}
      {icon}
    </View>
  );
}
