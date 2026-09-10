# Capture and media

This describes ownership and persistence boundaries, not a screen flow or upload protocol.

## Drafts and placement

Text and voice capture converge on an editable note preview; voice adds transcription before editing. The mobile app persists unsaved content, recordings, and placement choices on-device across restarts. There are no server-side draft notes. Transcription failure leaves the recording available for retry.

Core offers agent-backed parent recommendations separately from creation. The user can select or override an area/project; recommendations never silently replace a manual choice. Save requires a destination, with manual selection or container creation available when recommendations fail or find no match. There is no default inbox.

Explicit Save creates the note through ordinary core operations. Creating an area/project during capture commits independently and survives discarding the note. The stored resource is a note regardless of its capture method.

## Attachments

Core manages files separately from entity bodies. Upload and attachment linking are separate persistence steps, so retrying a note mutation need not resend its media. Saved voice notes retain their original recordings. Draft originals remain on-device until Save succeeds; expired uploads can be recreated from them.

An attachment has at most one owning entity initially. Archived owners retain their attachments. Unowned uploads and detached files are eligible for background cleanup after a bounded grace period; this does not limit local draft lifetime. Save must not claim an expired or collected attachment as successfully linked.

File identity is independent of its original filename. Preserve filename and media type so downloaded content remains usable; entity retrieval supplies attachment metadata, while content is downloaded separately.
