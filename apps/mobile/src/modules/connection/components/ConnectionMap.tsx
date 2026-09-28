import { Hourglass, Lock, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { colors } from '../../../ui';
import type { Connection, Rejection } from '../state/connection';
import { PhoneMark, ServerMark } from './ConnectionArt';
import { rejectionCopy } from './rejection-copy';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const PHONE = 72;
const SERVER = 92;
/** The phone sits in from the edge so its tilt is not clipped. */
const PHONE_INSET = 8;
/** Room between the phone's row and the server's, which the thread spends turning the corner. */
const DROP = 64;
/** How far the server's words sit below the thread's way in, so the two never touch. */
const LABEL_CLEARANCE = 14;
/** The cookie's left scallop sits this far inside its box. */
const SERVER_EDGE = 8;
const DRAW_MS = 700;

interface Status {
  readonly icon: LucideIcon;
  readonly text: string;
  readonly problem: boolean;
}

/**
 * Where the key is, said beside the phone because that is where it is.
 *
 * "We tried and the keychain refused" and "there is no keychain on this platform" are different
 * events with the same consequence, so they share a label here and differ in the sentence below.
 */
const phoneStatus = (connection: Connection, rejection: Rejection | null): Status => {
  if (rejection === 'unauthorized') {
    return { icon: TriangleAlert, text: 'Its key was refused', problem: true };
  }
  if (connection.storage.kind === 'saved') {
    return { icon: Lock, text: 'Key saved here', problem: false };
  }
  return { icon: Hourglass, text: 'Key held until you close the app', problem: true };
};

const storageDetail = (connection: Connection): string | null => {
  switch (connection.storage.kind) {
    case 'saved':
      return null;
    case 'write_failed':
      return `This device's secure storage would not accept the key, so it is only in memory. ${connection.storage.message} Raphael will ask for it again next time you open the app.`;
    case 'unsupported':
      return 'This platform has no secure storage, so nothing was written. Raphael will ask for the key again next time.';
  }
};

interface Geometry {
  readonly width: number;
  readonly height: number;
  /** Bottom of the phone's row, which grows with its words at large text sizes. */
  readonly phoneRow: number;
  readonly serverTop: number;
}

interface Thread {
  readonly d: string;
  readonly length: number;
  readonly start: { x: number; y: number };
  readonly end: { x: number; y: number };
  /** Where a broken thread comes apart. */
  readonly gap: { x: number; y: number };
}

/**
 * Down from the phone, then a wide turn into the server's side: the same broad S as the wave.
 *
 * The stem runs straight until it is clear of the phone's words, and the curve only ever descends,
 * so it passes above the server's words and never through either label.
 */
function threadFor({ width, phoneRow, serverTop }: Geometry): Thread {
  const x0 = PHONE_INSET + PHONE / 2;
  const y0 = PHONE - 2;
  const y1 = Math.max(y0, phoneRow);
  const x3 = width - SERVER + SERVER_EDGE;
  const y3 = serverTop + SERVER / 2;
  const c1 = { x: x0, y: y1 + (y3 - y1) * 0.9 };
  const c2 = { x: x0 + (x3 - x0) * 0.45, y: y3 };

  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u ** 3 * x0 + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * x3,
      y: u ** 3 * y1 + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * y3,
    };
  };

  let length = y1 - y0;
  let previous = at(0);
  for (let step = 1; step <= 32; step += 1) {
    const next = at(step / 32);
    length += Math.hypot(next.x - previous.x, next.y - previous.y);
    previous = next;
  }

  return {
    d: `M${String(x0)} ${String(y0)} L${String(x0)} ${String(y1)} C${String(c1.x)} ${String(c1.y)} ${String(c2.x)} ${String(c2.y)} ${String(x3)} ${String(y3)}`,
    length,
    start: { x: x0, y: y0 },
    end: { x: x3, y: y3 },
    gap: at(0.55),
  };
}

/**
 * A joined thread draws itself in from the phone once - when the screen opens, or when a refused
 * connection is accepted again and the thread replaces the broken one - and then stays still.
 */
function JoinedThread({ thread }: { thread: Thread }) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(reducedMotion ? 1 : 0);

  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withTiming(1, { duration: DRAW_MS, easing: Easing.out(Easing.cubic) });
  }, [reducedMotion, progress]);

  const line = useAnimatedProps(() => ({
    strokeDashoffset: thread.length * (1 - progress.value),
  }));
  const arrival = useAnimatedProps(() => ({
    opacity: progress.value > 0.97 ? 1 : 0,
  }));

  return (
    <>
      <AnimatedPath
        animatedProps={line}
        d={thread.d}
        fill="none"
        stroke={colors.primary}
        strokeDasharray={[thread.length, thread.length]}
        strokeLinecap="round"
        strokeWidth={3}
      />
      <Circle cx={thread.start.x} cy={thread.start.y} fill={colors.primary} r={4.5} />
      <AnimatedCircle
        animatedProps={arrival}
        cx={thread.end.x}
        cy={thread.end.y}
        fill={colors.primary}
        r={4.5}
      />
    </>
  );
}

