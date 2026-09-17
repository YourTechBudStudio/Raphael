/**
 * The resources capability's public interface.
 *
 * What it publishes is notes as this app reads them - the two paged feeds, the cards and sections
 * that draw them, and the cache invalidations a write needs - plus the session-only media that has no
 * server operation yet and is kept visibly apart from all of it.
 *
 * What it does not publish is how a request or a key is built. Those are private on purpose: a
 * caller holding a key could read a page into a different cache entry, invalidate half a traversal,
 * or ask for an ordering nothing else uses and get a feed that silently disagrees with Home's.
 *
 * **There is no single-entity read here any more.** Opening a note is editing it, and the editor
 * reads through the edit owner's own Get, so a note detail query would be a second authority on what
 * one note says. Its cards still open by id; what they open is `/edit/[id]`.
 */

export { deriveNoteFeed, type NoteFeedView, type NoteQueryObservation } from './client/feed-state';
export { invalidateResources, invalidateSessionMedia } from './client/cache';
export { useNoteFeed, useNotePages, type NoteFeed } from './client/notes';
export type { NoteEntity } from './client/entity';
export { useSessionMedia } from './client/media';
export { toNoteSummaryItem, type NoteSummaryItem } from './client/summary';
export { NoteCard, type NoteCardProps } from './components/NoteCard';
export { NoteCardShell, type NoteCardShellProps } from './components/NoteCardShell';
export { NoteGrid, type NoteGridProps } from './components/NoteGrid';
export { NoteSection, type NoteSectionProps } from './components/NoteSection';
export {
  CONTAINER_NOTES_COPY,
  HOME_NOTES_COPY,
  type NoteSectionCopy,
} from './components/notes-copy';
export { SessionMediaSection } from './components/SessionMediaSection';
export { ResourceGrid, type ResourceGridItem } from './components/ResourceGrid';
