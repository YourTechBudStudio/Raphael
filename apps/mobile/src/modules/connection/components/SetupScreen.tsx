import { ChevronLeft, Eye, EyeOff } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip, confirmDiscard, IconButton, PrimaryButton } from '../../../ui';
import { gutter } from '../../../ui/theme';
import { verifyConnection } from '../client/verify';
import { handshakeRows, hasFieldProblem, inspectSetupInput, type SetupPhase } from '../setup';
import type { Connection } from '../state/connection';
import { useConnectionStore } from '../state/connection';
import { ConnectionArt, type ThreadMode } from './ConnectionArt';
import { ConnectionField } from './ConnectionField';
import { Handshake } from './Handshake';

export interface SetupScreenProps {
  /**
   * The connection being replaced, when this screen is reached from Settings.
   *
   * Its presence changes nothing about how verification works - the same five conditions against a
   * new address - but it changes what the screen owes the person. They already have a working
   * server, so the screen says so, offers a way back to it, and does not replace it until the new
   * one has answered.
   */
  replacing?: Connection | undefined;
  /** Leaving without replacing anything. Only meaningful alongside `replacing`. */
  onCancel?: (() => void) | undefined;
  /** Whether the server being replaced answers right now. Only meaningful alongside `replacing`. */
  currentReachable?: boolean | undefined;
  /**
   * Writing on this phone that never reached the server being replaced. It cannot follow to another
   * server, so switching discards it: said above the button, and confirmed once the new server has
   * answered.
   */
  unsent?: number | undefined;
  /**
   * Removes that writing, before the switch. Answers whether it is gone; if not, nothing switches,
   * so writing meant for one server can never be sent to another.
   */
  onDiscardUnsent?: (() => Promise<boolean>) | undefined;
}

/**
 * The front door: where this device learns which server is its own.
 *
 * Order matters and mirrors `raphael login`. Check both fields locally, verify over the network,
 * and only record the connection once a Raphael server has answered with a protocol version this
 * app understands. Nothing is remembered before that, so a failed verification leaves the device exactly
 * as unconnected as it was.
 *
 * Connect is always pressable. The checks underneath report what is known; they do not stand
 * between the person and the button, and pressing with an unusable field is how you find out why.
 */