function BrokenThread({ thread }: { thread: Thread }) {
  return (
    <>
      <Path
        d={thread.d}
        fill="none"
        stroke={colors.lilac}
        strokeDasharray={[1, 8]}
        strokeLinecap="round"
        strokeWidth={3}
      />
      {/* The break: canvas over the dots, and two loose ends a little out of line. */}
      <Circle cx={thread.gap.x} cy={thread.gap.y} fill={colors.canvas} r={12} />
      <Circle cx={thread.gap.x - 5} cy={thread.gap.y - 4} fill={colors.danger} r={3.5} />
      <Circle cx={thread.gap.x + 5} cy={thread.gap.y + 4} fill={colors.danger} r={3.5} />
    </>
  );
}

function StatusLine({ status, align }: { status: Status; align: 'left' | 'right' }) {
  const Icon = status.icon;

  return (
    <View
      className={['flex-row items-start gap-1.5', align === 'right' ? 'justify-end' : ''].join(' ')}
    >
      <View className="pt-[3px]">
        <Icon color={status.problem ? colors.danger : colors.primary} size={16} strokeWidth={2} />
      </View>
      <Text
        className={[
          'shrink font-body-medium text-[16px] leading-[22px]',
          status.problem ? 'text-danger' : 'text-ink',
          align === 'right' ? 'text-right' : '',
        ].join(' ')}
      >
        {status.text}
      </Text>
    </View>
  );
}

export interface ConnectionMapProps {
  connection: Connection;
  rejection: Rejection | null;
}

/**
 * The server this device is talking to, drawn as the thing it is: this phone, holding a key,
 * joined to a server at an address.
 *
 * Each fact is written beside the end it belongs to. The key is the phone's, so where it is kept is
 * said next to the phone; the address is the server's. The thread is the same one the offline and
 * change-server screens draw, finished: solid while the server accepts this phone, and broken when
 * it has refused it. The drawing is decorative - the words beside it say everything it does.
 *
 * The key is never shown, not even in part: one key and one server means a fingerprint would
 * identify nothing the address does not. The protocol version is not shown either; it describes
 * two programs agreeing when the connection was made, which nobody can act on.
 */
export function ConnectionMap({ connection, rejection }: ConnectionMapProps) {
  const [geometry, setGeometry] = useState<Geometry>({
    width: 0,
    height: 0,
    phoneRow: 0,
    serverTop: 0,
  });
  const ready = geometry.width > 0 && geometry.serverTop > 0;
  const thread = ready ? threadFor(geometry) : null;
  const joined = rejection === null;
  const phone = phoneStatus(connection, rejection);
  const server: Status | null =
    rejection === 'incompatible_protocol'
      ? { icon: TriangleAlert, text: 'Speaks a different version', problem: true }
      : null;
  const details = [
    rejection === null ? null : rejectionCopy(rejection).detail,
    storageDetail(connection),
  ].filter((detail) => detail !== null);

  const onMapLayout = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setGeometry((current) => ({ ...current, width: layout.width, height: layout.height }));
  };
  const onPhoneRowLayout = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setGeometry((current) => ({ ...current, phoneRow: layout.height }));
  };
  const onServerRowLayout = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setGeometry((current) => ({ ...current, serverTop: layout.y }));
  };

  return (
    <View className="gap-5">
      <View onLayout={onMapLayout}>
        <View className="flex-row items-start gap-4" onLayout={onPhoneRowLayout}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ marginLeft: PHONE_INSET }}
          >
            <PhoneMark size={PHONE} tilt={-8} />
          </View>
          <View
            accessibilityLabel={`This phone. ${phone.text}.`}
            accessible
            className="flex-1 gap-0.5 pt-2"
          >
            <Text className="font-body text-[14px] leading-[20px] text-ink-soft">This phone</Text>
            <StatusLine align="left" status={phone} />
          </View>
        </View>

        <View style={{ height: DROP }} />

        <View className="flex-row items-start" onLayout={onServerRowLayout}>
          <View
            accessibilityLabel={[
              `Your server, ${connection.origin}`,
              joined ? 'connected' : null,
              server === null ? null : server.text.toLowerCase(),
            ]
              .filter((part) => part !== null)
              .join(', ')}
            accessible
            className="flex-1 items-end gap-0.5 pr-3"
            style={{ paddingTop: SERVER / 2 + LABEL_CLEARANCE }}
          >
            <Text className="font-body text-[14px] leading-[20px] text-ink-soft">Your server</Text>
            <Text className="text-right font-heading text-[17px] leading-[23px] text-ink">
              {connection.origin}
            </Text>
            {server === null ? null : <StatusLine align="right" status={server} />}
          </View>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ServerMark faint={!joined} size={SERVER} tilt={14} />
          </View>
        </View>

        {thread === null ? null : (
          <View
            accessibilityElementsHidden
            className="absolute left-0 top-0"
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
          >
            <Svg height={geometry.height} width={geometry.width}>
              {joined ? <JoinedThread thread={thread} /> : <BrokenThread thread={thread} />}
            </Svg>
          </View>
        )}
      </View>

      {details.map((detail) => (
        <Text
          accessibilityLiveRegion="polite"
          className="font-body text-[15px] leading-[22px] text-ink-soft"
          key={detail}
        >
          {detail}
        </Text>
      ))}
    </View>
  );
}
