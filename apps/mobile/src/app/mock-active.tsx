/**
 * Temporary design mock for story #5 (active projects). Presentation only. Reference for the
 * implementer; delete this file and the "Design mocks" chip on Settings once the story ships.
 *
 * Open from Settings → "Active projects mock".
 *
 * Decisions this page records (agreed in the design walkthrough):
 *   - Busy: a thin lilac ring turning around the mark, on the bare bolt (48 box) and on the
 *     labelled toggle (44 box). The mark keeps showing the written state underneath. Lilac is a
 *     deliberate exception to "in progress is primary violet": the ring sits beside a violet mark
 *     and is quieter in lilac. Static arc under reduced motion.
 *   - Verdict: one sentence inside the card, beneath the row, 14px. "Did not update" in danger;
 *     "changed since you looked" in soft ink, because it is information about a refresh in flight,
 *     not a failure of the write. Same colours on the Project header.
 *   - Ordering: hierarchy order, as the design says; no preference was expressed.
 *
 * What it shows, top to bottom:
 *   1. Playground: tap a bolt, pick what the server will answer, watch the card go busy, settle,
 *      conflict, fail, or linger (the D6 tail, and the R3 stale-after-success case).
 *   2. Verdict sentences beneath cards (P10), both kinds at once.
 *   3. Home section states: skeleton, empty, failed, stale reading.
 *   4. Project header states.
 */
import { Pencil } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { goBack, TitleTopBar } from '../modules/navigation';
import {
  ACTIVE_MARK,
  ActiveButton,
  Card,
  Chip,
  colors,
  Emblem,
  emblemFor,
  Eyebrow,
  FAVORITE_MARK,
  PressableFeedback,
  Screen,
  SectionHeading,
  SkeletonBlock,
  SkeletonGroup,
  ToggleLabel,
} from '../ui';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

interface MockProject {
  readonly id: number;
  readonly title: string;
  readonly description: string;
}

/** Depth-first hierarchy order: Work area first, then Home area. */
const PROJECTS: readonly MockProject[] = [
  { id: 11, title: 'Backend', description: 'SQLite, FTS5, and the five operations.' },
  { id: 12, title: 'Mobile app', description: '' },
  { id: 13, title: 'Release notes', description: 'What changed, said plainly.' },
  { id: 21, title: 'Kitchen', description: 'Replace the tap before it replaces itself.' },
  { id: 22, title: 'Garden', description: '' },
];

const COPY = {
  conflict: 'This project changed since you looked. Refreshing it; then try again.',
  failed: 'Active status did not update. Try again.',
  empty: 'No active projects. Mark one as Active from its page to keep it here.',
  unableToLoad: 'Unable to load active projects.',
  stale: 'The most recent check did not reach the server. This is what it said last time.',
} as const;

// ---------------------------------------------------------------------------------------------
// Busy ring
// ---------------------------------------------------------------------------------------------

/** A thin lilac arc turning around the mark. Static arc under reduced motion. */
function BusyRing({ size }: { size: number }) {
  const reducedMotion = useReducedMotion();
  const turn = useSharedValue(0);

  useEffect(() => {
    turn.value = reducedMotion
      ? 0
      : withRepeat(withTiming(360, { duration: 1100, easing: Easing.linear }), -1, false);
  }, [reducedMotion, turn]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  const r = size / 2 - 2;
  const circumference = 2 * Math.PI * r;

  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, top: 0, width: size, height: size }, style]}
    >
      <Svg height={size} width={size} viewBox={`0 0 ${String(size)} ${String(size)}`}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={r}
          stroke={colors.lilac}
          strokeDasharray={`${String(circumference * 0.28)} ${String(circumference)}`}
          strokeLinecap="round"
          strokeWidth={2}
        />
      </Svg>
    </Animated.View>
  );
}

