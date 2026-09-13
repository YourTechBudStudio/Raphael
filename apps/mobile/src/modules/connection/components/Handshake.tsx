import { Check, X } from 'lucide-react-native';
import { ActivityIndicator, Text, View } from 'react-native';
import Animated, { FadeIn, LinearTransition, useReducedMotion } from 'react-native-reanimated';

import { colors } from '../../../ui/theme';
import type { HandshakeRow, StepState } from '../setup';

function Mark({ state }: { state: StepState }) {
  if (state === 'done') return <Check color={colors.primary} size={17} strokeWidth={2.6} />;
  if (state === 'failed') return <X color={colors.danger} size={17} strokeWidth={2.6} />;
  if (state === 'running') return <ActivityIndicator color={colors.primary} size="small" />;

  return <View className="h-[7px] w-[7px] rounded-full bg-line" />;
}

/** What a row's state is called out loud, since a tick, a cross and a dot are all silent. */
const SPOKEN: Readonly<Record<StepState, string>> = {
  pending: 'Not checked yet',
  running: 'Checking',
  done: 'Confirmed',
  failed: 'Failed',
};

export interface HandshakeProps {
  rows: readonly HandshakeRow[];
}

/**
 * What is known about this connection so far.
 *
 * Rows arrive as they resolve: the two local checks are always here because typing settles them,
 * and the network ones appear one at a time as the answer comes back. Nothing sits greyed out
 * waiting - a row that has not been asked about yet is not on screen at all, because showing it
 * would suggest this list is a set of hurdles rather than a report.
 */
export function Handshake({ rows }: HandshakeProps) {
  const reduced = useReducedMotion();
  // Calm at rest: a row settling into place, not a queue of things bouncing.
  const entering = reduced ? FadeIn.duration(1) : FadeIn.duration(220);
  const settling = reduced ? {} : { layout: LinearTransition.duration(200) };

  return (
    <Animated.View className="gap-1" {...settling}>
      {rows.map((row) => (
        <Animated.View entering={entering} key={row.step}>
          <View
            accessibilityLabel={`${row.problem?.title ?? row.label}. ${SPOKEN[row.state]}.`}
            accessibilityRole="text"
            className="min-h-[34px] flex-row items-center gap-3"
          >
            <View className="h-[18px] w-[18px] items-center justify-center">
              <Mark state={row.state} />
            </View>
            <Text
              className={
                row.state === 'failed'
                  ? 'flex-1 font-body-semibold text-[15px] text-danger'
                  : row.state === 'pending'
                    ? 'flex-1 font-body text-[15px] text-ink-soft opacity-45'
                    : 'flex-1 font-body text-[15px] text-ink'
              }
            >
              {row.problem?.title ?? row.label}
            </Text>
          </View>
          {row.problem === undefined ? null : (
            <Text
              accessibilityLiveRegion="polite"
              className="ml-[30px] pb-1 font-body text-[14px] leading-[20px] text-ink-soft"
            >
              {row.problem.detail}
            </Text>
          )}
        </Animated.View>
      ))}
    </Animated.View>
  );
}
