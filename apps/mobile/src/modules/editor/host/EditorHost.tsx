/**
 * The native host: one WebView, and the controller that drives it.
 *
 * It is deliberately thin. The sequencing rules live in `session.ts` and the promises, timers and
 * script channel live in `controller.ts`, both tested without React. What is left here is prop
 * forwarding, the locked-down WebView configuration, and the `key` that replaces a dead renderer.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { SNAPSHOT_TIMEOUT_MS } from '../bridge.ts';
import { EDITOR_DOCUMENT_HTML, EDITOR_DOCUMENT_STAMP } from '../generated/document.ts';
import { createEditorController, type EditorCallbacks, type EditorPort } from './controller.ts';

export type { EditorPort } from './controller.ts';

export interface EditorHostProps extends EditorCallbacks {
  /** Identity of the document under edit. Changing it is a replacement; equality is not a rerender. */
  readonly documentId: string;
  /** The canonical document to load. Read on identity change only. */
  readonly document: unknown;
  /** False is permanent for this host: read-only display, never unlocked into editing. */
  readonly editable: boolean;
  /** Carried through crash recovery unchanged. The owner decides what it means. */
  readonly unprotected?: boolean | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
  readonly ref?: Ref<EditorPort> | undefined;
}

export function EditorHost({
  documentId,
  document,
  editable,
  unprotected,
  onSnapshot,
  onSelectionChange,
  onLockedChange,
  onProblem,
  onLinkPress,
  style,
  ref,
}: EditorHostProps) {
  const webView = useRef<WebView>(null);
  const loaded = useRef(false);

  // Read fresh per effect, so a parent that re-creates its callbacks cannot strand a stale one and
  // cannot restart the machinery under a live session.
  const callbacks = useRef<EditorCallbacks>({});
  callbacks.current = { onSnapshot, onSelectionChange, onLockedChange, onProblem, onLinkPress };

  const [rendererKey, setRendererKey] = useState(1);

  const controllerRef = useRef<ReturnType<typeof createEditorController> | null>(null);
  controllerRef.current ??= createEditorController(
    {
      stamp: EDITOR_DOCUMENT_STAMP,
      documentId,
      document,
      editable,
      unprotected,
      snapshotTimeoutMs: SNAPSHOT_TIMEOUT_MS,
    },
    {
      inject: (script) => webView.current?.injectJavaScript(script),
      restartRenderer: (sessionId) => {
        loaded.current = false;
        setRendererKey(sessionId);
      },
      callbacks: () => callbacks.current,
    },
  );
  const controller = controllerRef.current;

  useImperativeHandle(ref, (): EditorPort => controller, [controller]);

  useEffect(() => {
    controller.replaceDocument(documentId, document);
  }, [controller, documentId, document]);

  useEffect(() => {
    if (unprotected === undefined) return;
    controller.setUnprotected(unprotected);
  }, [controller, unprotected]);

  // Nothing outlives the mount: every waiter settles and every timer is cleared.
  useEffect(() => () => controller.dispose(), [controller]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      controller.receive(event.nativeEvent.data);
    },
    [controller],
  );

  const onTerminated = useCallback(() => {
    controller.rendererTerminated();
  }, [controller]);

  const source = useMemo(() => ({ html: EDITOR_DOCUMENT_HTML }), []);

  return (
    <View style={style}>
      <WebView
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsLinkPreview={false}
        // The formatting row is native; the platform's own accessory bar would be a second one.
        hideKeyboardAccessoryView
        javaScriptEnabled
        // A tap must reach the editor without a first tap that only focuses the WebView.
        keyboardDisplayRequiresUserAction={false}
        key={rendererKey}
        onContentProcessDidTerminate={onTerminated}
        onMessage={onMessage}
        onRenderProcessGone={onTerminated}
        onShouldStartLoadWithRequest={(request) => {
          // Only the bundled document ever loads. A link never navigates the editor: the browser
          // reports the tap instead, and it reaches a consumer only after the shared URL policy has
          // passed it. This refusal stands whether or not anyone is listening for links.
          if (loaded.current) return false;
          const initial =
            request.url === 'about:blank' ||
            request.url === '' ||
            request.url.startsWith('data:text/html');
          if (initial) loaded.current = true;
          return initial;
        }}
        originWhitelist={['about:blank']}
        ref={webView}
        setSupportMultipleWindows={false}
        source={source}
        style={{ flex: 1, backgroundColor: 'transparent' }}
      />
    </View>
  );
}
