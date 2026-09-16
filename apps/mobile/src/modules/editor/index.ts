/**
 * The editor capability's public interface.
 *
 * It exports the host, the port capture drives, the toolbar, and the shared vocabulary — and nothing
 * from `webview/` or `generated/`. Those are the browser half and its build output; a native caller
 * that could reach them would be one import away from a second schema and a DOM-shaped graph.
 */

export { EditorHost, type EditorHostProps } from './host/EditorHost';
export {
  createEditorController,
  type EditorCallbacks,
  type EditorController,
  type EditorPort,
} from './host/controller.ts';
export type { BarrierResult, EditorProblem, EditorSnapshot, SessionPhase } from './host/session.ts';
export { EditorToolbar, type EditorToolbarProps } from './toolbar/EditorToolbar';
export {
  EDITOR_ACTIONS,
  EDITOR_BRIDGE_VERSION,
  SNAPSHOT_TIMEOUT_MS,
  commandForAction,
  type EditorActionId,
  type EditorCommand,
  type EditorRejectionCode,
  type EditorSelectionState,
} from './bridge.ts';