export function SetupScreen({
  replacing,
  onCancel,
  currentReachable = true,
  unsent = 0,
  onDiscardUnsent,
}: SetupScreenProps = {}) {
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [settled, setSettled] = useState({ endpoint: false, key: false });
  const [pressed, setPressed] = useState(false);
  const [phase, setPhase] = useState<SetupPhase>({ kind: 'idle' });
  // A verified server that could not be written down while another one is already in place. It is
  // not a handshake failure - all five conditions held - so it is said separately, under the button.
  const [notSaved, setNotSaved] = useState<string | null>(null);
  const [notDiscarded, setNotDiscarded] = useState(false);
  const unsentNow = useRef(unsent);
  unsentNow.current = unsent;
  const establish = useConnectionStore((state) => state.establish);
  // A deletion that failed during a disconnect. It is read from the store rather than passed in,
  // because the screen that asked for the disconnect was unmounted by the gate the moment the
  // phase changed - this is the first screen that exists afterwards, so it is where it can be said.
  const removalProblem = useConnectionStore((state) =>
    state.phase.kind === 'absent' ? state.phase.removalProblem : null,
  );
  const retryRemoval = useConnectionStore((state) => state.retryRemoval);
  const [retryingRemoval, setRetryingRemoval] = useState(false);
  const insets = useSafeAreaInsets();

  // Kept in a ref so an in-flight verification cannot resolve into a later verification's state.
  const verification = useRef(0);
  // The success hold is a timer that outlives the render that started it. Leaving without it being
  // cancelled would replace a working connection after the person had already backed out.
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (hold.current !== undefined) clearTimeout(hold.current);
    },
    [],
  );
  const verifying = phase.kind === 'verifying';

  const edit = (set: (value: string) => void, field: 'endpoint' | 'key') => (value: string) => {
    set(value);
    // Typing retracts what the last verification established, rather than leaving ticks standing
    // against values that are no longer the ones we checked.
    setSettled((current) => ({ ...current, [field]: false }));
    setPressed(false);
    setNotSaved(null);
    setNotDiscarded(false);
    // Typing during the success hold abandons it: the values are no longer the ones that answered.
    verification.current += 1;
    setPhase({ kind: 'idle' });
  };

  const settle = (field: 'endpoint' | 'key') => () => {
    setSettled((current) => ({ ...current, [field]: true }));
  };

  const onConnect = (): void => {
    if (verifying || phase.kind === 'connected') return;

    // Pressing Connect is someone declaring they are done, so a missing or unusable field can
    // finally say why rather than leaving the button looking broken.
    setPressed(true);
    setSettled({ endpoint: true, key: true });
    setNotSaved(null);
    setNotDiscarded(false);
    if (hasFieldProblem(inspectSetupInput(endpoint, key))) {
      setPhase({ kind: 'idle' });
      return;
    }

    const mine = ++verification.current;
    setPhase({ kind: 'verifying' });
    void verifyConnection(endpoint, key).then(async (outcome) => {
      // A verification that finishes after the person changed a field, backed out, or started
      // another verification is answering a question nobody is asking. It must not connect anything.
      if (mine !== verification.current) return;
      if (!outcome.ok) {
        setPhase({ kind: 'failed', problem: outcome.problem });
        return;
      }

      // Asked once, and only now that there is a working server to switch to.
      if (replacing !== undefined) {
        const count = unsentNow.current;

        if (count > 0) {
          const confirmed = await confirmDiscard(discardPrompt(count, replacing.origin));
          if (mine !== verification.current) return;
          if (!confirmed) {
            setPhase({ kind: 'idle' });
            setPressed(false);
            return;
          }
        }

        // Always, not only when something was counted: a write can land after the count was read.
        const discarded = (await onDiscardUnsent?.()) ?? true;
        if (mine !== verification.current) return;
        if (!discarded) {
          setPhase({ kind: 'idle' });
          setNotDiscarded(true);
          return;
        }
      }

      setPhase({ kind: 'connected' });
      // The completed handshake is the one moment this screen's argument pays off, so it is
      // allowed to finish its sentence before the app moves on. Short enough to read, short
      // enough not to feel like a wait.
      hold.current = setTimeout(() => {
        if (mine !== verification.current) return;

        void establish(outcome.server).then((result) => {
          if (mine !== verification.current) return;

          // Replacing a working connection is the one case where a failed write changes nothing.
          // The old server stays live and the screen says why the new one did not take its place.
          if (result.kind === 'replace_not_saved') {
            setPhase({ kind: 'idle' });
            setNotSaved(result.message);
            return;
          }

          if (result.kind === 'unusable') {
            setPhase({
              kind: 'failed',
              problem: {
                step: 'address',
                title: 'That connection cannot be used.',
                detail: result.message,
              },
            });
            return;
          }

          // `activated` leaves through the gate, which swaps this screen out on its own.
          // `superseded` means a newer decision already won, and this screen is no longer the one
          // in charge of anything.
        });
      }, SUCCESS_HOLD_MS);
    });
  };

  const rows = handshakeRows({ endpoint, key, settled, pressed, phase });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-canvas"
    >
      {replacing === undefined ? null : (
        <View className="absolute z-10" style={{ left: gutter - 10, top: insets.top + 8 }}>
          <IconButton
            icon={ChevronLeft}
            label="Back"
            onPress={() => {
              // Abandons any pending success hold as well as leaving: the connection this device
              // has is the one it keeps.
              verification.current += 1;
              onCancel?.();
            }}
          />
        </View>
      )}
      <ScrollView
        contentContainerStyle={
          replacing === undefined
            ? { paddingHorizontal: gutter, paddingTop: insets.top + 44, paddingBottom: 24 }
            : {
                flexGrow: 1,
                justifyContent: 'center',
                paddingHorizontal: gutter,
                paddingTop: insets.top + 64,
                paddingBottom: 24,
              }
        }
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-7">
          {removalProblem === null ? null : (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              className="gap-2 rounded-card border border-danger bg-card px-4 py-3"
            >
              <Text className="font-body-semibold text-[15px] leading-[21px] text-danger">
                The old key may still be on this device.
              </Text>
              <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
                {`Raphael has stopped using it, but deleting it from secure storage failed, so it may be read again the next time the app opens. ${removalProblem}`}
              </Text>
              <View className="flex-row pt-1">
                <Chip
                  accessibilityHint="Tries to delete the saved key from this device again"
                  label={retryingRemoval ? 'Removing…' : 'Try removing it again'}
                  onPress={() => {
                    setRetryingRemoval(true);
                    void retryRemoval().finally(() => {
                      setRetryingRemoval(false);
                    });
                  }}
                />
              </View>
            </View>
          )}

          {replacing === undefined ? (
            <View className="gap-2">
              <Text
                accessibilityRole="header"
                className="font-heading text-[38px] leading-[46px] text-ink"
              >
                raphael
              </Text>
              <Text className="font-body text-[16px] leading-[23px] text-ink-soft">
                Point this device at your server. Nothing is saved until it answers.
              </Text>
            </View>
          ) : (
            <View className="gap-8">
              <ConnectionArt mode={threadMode(phase)} travelling={verifying} />
              <View className="gap-2">
                <Text
                  accessibilityRole="header"
                  className="text-center font-heading text-[28px] leading-[34px] text-ink"
                >
                  Change server
                </Text>
                {/* Through the success hold the new server has answered, but nothing is switched
                    until it is written down and activated, which can still fail - so this says a
                    switch is under way, never that it is done. */}
                <Text
                  accessibilityLiveRegion="polite"
                  className="text-center font-body text-[16px] leading-[24px] text-ink-soft"
                >
                  {phase.kind === 'connected' ? (
                    <>
                      <Text className="font-body-semibold text-ink">{endpoint.trim()}</Text>{' '}
                      answered. Switching to it…
                    </>
                  ) : (
                    <>
                      {currentReachable ? 'Connected to ' : 'Can’t reach '}
                      <Text className="font-body-semibold text-ink">{replacing.origin}</Text>
                      {currentReachable ? '. ' : ' right now. '}
                      It stays your server until a new one answers.
                    </>
                  )}
                </Text>
              </View>
            </View>
          )}

          <View className="gap-2.5">
            <ConnectionField
              accessibilityHint="The address your Raphael server answers on"
              editable={!verifying}
              keyboardType="url"
              label="Address"
              onBlur={settle('endpoint')}
              onChangeText={edit(setEndpoint, 'endpoint')}
              placeholder="https://raphael.example.com"
              returnKeyType="next"
              testID="setup-endpoint"
              value={endpoint}
            />
            <ConnectionField
              accessibilityHint="The API key your server was started with"
              editable={!verifying}
              label="Key"
              onBlur={settle('key')}
              onChangeText={edit(setKey, 'key')}
              onSubmitEditing={onConnect}
              placeholder="Paste the key"
              returnKeyType="go"
              secure={!revealed}
              testID="setup-key"
              trailing={
                <View className="flex-row items-center gap-1">
                  {key.length === 0 ? null : (
                    <Text className="font-body text-[13px] text-ink-soft">
                      {String(key.length)}
                    </Text>
                  )}
                  <IconButton
                    accessibilityHint={
                      revealed
                        ? 'Hides the key again'
                        : 'Shows the key so you can check what you pasted'
                    }
                    icon={revealed ? EyeOff : Eye}
                    iconSize={19}
                    label={revealed ? 'Hide key' : 'Show key'}
                    onPress={() => {
                      setRevealed(!revealed);
                    }}
                  />
                </View>
              }
              value={key}
            />
          </View>

          <Handshake rows={rows} />
        </View>
      </ScrollView>

      <View className="gap-3 bg-canvas px-5 pt-2" style={{ paddingBottom: insets.bottom + 12 }}>
        {replacing === undefined || unsent === 0 || phase.kind === 'connected' ? null : (
          <Text
            accessibilityLiveRegion="polite"
            className="text-center font-body text-[15px] leading-[22px] text-ink-soft"
          >
            Switching discards{' '}
            <Text className="font-body-semibold text-ink">{unfinishedNotes(unsent)}</Text> on this
            phone.
          </Text>
        )}
        {notDiscarded ? (
          <Text
            accessibilityLiveRegion="assertive"
            className="font-body text-[14px] leading-[20px] text-danger"
          >
            {`Raphael could not remove the unfinished notes from this phone, so it did not switch. You are still connected to ${replacing?.origin ?? 'your server'}.`}
          </Text>
        ) : null}
        {notSaved === null ? null : (
          <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
            <Text className="font-body-semibold text-[15px] leading-[21px] text-danger">
              That server answered, but this device could not save it.
            </Text>
            <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
              {`${notSaved} You are still connected to ${replacing?.origin ?? 'your server'}, which has not changed.`}
            </Text>
          </View>
        )}
        <PrimaryButton
          busy={verifying || (replacing !== undefined && phase.kind === 'connected')}
          label={connectLabel(phase.kind, replacing !== undefined)}
          onPress={onConnect}
          testID="setup-connect"
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const unfinishedNotes = (count: number): string =>
  `${String(count)} unfinished ${count === 1 ? 'note' : 'notes'}`;

const discardPrompt = (count: number, origin: string) => ({
  title: `Discard ${unfinishedNotes(count)}?`,
  message: `${count === 1 ? 'It' : 'They'} never reached ${origin}, and ${count === 1 ? 'it' : 'they'} can’t move to the new server. Switching removes ${count === 1 ? 'it' : 'them'} from this phone.`,
  keepLabel: 'Cancel',
  discardLabel: 'Discard & switch',
});

/** The thread says what is known about the new server: nothing yet, broken, or joined. */
const threadMode = (phase: SetupPhase): ThreadMode => {
  if (phase.kind === 'connected') return 'joined';
  if (phase.kind === 'failed') return 'broken';
  return 'open';
};

/** How long the completed handshake stays on screen before the app moves on. */
const SUCCESS_HOLD_MS = 850;

const connectLabel = (phase: SetupPhase['kind'], replacing: boolean): string => {
  if (phase === 'verifying') return 'Connecting…';
  // Replacing is not finished when the new server answers: the switch can still fail.
  if (phase === 'connected') return replacing ? 'Switching…' : 'Connected';
  return replacing ? 'Use this server' : 'Connect';
};
