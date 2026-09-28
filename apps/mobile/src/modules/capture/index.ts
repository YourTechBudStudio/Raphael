/**
 * Writing: the composer for a new note, the editor for anything that exists, Unfinished, and voice
 * capture. The screens write `unsent` rows; `unsent` sends them.
 */

export { VoiceCaptureSheet } from './components/VoiceCaptureSheet';
// What a host mounts is the dock, which owns the one rule: a draft exists before a composer opens.
export { CaptureDock, type CaptureDockProps } from './components/CaptureDock';
export { CaptureScreen, type CaptureScreenProps } from './components/CaptureScreen';
/** The editor over an existing entity. One screen for notes and containers alike. */
export { EditScreen, type EditScreenProps } from './components/EditScreen';
export { StorageGate } from './components/StorageGate';
export { UnfinishedScreen } from './components/UnfinishedScreen';