/** Wraps a control's mark box with the ring while busy. `size` is the mark's box: 48 or 44. */
function Busy({
  busy,
  size,
  children,
}: {
  busy: boolean;
  size: number;
  children: React.ReactNode;
}) {
  return (
    <View>
      {children}
      {busy ? <BusyRing size={size} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Card and sentences
// ---------------------------------------------------------------------------------------------

type Verdict = 'conflict' | 'failed' | null;

function VerdictLine({ verdict }: { verdict: Verdict }) {
  if (verdict === null) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      className={[
        'font-body text-[14px] leading-[20px]',
        verdict === 'failed' ? 'text-danger' : 'text-ink-soft',
      ].join(' ')}
    >
      {COPY[verdict]}
    </Text>
  );
}

interface MockCardProps {
  project: MockProject;
  active: boolean;
  busy: boolean;
  verdict: Verdict;
  onToggle: () => void;
}

/** `ActiveProjectCard` plus the busy ring on the bolt and the verdict sentence beneath the row. */
function MockCard({ project, active, busy, verdict, onToggle }: MockCardProps) {
  const hasDescription = project.description !== '';

  return (
    <Card className="px-3 py-2" wave waveHeight={24}>
      <View className="flex-row items-center gap-2">
        <PressableFeedback
          accessibilityHint="Opens project"
          accessibilityLabel={project.title}
          className="min-h-16 flex-row items-center gap-3 py-2"
          hitSlop={0}
          onPress={() => undefined}
          style={{ flex: 1 }}
        >
          <Emblem name={emblemFor('project', project.id)} size={32} />
          <View className="flex-1">
            <Text className="font-heading text-[18px] leading-[24px] text-ink">
              {project.title}
            </Text>
            {hasDescription ? (
              <Text className="mt-1 font-body text-[15px] leading-[20px] text-ink-soft">
                {project.description}
              </Text>
            ) : null}
          </View>
        </PressableFeedback>
        <Busy busy={busy} size={48}>
          <ActiveButton active={active} disabled={busy} label={project.title} onToggle={onToggle} />
        </Busy>
      </View>
      {verdict === null ? null : (
        <View className="px-1 pb-2 pt-1">
          <VerdictLine verdict={verdict} />
        </View>
      )}
    </Card>
  );
}

function StaleBanner() {
  return (
    <View className="gap-2 rounded-card border border-line bg-card px-4 py-3">
      <Text
        accessibilityLiveRegion="polite"
        className="font-body text-[14px] leading-[20px] text-ink-soft"
      >
        {COPY.stale}
      </Text>
      <View className="flex-row">
        <Chip label="Try again" onPress={() => undefined} />
      </View>
    </View>
  );
}

function Quiet({ children }: { children: string }) {
  return <Text className="font-body text-[15px] leading-[22px] text-ink-soft">{children}</Text>;
}

/** Small caption that labels a mock frame. Not a product element. */
function Caption({ children }: { children: string }) {
  return (
    <Text className="font-body-medium text-[13px] uppercase tracking-wide text-lilac-deep">
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------------------------
// Playground: simulated toggle lifecycle
// ---------------------------------------------------------------------------------------------

type Outcome = 'success' | 'slow' | 'conflict' | 'failed' | 'refreshFails';

const OUTCOMES: readonly { readonly key: Outcome; readonly label: string }[] = [
  { key: 'success', label: 'Success' },
  { key: 'slow', label: 'Slow re-read (6s)' },
  { key: 'conflict', label: 'Conflict' },
  { key: 'failed', label: 'Failed' },
  { key: 'refreshFails', label: 'Refresh fails after success' },
];

type Phase = 'idle' | 'inFlight' | 'rereading';

interface CardState {
  readonly active: boolean;
  readonly phase: Phase;
  /** What the tap asked for; shown while pending. */
  readonly intent: boolean | null;
  readonly verdict: Verdict;
}

const REQUEST_MS = 900;
const REREAD_MS = 1200;
const SLOW_REREAD_MS = 6000;

const freshCards = (): ReadonlyMap<number, CardState> =>
  new Map(
    PROJECTS.map((p) => [p.id, { active: true, phase: 'idle', intent: null, verdict: null }]),
  );

function Playground() {
  const [outcome, setOutcome] = useState<Outcome>('success');
  const [stale, setStale] = useState(false);
  const [cards, setCards] = useState(freshCards);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );

  const later = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const patch = (id: number, change: Partial<CardState>) => {
    setCards((prev) => {
      const next = new Map(prev);
      const current = prev.get(id);
      if (current !== undefined) next.set(id, { ...current, ...change });
      return next;
    });
  };

  const toggle = (id: number) => {
    const current = cards.get(id);
    if (current === undefined || current.phase !== 'idle') return;
    const wanted = !current.active;
    patch(id, { phase: 'inFlight', intent: wanted, verdict: null });

    later(REQUEST_MS, () => {
      if (outcome === 'conflict' || outcome === 'failed') {
        // Refusal: intent clears at once, the screen shows what it last read, and says why.
        patch(id, { phase: 'idle', intent: null, verdict: outcome });
        return;
      }
      // Accepted: stay pending until the re-read lands.
      patch(id, { phase: 'rereading' });
      later(outcome === 'slow' ? SLOW_REREAD_MS : REREAD_MS, () => {
        if (outcome === 'refreshFails') {
          // R3: the re-read failed; the retained reading still says the old value.
          patch(id, { phase: 'idle', intent: null });
          setStale(true);
          return;
        }
        patch(id, { phase: 'idle', intent: null, active: wanted });
      });
    });
  };

  const reset = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    setStale(false);
    setCards(freshCards());
  };

  const shown = PROJECTS.filter((p) => {
    const s = cards.get(p.id);
    // A deactivated card stays until the re-read lands; then it disappears in one step.
    return s !== undefined && (s.active || s.phase !== 'idle');
  });

  return (
    <View className="gap-3">
      <Caption>Next server answer</Caption>
      <View className="flex-row flex-wrap gap-2">
        {OUTCOMES.map((o) => (
          <Chip
            key={o.key}
            label={o.label}
            onPress={() => setOutcome(o.key)}
            selected={outcome === o.key}
          />
        ))}
      </View>
      <View className="flex-row">
        <Chip label="Reset cards" onPress={reset} />
      </View>

      <SectionHeading className="mt-2">Active projects</SectionHeading>
      {stale ? <StaleBanner /> : null}
      {shown.length === 0 ? (
        <Quiet>{COPY.empty}</Quiet>
      ) : (
        shown.map((p) => {
          const s = cards.get(p.id)!;
          return (
            <MockCard
              active={s.intent ?? s.active}
              busy={s.phase !== 'idle'}
              key={p.id}
              onToggle={() => toggle(p.id)}
              project={p}
              verdict={s.verdict}
            />
          );
        })
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Project header
// ---------------------------------------------------------------------------------------------

interface HeaderFrameProps {
  title: string;
  active: boolean;
  busy: boolean;
  verdict: Verdict;
}

function ProjectHeaderFrame({ title, active, busy, verdict }: HeaderFrameProps) {
  return (
    <View className="rounded-card border border-line bg-canvas px-4 py-4">
      <Eyebrow>Project</Eyebrow>
      <Text
        accessibilityRole="header"
        className="mt-1 font-heading text-[30px] leading-[36px] text-ink"
      >
        {title}
      </Text>
      <View className="mt-4 flex-row flex-wrap items-center gap-x-5 gap-y-1">
        <Busy busy={busy} size={44}>
          <ToggleLabel
            accessibilityLabel={active ? `Mark ${title} as inactive` : `Mark ${title} as active`}
            disabled={busy}
            label="Active"
            mark={ACTIVE_MARK}
            onToggle={() => undefined}
            selected={active}
          />
        </Busy>
        <ToggleLabel
          accessibilityLabel={`Add ${title} to favorites`}
          label="Favorite"
          mark={FAVORITE_MARK}
          onToggle={() => undefined}
          selected={false}
        />
        <PressableFeedback
          accessibilityLabel="Edit project"
          accessibilityRole="button"
          className="h-11 flex-row items-center gap-1 pr-2"
          onPress={() => undefined}
        >
          <View className="items-center justify-center" style={{ height: 44, width: 44 }}>
            <Pencil color={colors.primary} size={20} strokeWidth={2} />
          </View>
          <Text className="font-body-medium text-[16px] text-ink">Edit</Text>
        </PressableFeedback>
      </View>
      {verdict === null ? null : (
        <View className="mt-2">
          <VerdictLine verdict={verdict} />
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export default function MockActive() {
  const noop = () => undefined;

  return (
    <Screen
      captureBar={false}
      header={<TitleTopBar onBack={goBack} title="Mock: active projects" />}
    >
      <View className="gap-10">
        <View className="gap-3">
          <Caption>1 · Playground: tap a bolt</Caption>
          <Playground />
        </View>

        <View className="gap-3">
          <Caption>2 · Verdict beneath the card that asked (P10)</Caption>
          <MockCard active busy={false} onToggle={noop} project={PROJECTS[0]!} verdict="conflict" />
          <MockCard active busy={false} onToggle={noop} project={PROJECTS[1]!} verdict="failed" />
          <MockCard active busy={false} onToggle={noop} project={PROJECTS[2]!} verdict={null} />
        </View>

        <View className="gap-6">
          <Caption>3 · Home section states</Caption>
          <View className="gap-3">
            <SectionHeading>Active projects</SectionHeading>
            <SkeletonGroup label="Loading active projects">
              <View className="gap-3">
                <SkeletonBlock height={88} />
                <SkeletonBlock height={88} />
              </View>
            </SkeletonGroup>
          </View>
          <View className="gap-3">
            <SectionHeading>Active projects</SectionHeading>
            <Quiet>{COPY.empty}</Quiet>
          </View>
          <View className="gap-3">
            <SectionHeading>Active projects</SectionHeading>
            <Text
              accessibilityLiveRegion="polite"
              className="font-body text-[15px] leading-[22px] text-ink-soft"
            >
              {COPY.unableToLoad}
            </Text>
          </View>
          <View className="gap-3">
            <SectionHeading>Active projects</SectionHeading>
            <StaleBanner />
            <MockCard active busy={false} onToggle={noop} project={PROJECTS[0]!} verdict={null} />
            <MockCard active busy={false} onToggle={noop} project={PROJECTS[3]!} verdict={null} />
          </View>
        </View>

        <View className="gap-3">
          <Caption>4 · Project header states</Caption>
          <ProjectHeaderFrame active={false} busy={false} title="Backend" verdict={null} />
          <ProjectHeaderFrame active busy={false} title="Backend" verdict={null} />
          <ProjectHeaderFrame active busy title="Backend" verdict={null} />
          <ProjectHeaderFrame active busy={false} title="Backend" verdict="conflict" />
          <ProjectHeaderFrame active={false} busy={false} title="Backend" verdict="failed" />
        </View>
      </View>
    </Screen>
  );
}
