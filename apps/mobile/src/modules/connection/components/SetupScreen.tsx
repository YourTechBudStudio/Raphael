import { ChevronLeft, Eye, EyeOff } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip, IconButton, PrimaryButton } from '../../../ui';
import { gutter } from '../../../ui/theme';
import { verifyConnection } from '../client/verify';
import { handshakeRows, hasFieldProblem, inspectSetupInput, type SetupPhase } from '../setup';
import type { Connection } from '../state/connection';
import { useConnectionStore } from '../state/connection';
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
  /**
   * Anything the app wants shown below the form while there is no connection.
   *
   * A slot rather than an import, because what goes here belongs to another capability and this one
   * has no business knowing about it. Composition fills it; the connection capability stays unaware.
   */
  footer?: ReactNode | undefined;
}

/**
 * The front door: where this device learns which server is its own.
 *
 * Order matters and mirrors `raphael login`. Check both fields locally, verify over the network,
 * and only record the connection once a Raphael server has answered with a protocol version this
 * app understands. Nothing is remembered before that, so a failed attempt leaves the device exactly
 * as unconnected as it was.
 *
 * Connect is always pressable. The checks underneath report what is known; they do not stand
 * between the person and the button, and pressing with an unusable field is how you find out why.
 */
export function SetupScreen({ replacing, onCancel, footer }: SetupScreenProps = {}) {
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [settled, setSettled] = useState({ endpoint: false, key: false });
  const [attempted, setAttempted] = useState(false);
  const [phase, setPhase] = useState<SetupPhase>({ kind: 'idle' });
  // A verified server that could not be written down while another one is already in place. It is
  // not a handshake failure - all five conditions held - so it is said separately, under the button.
  const [notSaved, setNotSaved] = useState<string | null>(null);
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

  // Kept in a ref so an in-flight verification cannot resolve into a later attempt's state.
  const attempt = useRef(0);
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
    // Typing retracts what the last attempt established, rather than leaving ticks standing
    // against values that are no longer the ones we checked.
    setSettled((current) => ({ ...current, [field]: false }));
    setAttempted(false);
    setNotSaved(null);
    // Typing during the success hold abandons it: the values are no longer the ones that answered.
    attempt.current += 1;
    setPhase({ kind: 'idle' });
  };

  const settle = (field: 'endpoint' | 'key') => () => {
    setSettled((current) => ({ ...current, [field]: true }));
  };

  const onConnect = (): void => {
    if (verifying || phase.kind === 'connected') return;

    // Pressing Connect is someone declaring they are done, so a missing or unusable field can
    // finally say why rather than leaving the button looking broken.
    setAttempted(true);
    setSettled({ endpoint: true, key: true });
    setNotSaved(null);
    if (hasFieldProblem(inspectSetupInput(endpoint, key))) {
      setPhase({ kind: 'idle' });
      return;
    }

    const mine = ++attempt.current;
    setPhase({ kind: 'verifying' });
    void verifyConnection(endpoint, key).then((outcome) => {
      // A verification that finishes after the person changed a field, backed out, or started
      // another attempt is answering a question nobody is asking. It must not connect anything.
      if (mine !== attempt.current) return;
      if (!outcome.ok) {
        setPhase({ kind: 'failed', problem: outcome.problem });
        return;
      }

      setPhase({ kind: 'connected' });
      // The completed handshake is the one moment this screen's argument pays off, so it is
      // allowed to finish its sentence before the app moves on. Short enough to read, short
      // enough not to feel like a wait.
      hold.current = setTimeout(() => {
        if (mine !== attempt.current) return;

        void establish(outcome.server).then((result) => {
          if (mine !== attempt.current) return;

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

  const rows = handshakeRows({ endpoint, key, settled, attempted, phase });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-canvas"
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: gutter,
          paddingTop: insets.top + 44,
          paddingBottom: 24,
        }}
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
            <View className="gap-3">
              <View className="-ml-2 flex-row items-center gap-1">
                <IconButton
                  icon={ChevronLeft}
                  label="Back"
                  onPress={() => {
                    // Abandons any pending success hold as well as leaving: the connection this
                    // device has is the one it keeps.
                    attempt.current += 1;
                    onCancel?.();
                  }}
                />
                <Text
                  accessibilityRole="header"
                  className="font-heading text-[26px] leading-[32px] text-ink"
                >
                  Change server
                </Text>
              </View>
              <Text className="font-body text-[16px] leading-[23px] text-ink-soft">
                Still connected to{' '}
                <Text className="font-body-semibold text-ink">{replacing.origin}</Text>. That stays
                in place until a new server answers.
              </Text>
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

          {footer === undefined ? null : <View className="pt-2">{footer}</View>}
        </View>
      </ScrollView>

      <View
        className="border-t border-line bg-canvas px-5 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        {notSaved === null ? null : (
          <View accessibilityLiveRegion="assertive" accessibilityRole="alert" className="pb-3">
            <Text className="font-body-semibold text-[15px] leading-[21px] text-danger">
              That server answered, but this device could not save it.
            </Text>
            <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
              {`${notSaved} You are still connected to ${replacing?.origin ?? 'your server'}, which has not changed.`}
            </Text>
          </View>
        )}
        <PrimaryButton
          busy={verifying}
          label={connectLabel(phase.kind, replacing !== undefined)}
          onPress={onConnect}
          testID="setup-connect"
        />
      </View>
    </KeyboardAvoidingView>
  );
}

/** How long the completed handshake stays on screen before the app moves on. */
const SUCCESS_HOLD_MS = 850;

const connectLabel = (phase: SetupPhase['kind'], replacing: boolean): string => {
  if (phase === 'verifying') return 'Connecting…';
  if (phase === 'connected') return 'Connected';
  return replacing ? 'Use this server' : 'Connect';
};
