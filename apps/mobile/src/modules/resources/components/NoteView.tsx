import { Layers, X } from 'lucide-react-native';
import { Text, View } from 'react-native';

import {
  Chip,
  ComposerBar,
  ComposerFrame,
  ComposerStatus,
  IconButton,
  SkeletonBlock,
  SkeletonGroup,
} from '../../../ui';
import { EditorHost, type EditorProblem } from '../../editor';
import type { NoteViewState } from '../client/display';
import { NoteUnavailable } from './NoteUnavailable';

export interface NoteViewProps {
  state: NoteViewState;
  /**
   * The path to the container this note is filed in, deepest last. Empty when it is not known, which
   * is an honest answer rather than a blank chip.
   */
  location?: readonly string[] | undefined;
  onClose: () => void;
  /** A problem the renderer reported. The screen decides whether it means the note cannot be shown. */
  onProblem?: ((problem: EditorProblem) => void) | undefined;
}

/**
 * A note the server holds, open and read-only.
 *
 * The same layout as writing one - the same frame, the same status line beside the same close
 * control, the same bar - because to a person it is the same screen showing a note that is already
 * filed. What is missing is missing on purpose: no Save, no formatting row, no destination picker,
 * no autofocus on a title nobody can change, and no local copy of anything. Editing is story #4;
 * until then this screen cannot alter a note and holds no draft that could be confused with one.
 *
 * The status names the fact that distinguishes it from everything unfinished: this is on the server,
 * at this revision.
 *
 * Presentation only, and that is what makes it testable: the queries, the hierarchy lookup and the
 * decision about whether a body may be displayed are the screen's, above it.
 */
export function NoteView({ state, location, onClose, onProblem }: NoteViewProps) {
  const close = <IconButton icon={X} label="Close" onPress={onClose} />;
  const segments = location ?? [];
  const leaf = segments.at(-1);
  const chipLabel =
    leaf === undefined
      ? 'Filed on your server'
      : `${segments.length > 2 ? '… / ' : ''}${segments.slice(-2).join(' / ')}`;

  if (state.kind === 'unavailable') {
    return <NoteUnavailable onHome={onClose} reason={state.reason} />;
  }

  if (state.kind === 'loading') {
    return (
      <ComposerFrame leading={close} status={<ComposerStatus>Opening…</ComposerStatus>}>
        <SkeletonGroup className="gap-3 px-5 pt-2" label="Opening this note">
          <SkeletonBlock height={32} width={240} />
          <SkeletonBlock height={20} width={180} />
          <SkeletonBlock height={220} />
        </SkeletonGroup>
      </ComposerFrame>
    );
  }

  return (
    <ComposerFrame
      bar={
        <ComposerBar>
          <Chip
            accessibilityLabel={
              leaf === undefined ? 'Filed on your server' : `Filed in ${segments.join(', ')}`
            }
            icon={Layers}
            label={chipLabel}
            style={{ flexShrink: 1 }}
            testID="note-destination"
          />
        </ComposerBar>
      }
      leading={close}
      status={
        <ComposerStatus testID="note-status">{`On your server · revision ${String(state.revision)}`}</ComposerStatus>
      }
      testID="note-screen"
    >
      <View className="flex-1">
        <View className="px-5 pt-2">
          <Text
            accessibilityRole="header"
            className="font-heading text-[26px] leading-[32px] text-ink"
          >
            {state.title}
          </Text>
          {state.description === '' ? null : (
            <Text className="mt-1 font-body text-[15px] leading-[22px] text-ink-soft">
              {state.description}
            </Text>
          )}
        </View>
        {/* `editable={false}` is permanent for this host: read-only display, never an editor that
            could be unlocked. No snapshot is ever asked for, so nothing here can write - not to the
            server and not to this phone. */}
        <EditorHost
          document={state.body}
          documentId={state.documentId}
          editable={false}
          onProblem={onProblem}
          style={{ flex: 1, marginTop: 12 }}
        />
      </View>
    </ComposerFrame>
  );
}
