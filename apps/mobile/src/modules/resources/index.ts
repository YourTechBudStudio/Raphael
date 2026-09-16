/**
 * The resources capability's public interface.
 *
 * What it publishes is notes as this app reads them - the two paged feeds, one note's entity, the
 * cards and sections that draw them, and the two cache operations a write needs - plus the
 * session-only media that has no server operation yet and is kept visibly apart from all of it.
 *
 * What it does not publish is how a request or a key is built. Those are private on purpose: a
 * caller holding a key could read a page into a different cache entry, invalidate half a traversal,
 * or ask for an ordering nothing else uses and get a feed that silently disagrees with Home's. The
 * seams Phase 06 needs - seeding a created note's detail, invalidating under one activation, and the
 * typed leading-card slot on the grid - are here by name, so it never has to reach past them.
 */

export { deriveNoteFeed, type NoteFeedView, type NoteQueryObservation } from './client/feed-state';
export { invalidateResources, invalidateSessionMedia, seedNoteDetail } from './client/cache';
export type { NoteEntity } from './client/entity';
export { useNoteFeed, useNotePages, useResource, type NoteFeed } from './client/notes';
export { useSessionMedia } from './client/media';
export { toNoteSummaryItem, type NoteSummaryItem } from './client/summary';
export { NoteCard, type NoteCardProps } from './components/NoteCard';
export { NoteCardShell, type NoteCardShellProps } from './components/NoteCardShell';
export { NoteGrid, type NoteGridLeadingItem, type NoteGridProps } from './components/NoteGrid';
export { NoteSection, type NoteSectionProps } from './components/NoteSection';
export {
  CONTAINER_NOTES_COPY,
  HOME_NOTES_COPY,
  type NoteSectionCopy,
} from './components/notes-copy';
export { NoteScreen, type NoteScreenProps } from './components/NoteScreen';
export { NoteView, type NoteViewProps } from './components/NoteView';
export type { NoteUnavailableReason, NoteViewState } from './client/display';
export { NoteUnavailable } from './components/NoteUnavailable';
export { SessionMediaSection } from './components/SessionMediaSection';
export { ResourceGrid, type ResourceGridItem } from './components/ResourceGrid';
