import { ChevronLeft, Eye, EyeOff } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, PrimaryButton } from '../../../ui';
import { gutter } from '../../../ui/theme';
import { verifyConnection } from '../client/verify';
import { SAMPLE_CONNECTION } from '../sample';
import { handshakeRows, hasFieldProblem, inspectSetupInput, type SetupPhase } from '../setup';
import type { Connection } from '../state/connection';
import { useConnectionStore } from '../state/connection';
import { ConnectionField } from './ConnectionField';
import { Handshake } from './Handshake';
import { PreviewPanel } from './PreviewPanel';

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
  /** Called after the new connection is recorded, so the caller can leave this screen. */
  onReplaced?: (() => void) | undefined;
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
export function SetupScreen({ replacing, onCancel, onReplaced }: SetupScreenProps = {}) {
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [settled, setSettled] = useState({ endpoint: false, key: false });
  const [attempted, setAttempted] = useState(false);
  const [phase, setPhase] = useState<SetupPhase>({ kind: 'idle' });
  const connect = useConnectionStore((state) => state.connect);
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
    if (hasFieldProblem(inspectSetupInput(endpoint, key))) {
      setPhase({ kind: 'idle' });
      return;
    }

    const mine = ++attempt.current;
    setPhase({ kind: 'verifying' });
    void verifyConnection(endpoint, key).then((outcome) => {
      if (mine !== attempt.current) return;
      if (outcome.ok) {
        setPhase({ kind: 'connected' });
        // The completed handshake is the one moment this screen's argument pays off, so it is
        // allowed to finish its sentence before the app moves on. Short enough to read, short
        // enough not to feel like a wait.
        hold.current = setTimeout(() => {
          if (mine !== attempt.current) return;
          connect(outcome.connection);
          onReplaced?.();
        }, SUCCESS_HOLD_MS);
        return;
      }
      setPhase({ kind: 'failed', problem: outcome.problem });
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

          <PreviewPanel
            actions={[
              {
                label: 'Enter without a server',
                onPress: () => {
                  attempt.current += 1;
                  setPhase({ kind: 'idle' });
                  connect(SAMPLE_CONNECTION);
                  onReplaced?.();
                },
              },
            ]}
            description="No server is contacted and nothing is verified. This exists so the screens behind this one can be reviewed while there is nothing to connect to."
          />
        </View>
      </ScrollView>

      <View
        className="border-t border-line bg-canvas px-5 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
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
